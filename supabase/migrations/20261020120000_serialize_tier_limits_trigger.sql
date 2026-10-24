-- ============================================================================
-- ARTIX: Serialize Per-User Plan Tier Quota Trigger (Audit F-005)
--
-- Problem
--   `public.check_plan_tier_limit()` previously ran `SELECT COUNT(*)` under
--   PostgreSQL's default `READ COMMITTED` isolation without per-user locking.
--   Two concurrent `INSERT` transactions for the same user at `limit - 1` could
--   both observe `current_count = limit - 1` and both commit, exceeding the
--   plan tier limit. In addition, soft-deleted rows (`deleted_at IS NOT NULL`)
--   on `documents` and `system_designs` were counted against active quotas, and
--   the `SECURITY DEFINER` function lacked an explicit `SET search_path`.
--
-- Fix
--   1. Acquire a transaction-scoped per-user advisory lock
--      `pg_advisory_xact_lock(hashtextextended('artix.tier_limit:' || NEW.user_id::TEXT, 0))`
--      before reading `public.subscriptions` and counting existing rows.
--      Because `check_plan_tier_limit` fires `BEFORE INSERT` (while
--      `record_sync_change` fires `AFTER INSERT/UPDATE/DELETE`), the lock
--      hierarchy `tier_limit -> sync_changes` is strictly acyclic.
--   2. Exclude soft-deleted rows (`deleted_at IS NULL`) on `public.documents`
--      and `public.system_designs`.
--   3. Harden `SECURITY DEFINER` with `SET search_path = public` and revoke
--      direct RPC execution from `PUBLIC`, `anon`, and `authenticated`.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.check_plan_tier_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  user_plan TEXT;
  current_count INT;
BEGIN
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required for quota enforcement'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize concurrent inserts for the same user until transaction end (Audit F-005)
  PERFORM pg_advisory_xact_lock(
    hashtextextended('artix.tier_limit:' || NEW.user_id::TEXT, 0)
  );

  -- Read user's active plan tier (defaults to 'free' when no subscription row exists)
  SELECT s.plan_tier
    INTO user_plan
    FROM public.subscriptions AS s
   WHERE s.user_id = NEW.user_id;

  user_plan := COALESCE(user_plan, 'free');

  -- Pro tier has no limits on documents or system_designs, and 100 cap on projects
  IF user_plan = 'pro' THEN
    IF TG_TABLE_NAME = 'projects' THEN
      SELECT COUNT(*)
        INTO current_count
        FROM public.projects AS p
       WHERE p.user_id = NEW.user_id;

      IF current_count >= 100 THEN
        RAISE EXCEPTION 'Pro tier project limit (100) reached.';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Free Tier Limit Checks
  IF TG_TABLE_NAME = 'projects' THEN
    SELECT COUNT(*)
      INTO current_count
      FROM public.projects AS p
     WHERE p.user_id = NEW.user_id;

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
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.check_plan_tier_limit() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_plan_tier_limit() FROM anon;
REVOKE ALL ON FUNCTION public.check_plan_tier_limit() FROM authenticated;

COMMENT ON FUNCTION public.check_plan_tier_limit() IS
  'Enforces per-user Free/Pro entity quotas before INSERT using a per-user '
  'transaction advisory lock so concurrent inserts cannot race past tier limits '
  '(audit F-005).';
