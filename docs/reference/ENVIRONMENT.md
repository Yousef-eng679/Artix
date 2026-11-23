# Environment Variables & Configuration Reference

> **Status**: `IMPLEMENTED`  
> **Target**: Productionized Environment Specifications (`v2.5.0`)

---

## 1. Client-Side Environment Variables (`.env` / `.env.local`)

All client-facing variables are prefixed with `VITE_` and embedded at build time (matching `.env.example`):

| Variable Name | Required | Default / Example Value | Description |
|---|---|---|---|
| `VITE_SUPABASE_URL` | **YES** | `https://<project-ref>.supabase.co` | REST, RPC, Edge Function, and Realtime endpoint URL for Supabase backend. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | **YES** | `eyJhbGci...` | Supabase Anon / Publishable public key. Safely public under PostgreSQL RLS. |

*(For Layer 3 PostgreSQL concurrency/RLS testing via `npm run test:pg`, an optional Node-only `DATABASE_URL` environment variable connects `src/test/postgres/backendConcurrencyAndRls.pg.test.ts` to a live PostgreSQL 17 instance such as CI's `postgres:17-alpine`; when unset, the suite automatically runs against in-process `@electric-sql/pglite`.)*

---

## 2. Server-Side Edge Function Secrets (Supabase Vault)

Configured securely within the Supabase project secrets and accessed exclusively inside Deno Edge Functions (`supabase/functions/`):

| Variable Name | Required | Description |
|---|---|---|
| `STRIPE_SECRET_KEY` | **YES** | Stripe secret API key (`sk_live_...` or `sk_test_...`) used by `create-checkout-session`, `create-portal-session`, and `stripe-webhook` (`stripe.subscriptions.retrieve`). |
| `STRIPE_WEBHOOK_SECRET` | **YES** | Cryptographic webhook signing secret (`whsec_...`) used by `stripe-webhook` to verify `Stripe-Signature`. |
| `SUPABASE_URL` | **YES** | Internal Supabase project URL injected automatically by the Supabase Edge runtime. |
| `SUPABASE_ANON_KEY` | **YES** | Injected automatically by the Supabase Edge runtime; used by `create-checkout-session` and `create-portal-session` to verify caller JWTs. |
| `SUPABASE_SERVICE_ROLE_KEY` | **YES** | Privileged service-role key used inside Edge Functions to invoke `public.reconcile_stripe_subscription` and manage customer records. |
| `STRIPE_PRO_MONTHLY_PRICE_ID` | OPTIONAL | Override for the approved monthly Pro Stripe Price ID in `_shared/billingPolicy.ts` (defaults to `price_1Tw4QxFhYsZG2pP7gamnWTX6`, \$8/mo). |
| `STRIPE_PRO_ANNUAL_PRICE_ID` | OPTIONAL | Override for the approved annual Pro Stripe Price ID in `_shared/billingPolicy.ts` (defaults to `price_1Tw4RxFhYsZG2pP7MBbos4He`, \$72/yr). |

> **Security Invariant**: `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` must **NEVER** appear in any client-side file under `src/` or any `.env` file bundled with Vite. Verified by `src/test/security.test.ts`.
