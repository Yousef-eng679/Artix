# Environment Variables & Configuration Reference

> **Status**: `IMPLEMENTED`  
> **Target**: Post-C12 Environment Specifications

---

## 1. Client-Side Environment Variables (`.env`)

All client-facing variables are prefixed with `VITE_` and bundled into the browser bundle at build time:

| Variable Name | Required | Default / Example Value | Description |
|---|---|---|---|
| `VITE_SUPABASE_URL` | **YES** | `https://<project-ref>.supabase.co` | REST and Realtime endpoint URL for Supabase backend. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | **YES** | `eyJhbGci...` | Supabase Anon / Publishable public key. Safely public under RLS. |
| `VITE_SUPABASE_PROJECT_ID` | **YES** | `ldhbjeustealybjffadn` | Supabase unique project reference identifier. |
| `VITE_STRIPE_PUBLISHABLE_KEY` | OPTIONAL| `pk_test_...` | Stripe public publishable key for client checkout redirect. |

---

## 2. Server-Side Edge Function Secrets (Supabase Vault)

Configured securely within the Supabase dashboard and accessed exclusively inside Deno Edge Functions (`supabase/functions/`):

| Variable Name | Required | Description |
|---|---|---|
| `STRIPE_SECRET_KEY` | **YES** | Stripe secret API key (`sk_live_...` or `sk_test_...`) used to create checkout sessions and portal sessions. |
| `STRIPE_WEBHOOK_SECRET` | **YES** | Cryptographic webhook signing secret (`whsec_...`) used to verify incoming events from Stripe. |
| `SUPABASE_URL` | **YES** | Internal Supabase project URL injected automatically by Deno runtime. |
| `SUPABASE_SERVICE_ROLE_KEY` | **YES** | Privileged database key used strictly within webhooks to update `public.subscriptions` bypassing RLS. |

> **Security Invariant**: `SUPABASE_SERVICE_ROLE_KEY` and `STRIPE_SECRET_KEY` must **NEVER** appear in any client-side file under `src/` or any `.env` file bundled with Vite. Verified by `src/test/security.test.ts`.
