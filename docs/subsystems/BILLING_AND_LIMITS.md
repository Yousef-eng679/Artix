# Stripe Billing & Resource Tier Enforcement

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `supabase/functions/`, `supabase/functions/_shared/billingPolicy.ts`, `supabase/migrations/20261101100300_atomic_billing_reconciliation_and_manual_grants.sql`, `src/lib/plans.ts`, `src/hooks/useSubscription.tsx`, `src/hooks/useUsageLimits.tsx`, `src/test/billing.test.ts`, `src/test/billing/stripeWebhookAndEntitlementPolicy.test.tsx`, `src/test/billing/offlineEntitlementAndQuota.test.tsx`

---

## 1. Overview

Artix provides subscription tiers (`Free` and `Pro`) using Stripe integration and RLS-protected administrative overrides (`public.manual_grants`). Resource limits are enforced both **client-side** (online via Supabase count queries and offline via local Dexie repository counts and cached entitlements in `ArtixDB.database_meta`) and **server-side** (via the serialized PostgreSQL trigger `public.check_plan_tier_limit()`).

---

## 2. Subscription Tiers & Feature Matrix

Defined in `src/lib/plans.ts` (`GRACE_PERIOD_DAYS = 0`):

| Resource / Capability | Free Tier | Pro Tier (\$8/mo or \$72/yr — 2 months free) |
|---|---|---|
| **Active Projects** | 3 projects (`deleted_at IS NULL`) | 100 projects (abuse cap) |
| **Total Active Documents** | 10 documents across all projects | Unlimited |
| **Total Active System Designs** | 3 canvases across all projects | Unlimited |
| **AI Generations** | 5 generations / UTC calendar month | Unlimited |
| **Storage / Sync** | Local-First + Full Cloud Sync | Local-First + Full Cloud Sync |
| **Document Export Formats** | Native (`.md`, `.xml`, `.txt`) | Native + Styled `.html` & Print-ready `.pdf` |

---

## 3. Stripe Architecture & Atomic Webhook Reconciliation (`supabase/functions/`)

```text
User Clicks "Upgrade to Pro"
            │
            ▼
┌────────────────────────────────────────────────────────┐
│      `create-checkout-session` Edge Function           │
│  - Verifies Supabase JWT & `isOriginAllowed(origin)`   │
│  - Validates `priceId` / `billingCycle` against        │
│    server allowlist (`resolveAllowedCheckoutPrice`)    │
│  - Finds or creates Stripe Customer ID                 │
│  - Generates Stripe Checkout Session URL               │
└───────────────────────────┬────────────────────────────┘
                            │ Redirect
                            ▼
┌────────────────────────────────────────────────────────┐
│               Stripe Hosted Checkout Page              │
└───────────────────────────┬────────────────────────────┘
                            │ Webhook POST
                            ▼
┌────────────────────────────────────────────────────────┐
│            `stripe-webhook` Edge Function              │
│  - Verifies `Stripe-Signature` (`constructEventAsync`) │
│  - Handles 7 events (`checkout.session.completed`,     │
│    `customer.subscription.created/updated/deleted`,    │
│    `invoice.paid`, `invoice.payment_succeeded/failed`) │
│  - Calls live `stripe.subscriptions.retrieve(subId)`   │
│  - Evaluates `validateSubscriptionEntitlement()`       │
│    (strict fail-closed: only `active`/`trialing` with  │
│     allowlisted Pro price grant `'pro'`; `past_due`    │
│     immediately downgrades `plan_tier` to `'free'`)    │
└───────────────────────────┬────────────────────────────┘
                            │ Single-Transaction RPC
                            ▼
┌────────────────────────────────────────────────────────┐
│     `public.reconcile_stripe_subscription(...)`        │
│  - `pg_advisory_xact_lock('artix.billing:' || subject)`│
│  - Checks/inserts `public.stripe_events` inside lock   │
│  - Fences stale events via `last_stripe_event_created` │
│  - Upserts `public.subscriptions` + increments         │
│    `reconciliation_version` in ONE PostgreSQL tx       │
└────────────────────────────────────────────────────────┘
```

### Non-Stripe Administrative Overrides (`public.manual_grants`)
Non-Stripe administrative Pro grants are stored in `public.manual_grants` (`user_id UNIQUE`, `plan_tier`, `reason`, `granted_by`, `starts_at`, `expires_at`, `revoked_at`). Users can `SELECT` only their own grant row under RLS, while writes are restricted exclusively to `service_role`. Both `public.user_has_active_pro_entitlement(p_user_id)` in PostgreSQL and `useSubscription.tsx` on the client evaluate active `manual_grants` alongside `public.subscriptions`.

---

## 4. Server-Side Database Trigger Enforcement (`check_plan_tier_limit`)

Defined in `supabase/migrations/20261101100300_atomic_billing_reconciliation_and_manual_grants.sql`:

```sql
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
  -- Serialize concurrent inserts for the same user until transaction end (Audit F-005)
  PERFORM pg_advisory_xact_lock(
    hashtextextended('artix.tier_limit:' || NEW.user_id::TEXT, 0)
  );

  v_is_pro := public.user_has_active_pro_entitlement(NEW.user_id);

  -- Pro tier: 100 active projects cap; unlimited documents, designs, and AI generations
  IF v_is_pro THEN
    IF TG_TABLE_NAME = 'projects' THEN
      SELECT COUNT(*) INTO current_count
        FROM public.projects AS p
       WHERE p.user_id = NEW.user_id AND p.deleted_at IS NULL;
      IF current_count >= 100 THEN
        RAISE EXCEPTION 'Pro tier project limit (100) reached.';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Free tier limits (also enforced when subscription status is past_due / canceled)
  IF TG_TABLE_NAME = 'projects' THEN
    SELECT COUNT(*) INTO current_count
      FROM public.projects AS p
     WHERE p.user_id = NEW.user_id AND p.deleted_at IS NULL;
    IF current_count >= 3 THEN
      RAISE EXCEPTION 'Free tier project limit (3) reached. Upgrade to Pro for more.';
    END IF;
  ELSIF TG_TABLE_NAME = 'documents' THEN
    SELECT COUNT(*) INTO current_count
      FROM public.documents AS d
     WHERE d.user_id = NEW.user_id AND d.deleted_at IS NULL;
    IF current_count >= 10 THEN
      RAISE EXCEPTION 'Free tier document limit (10) reached. Upgrade to Pro for unlimited documents.';
    END IF;
  ELSIF TG_TABLE_NAME = 'system_designs' THEN
    SELECT COUNT(*) INTO current_count
      FROM public.system_designs AS sd
     WHERE sd.user_id = NEW.user_id AND sd.deleted_at IS NULL;
    IF current_count >= 3 THEN
      RAISE EXCEPTION 'Free tier system design limit (3) reached. Upgrade to Pro for unlimited designs.';
    END IF;
  ELSIF TG_TABLE_NAME IN ('prd_generations', 'vibe_generations', 'agentic_workflows') THEN
    v_month_start := date_trunc('month', now());
    SELECT
      (SELECT COUNT(*) FROM public.prd_generations WHERE user_id = NEW.user_id AND created_at >= v_month_start) +
      (SELECT COUNT(*) FROM public.vibe_generations WHERE user_id = NEW.user_id AND created_at >= v_month_start) +
      (SELECT COUNT(*) FROM public.agentic_workflows WHERE user_id = NEW.user_id AND created_at >= v_month_start)
      INTO current_count;
    IF current_count >= 5 THEN
      RAISE EXCEPTION 'Free tier monthly AI generation limit (5) reached. Upgrade to Pro for unlimited AI generations.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
```

---

## 5. Client-Side Limit Hooks, Offline Caching & Upgrade UX

- **`useSubscription` (`src/hooks/useSubscription.tsx`)**: Queries `public.subscriptions` and `public.manual_grants` when online (`networkMode: 'always'`), persists the resolved entitlement snapshot to `ArtixDB.database_meta` under `key = 'cached_subscription'`, and serves the cached Pro entitlement offline while failing closed if `currentPeriodEnd` or `manual_grants.expires_at` has elapsed.
- **`useUsageLimits` (`src/hooks/useUsageLimits.tsx`)**: Counts active `projects`, `documents`, and `system_designs` from local Dexie repositories when offline (and caches monthly AI generation usage in `database_meta['cached_ai_generations']`), ensuring offline Free-tier users see accurate remaining quotas and cannot bypass limits locally.
- **`SyncEngine` & `SyncStatusBanner` (`src/components/SyncStatusBanner.tsx`)**: If an offline-created entity exceeds the server quota upon reconnection, `classifySyncError` maps the `check_plan_tier_limit()` rejection to non-retryable `TIER_LIMIT_EXCEEDED`, parking the outbox entry in `blocked` and displaying an **Upgrade to Pro** + **Retry Blocked** action banner.
- **`UpgradePrompt` (`src/components/UpgradePrompt.tsx`) & `CheckoutSuccess` (`src/pages/CheckoutSuccess.tsx`)**: Trigger server-validated Stripe Checkout sessions and confirm Pro activation upon return.
