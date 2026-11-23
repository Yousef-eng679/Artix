-- ============================================================================
-- ARTIX: Atomic Stripe Billing Reconciliation, Strict Fail-Closed Entitlement
--        & RLS-Protected manual_grants (TASK-04, TASK-05, TASK-23 / B-01..B-03)
--
-- Prepared in repository ONLY per Operating Rule 4 — do NOT auto-apply to live
-- Supabase; apply on staging first, then production before/with stripe-webhook.
--
-- Key Guarantees:
--   1. Adds `reconciliation_version` and `last_stripe_event_created` onto
--      `public.subscriptions` and normalizes any non-active Stripe subscription
--      rows to `plan_tier = 'free'` (strict fail-closed policy, Decision A1).
--   2. Introduces `public.manual_grants` (RLS-protected: users can SELECT only
--      their own row; writes restricted to `service_role`) to replace legacy
--      email-hardcoded admin grants without rewriting git history (TASK-23).
--   3. Provides `public.reconcile_stripe_subscription(...)` which serializes
--      concurrent webhooks per user/subscription via `pg_advisory_xact_lock`,
--      deduplicates `public.stripe_events` inside the lock, enforces monotonic
--      event ordering + fail-closed entitlement, and commits `subscriptions` +
--      `stripe_events` atomically in a single transaction (B-01).
--   4. Aligns `public.check_plan_tier_limit()` with `s.plan_tier = 'pro' AND
--      s.status = 'active'` OR active `public.manual_grants`, excludes
--      soft-deleted `projects` (`p.deleted_at IS NULL`), and enforces Free-tier
--      monthly AI generation quotas across `prd_generations`,
--      `vibe_generations`, and `agentic_workflows` (B-02, B-03, F-005).
-- ============================================================================

-- 1. Extend `public.subscriptions` with monotonic reconciliation metadata
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS reconciliation_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_stripe_event_created BIGINT;

-- 2. Create `public.manual_grants` for non-Stripe administrative Pro overrides (TASK-23)
CREATE TABLE IF NOT EXISTS public.manual_grants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_tier   TEXT NOT NULL DEFAULT 'pro'
                CHECK (plan_tier IN ('free', 'pro')),
  reason      TEXT NOT NULL DEFAULT '',
  granted_by  TEXT NOT NULL DEFAULT 'service_role',
  starts_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT manual_grants_user_id_unique UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_manual_grants_user_id
  ON public.manual_grants(user_id);

DROP TRIGGER IF EXISTS update_manual_grants_updated_at ON public.manual_grants;
CREATE TRIGGER update_manual_grants_updated_at
  BEFORE UPDATE ON public.manual_grants
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.manual_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own manual grant" ON public.manual_grants;
CREATE POLICY "Users can view own manual grant"
  ON public.manual_grants
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON public.manual_grants FROM PUBLIC;
REVOKE ALL ON public.manual_grants FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.manual_grants FROM authenticated;
GRANT SELECT ON public.manual_grants TO authenticated;
GRANT ALL ON public.manual_grants TO service_role;

-- Idempotently migrate any existing non-Stripe manual Pro rows from `subscriptions`
-- into `manual_grants` without referencing any personal email address (TASK-23).
INSERT INTO public.manual_grants (user_id, plan_tier, reason, granted_by, starts_at, expires_at)
SELECT
  s.user_id,
  'pro',
  'Migrated legacy non-Stripe Pro entitlement',
  'migration_20261101100300',
  s.created_at,
  s.current_period_end
FROM public.subscriptions AS s
WHERE s.stripe_subscription_id IS NULL
  AND s.plan_tier = 'pro'
  AND s.status = 'active'
ON CONFLICT (user_id) DO NOTHING;

-- Enforce Decision A1 fail-closed invariant on existing Stripe-backed rows:
-- any non-active subscription (`past_due`, `canceled`, `incomplete`) drops `plan_tier` to `'free'`.
UPDATE public.subscriptions
   SET plan_tier = 'free',
       updated_at = now()
 WHERE status <> 'active'
   AND plan_tier <> 'free';

-- 3. Authoritative entitlement predicate shared by SQL triggers & policies
CREATE OR REPLACE FUNCTION public.user_has_active_pro_entitlement(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1
        FROM public.subscriptions AS s
       WHERE s.user_id = p_user_id
         AND s.plan_tier = 'pro'
         AND s.status = 'active'
    )
    OR EXISTS (
      SELECT 1
        FROM public.manual_grants AS mg
       WHERE mg.user_id = p_user_id
         AND mg.plan_tier = 'pro'
         AND mg.revoked_at IS NULL
         AND mg.starts_at <= now()
         AND (mg.expires_at IS NULL OR mg.expires_at > now())
    );
$$;

REVOKE ALL ON FUNCTION public.user_has_active_pro_entitlement(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.user_has_active_pro_entitlement(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.user_has_active_pro_entitlement(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.user_has_active_pro_entitlement(UUID) TO service_role;

-- 4. Atomic Stripe webhook reconciliation RPC (`subscriptions` + `stripe_events` in 1 tx)
CREATE OR REPLACE FUNCTION public.reconcile_stripe_subscription(
  p_stripe_event_id         TEXT,
  p_event_type              TEXT,
  p_event_created           BIGINT DEFAULT NULL,
  p_user_id                 UUID DEFAULT NULL,
  p_stripe_customer_id      TEXT DEFAULT NULL,
  p_stripe_subscription_id  TEXT DEFAULT NULL,
  p_plan_tier               TEXT DEFAULT 'free',
  p_status                  TEXT DEFAULT 'incomplete',
  p_billing_cycle           TEXT DEFAULT NULL,
  p_current_period_end      TIMESTAMPTZ DEFAULT NULL,
  p_is_live_snapshot        BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id           UUID;
  v_lock_subject      TEXT;
  v_existing          public.subscriptions%ROWTYPE;
  v_has_existing      BOOLEAN := FALSE;
  v_effective_plan    TEXT;
  v_next_version      BIGINT;
  v_next_last_created BIGINT;
BEGIN
  IF p_stripe_event_id IS NULL OR btrim(p_stripe_event_id) = '' THEN
    RAISE EXCEPTION 'p_stripe_event_id is required'
      USING ERRCODE = '22023';
  END IF;

  IF p_event_type IS NULL OR btrim(p_event_type) = '' THEN
    RAISE EXCEPTION 'p_event_type is required'
      USING ERRCODE = '22023';
  END IF;

  IF p_status NOT IN ('active', 'past_due', 'canceled', 'incomplete') THEN
    RAISE EXCEPTION 'Invalid subscription status: %', p_status
      USING ERRCODE = '22023';
  END IF;

  IF p_plan_tier NOT IN ('free', 'pro') THEN
    RAISE EXCEPTION 'Invalid plan_tier: %', p_plan_tier
      USING ERRCODE = '22023';
  END IF;

  -- Resolve target user_id from explicit metadata or existing subscription linkage
  v_user_id := p_user_id;

  IF v_user_id IS NULL AND p_stripe_subscription_id IS NOT NULL THEN
    SELECT s.user_id
      INTO v_user_id
      FROM public.subscriptions AS s
     WHERE s.stripe_subscription_id = p_stripe_subscription_id
     LIMIT 1;
  END IF;

  IF v_user_id IS NULL AND p_stripe_customer_id IS NOT NULL THEN
    SELECT s.user_id
      INTO v_user_id
      FROM public.subscriptions AS s
     WHERE s.stripe_customer_id = p_stripe_customer_id
     LIMIT 1;
  END IF;

  -- Serialize all concurrent webhook deliveries for the same user/subscription/event
  v_lock_subject := COALESCE(
    v_user_id::TEXT,
    p_stripe_subscription_id,
    p_stripe_customer_id,
    p_stripe_event_id
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('artix.billing:' || v_lock_subject, 0)
  );

  -- Check idempotency ledger INSIDE the advisory lock
  IF EXISTS (
    SELECT 1
      FROM public.stripe_events AS se
     WHERE se.stripe_event_id = p_stripe_event_id
  ) THEN
    RETURN jsonb_build_object(
      'outcome', 'duplicate_event',
      'stripe_event_id', p_stripe_event_id
    );
  END IF;

  -- If no user could be linked (e.g. unlinked external test customer), record event safely
  IF v_user_id IS NULL THEN
    INSERT INTO public.stripe_events (stripe_event_id, event_type)
    VALUES (p_stripe_event_id, p_event_type);

    RETURN jsonb_build_object(
      'outcome', 'ignored_unlinked',
      'stripe_event_id', p_stripe_event_id
    );
  END IF;

  SELECT *
    INTO v_existing
    FROM public.subscriptions AS s
   WHERE s.user_id = v_user_id
   FOR UPDATE;

  v_has_existing := FOUND;

  -- Guard non-live payload snapshots against out-of-order timestamp regression
  IF NOT COALESCE(p_is_live_snapshot, TRUE)
     AND v_has_existing
     AND v_existing.last_stripe_event_created IS NOT NULL
     AND p_event_created IS NOT NULL
     AND p_event_created < v_existing.last_stripe_event_created
  THEN
    INSERT INTO public.stripe_events (stripe_event_id, event_type)
    VALUES (p_stripe_event_id, p_event_type);

    RETURN jsonb_build_object(
      'outcome', 'stale_event_ignored',
      'user_id', v_user_id,
      'reconciliation_version', v_existing.reconciliation_version
    );
  END IF;

  -- Strict fail-closed policy (Decision A1): ONLY `status = 'active'` can hold `plan_tier = 'pro'`
  v_effective_plan := CASE
    WHEN p_plan_tier = 'pro' AND p_status = 'active' THEN 'pro'
    ELSE 'free'
  END;

  v_next_version := COALESCE(v_existing.reconciliation_version, 0) + 1;
  v_next_last_created := CASE
    WHEN p_event_created IS NULL THEN v_existing.last_stripe_event_created
    ELSE GREATEST(COALESCE(v_existing.last_stripe_event_created, 0), p_event_created)
  END;

  INSERT INTO public.subscriptions (
    user_id,
    stripe_customer_id,
    stripe_subscription_id,
    plan_tier,
    status,
    billing_cycle,
    current_period_end,
    reconciliation_version,
    last_stripe_event_created
  )
  VALUES (
    v_user_id,
    p_stripe_customer_id,
    p_stripe_subscription_id,
    v_effective_plan,
    p_status,
    p_billing_cycle,
    p_current_period_end,
    v_next_version,
    v_next_last_created
  )
  ON CONFLICT (user_id) DO UPDATE
     SET stripe_customer_id        = COALESCE(EXCLUDED.stripe_customer_id, public.subscriptions.stripe_customer_id),
         stripe_subscription_id    = COALESCE(EXCLUDED.stripe_subscription_id, public.subscriptions.stripe_subscription_id),
         plan_tier                 = EXCLUDED.plan_tier,
         status                    = EXCLUDED.status,
         billing_cycle             = COALESCE(EXCLUDED.billing_cycle, public.subscriptions.billing_cycle),
         current_period_end        = COALESCE(EXCLUDED.current_period_end, public.subscriptions.current_period_end),
         reconciliation_version    = EXCLUDED.reconciliation_version,
         last_stripe_event_created = EXCLUDED.last_stripe_event_created,
         updated_at                = now();

  INSERT INTO public.stripe_events (stripe_event_id, event_type)
  VALUES (p_stripe_event_id, p_event_type);

  RETURN jsonb_build_object(
    'outcome', 'applied',
    'user_id', v_user_id,
    'plan_tier', v_effective_plan,
    'status', p_status,
    'reconciliation_version', v_next_version
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_stripe_subscription(
  TEXT, TEXT, BIGINT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_stripe_subscription(
  TEXT, TEXT, BIGINT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN
) FROM anon;
REVOKE ALL ON FUNCTION public.reconcile_stripe_subscription(
  TEXT, TEXT, BIGINT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_stripe_subscription(
  TEXT, TEXT, BIGINT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN
) TO service_role;

-- 5. Align `public.check_plan_tier_limit()` with active status, manual_grants,
--    soft-deleted `projects`, and monthly AI generation quotas
CREATE OR REPLACE FUNCTION public.check_plan_tier_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_pro      BOOLEAN;
  current_count INT;
  v_month_start TIMESTAMPTZ;
BEGIN
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required for quota enforcement'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize concurrent inserts for the same user until transaction end (Audit F-005)
  PERFORM pg_advisory_xact_lock(
    hashtextextended('artix.tier_limit:' || NEW.user_id::TEXT, 0)
  );

  v_is_pro := public.user_has_active_pro_entitlement(NEW.user_id);

  -- Pro tier: unlimited documents, system_designs, and AI generations; 100 active projects cap
  IF v_is_pro THEN
    IF TG_TABLE_NAME = 'projects' THEN
      SELECT COUNT(*)
        INTO current_count
        FROM public.projects AS p
       WHERE p.user_id = NEW.user_id
         AND p.deleted_at IS NULL;

      IF current_count >= 100 THEN
        RAISE EXCEPTION 'Pro tier project limit (100) reached.';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Free Tier Limit Checks (strict fail-closed when past_due / canceled / free)
  IF TG_TABLE_NAME = 'projects' THEN
    SELECT COUNT(*)
      INTO current_count
      FROM public.projects AS p
     WHERE p.user_id = NEW.user_id
       AND p.deleted_at IS NULL;

    IF current_count >= 3 THEN
      RAISE EXCEPTION 'Free tier project limit (3) reached. Upgrade to Pro for more.';
    END IF;
  ELSIF TG_TABLE_NAME = 'documents' THEN
    SELECT COUNT(*)
      INTO current_count
      FROM public.documents AS d
     WHERE d.user_id = NEW.user_id
       AND d.deleted_at IS NULL;

    IF current_count >= 10 THEN
      RAISE EXCEPTION 'Free tier document limit (10) reached. Upgrade to Pro for unlimited documents.';
    END IF;
  ELSIF TG_TABLE_NAME = 'system_designs' THEN
    SELECT COUNT(*)
      INTO current_count
      FROM public.system_designs AS sd
     WHERE sd.user_id = NEW.user_id
       AND sd.deleted_at IS NULL;

    IF current_count >= 3 THEN
      RAISE EXCEPTION 'Free tier system design limit (3) reached. Upgrade to Pro for unlimited designs.';
    END IF;
  ELSIF TG_TABLE_NAME IN ('prd_generations', 'vibe_generations', 'agentic_workflows') THEN
    v_month_start := date_trunc('month', now());

    SELECT
      (SELECT COUNT(*) FROM public.prd_generations AS pg WHERE pg.user_id = NEW.user_id AND pg.created_at >= v_month_start) +
      (SELECT COUNT(*) FROM public.vibe_generations AS vg WHERE vg.user_id = NEW.user_id AND vg.created_at >= v_month_start) +
      (SELECT COUNT(*) FROM public.agentic_workflows AS aw WHERE aw.user_id = NEW.user_id AND aw.created_at >= v_month_start)
      INTO current_count;

    IF current_count >= 5 THEN
      RAISE EXCEPTION 'Free tier monthly AI generation limit (5) reached. Upgrade to Pro for unlimited AI generations.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.check_plan_tier_limit() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_plan_tier_limit() FROM anon;
REVOKE ALL ON FUNCTION public.check_plan_tier_limit() FROM authenticated;

DROP TRIGGER IF EXISTS trigger_enforce_prd_generation_limit ON public.prd_generations;
CREATE TRIGGER trigger_enforce_prd_generation_limit
  BEFORE INSERT ON public.prd_generations
  FOR EACH ROW EXECUTE FUNCTION public.check_plan_tier_limit();

DROP TRIGGER IF EXISTS trigger_enforce_vibe_generation_limit ON public.vibe_generations;
CREATE TRIGGER trigger_enforce_vibe_generation_limit
  BEFORE INSERT ON public.vibe_generations
  FOR EACH ROW EXECUTE FUNCTION public.check_plan_tier_limit();

DROP TRIGGER IF EXISTS trigger_enforce_agentic_workflow_limit ON public.agentic_workflows;
CREATE TRIGGER trigger_enforce_agentic_workflow_limit
  BEFORE INSERT ON public.agentic_workflows
  FOR EACH ROW EXECUTE FUNCTION public.check_plan_tier_limit();
