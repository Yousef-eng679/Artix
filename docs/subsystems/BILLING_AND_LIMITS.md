# Stripe Billing & Resource Tier Enforcement

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `supabase/functions/`, `src/lib/plans.ts`, `src/hooks/useSubscription.ts`, `src/test/billing.test.ts`

---

## 1. Overview

Artix provides subscription tiers (`Free` and `Pro`) using Stripe integration. Resource limits are enforced both **client-side** (via React hooks and UI upgrade prompts) and **server-side** (via PostgreSQL triggers and RLS policies).

---

## 2. Subscription Tiers & Feature Matrix

Defined in `src/lib/plans.ts`:

| Resource / Capability | Free Tier | Pro Tier ($8/mo or $72/yr) |
|---|---|---|
| **Active Projects** | 3 projects | Unlimited |
| **Documents per Project**| 10 documents | Unlimited |
| **System Designs** | 3 canvases | Unlimited |
| **AI Generations** | 5 generations / month | Unlimited |
| **Storage / Sync** | Local-First + Full Cloud Sync | Local-First + Full Cloud Sync |
| **Export Formats** | Markdown, HTML, PDF, PNG, SVG | Markdown, HTML, PDF, PNG, SVG |

---

## 3. Stripe Architecture (Supabase Edge Functions)

```text
User Clicks "Upgrade to Pro"
            │
            ▼
┌────────────────────────────────────────────────────────┐
│      `create-checkout-session` Edge Function           │
│  - Verifies Supabase JWT                               │
│  - Finds or creates Stripe Customer ID                 │
│  - Generates Stripe Checkout Session URL               │
└───────────────────────────┬────────────────────────────┘
                            │ Redirect
                            ▼
┌────────────────────────────────────────────────────────┐
│               Stripe Hosted Checkout Page              │
│                 (Card / Apple Pay / GPay)              │
└───────────────────────────┬────────────────────────────┘
                            │ Webhook POST
                            ▼
┌────────────────────────────────────────────────────────┐
│            `stripe-webhook` Edge Function              │
│  - Cryptographically verifies stripe-signature header  │
│  - Idempotency check via `stripe_events` table         │
│  - Handles events:                                     │
│    * checkout.session.completed ──► plan_tier = 'pro'  │
│    * customer.subscription.updated ──► updates status  │
│    * customer.subscription.deleted ──► plan_tier='free'│
│    * invoice.payment_failed ──► status = 'past_due'    │
└───────────────────────────┬────────────────────────────┘
                            │ Service Role Update
                            ▼
┌────────────────────────────────────────────────────────┐
│             public.subscriptions Table                 │
│            (user_id, plan_tier, status)                │
└────────────────────────────────────────────────────────┘
```

---

## 4. Server-Side Database Trigger Enforcement

Even if a malicious user bypasses client UI checks, PostgreSQL enforces resource limits on insert:

In `supabase/migrations/20260723120000_enforce_tier_limits_trigger.sql`:
```sql
CREATE OR REPLACE FUNCTION public.check_user_tier_limits()
RETURNS TRIGGER AS $$
DECLARE
  v_plan_tier TEXT;
  v_count INTEGER;
BEGIN
  -- 1. Query user's active subscription tier
  SELECT plan_tier INTO v_plan_tier
  FROM public.subscriptions
  WHERE user_id = NEW.user_id AND status = 'active';

  IF v_plan_tier IS NULL THEN
    v_plan_tier := 'free';
  END IF;

  -- 2. Pro tier has no limits
  IF v_plan_tier = 'pro' THEN
    RETURN NEW;
  END IF;

  -- 3. Free tier checks
  IF TG_TABLE_NAME = 'projects' THEN
    SELECT COUNT(*) INTO v_count FROM public.projects WHERE user_id = NEW.user_id;
    IF v_count >= 3 THEN
      RAISE EXCEPTION 'Free plan limit reached: maximum 3 projects allowed';
    END IF;
  ELSIF TG_TABLE_NAME = 'documents' THEN
    SELECT COUNT(*) INTO v_count FROM public.documents WHERE project_id = NEW.project_id AND deleted_at IS NULL;
    IF v_count >= 10 THEN
      RAISE EXCEPTION 'Free plan limit reached: maximum 10 documents per project';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

---

## 5. Client-Side Limit Hooks & Upgrade Modals

- **`useSubscription` (`src/hooks/useSubscription.ts`)**: Subscribes to the user's `subscriptions` record in Supabase, caching tier state.
- **`useUsageLimits` (`src/hooks/useUsageLimits.ts`)**: Pre-checks resource counts before rendering the create button or modal.
- **`UpgradePrompt` (`src/components/UpgradePrompt.tsx`)**: Renders a dark-themed glassmorphism dialog when a user reaches a tier boundary, allowing one-click redirection to Stripe Checkout.
- **`CheckoutSuccess` (`src/pages/CheckoutSuccess.tsx`)**: Polling listener that confirms the webhook has activated the Pro tier before celebrating and redirecting back to the dashboard.
