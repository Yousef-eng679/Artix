# Artix Security Model & Threat Analysis

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `supabase/migrations/`, `src/lib/ai/crypto.ts`, `src/test/security.test.ts`

---

## 1. Overview & Trust Boundaries

Artix enforces a defense-in-depth security model across four distinct trust boundaries:

```text
┌────────────────────────────────────────────────────────┐
│                   BROWSER / CLIENT TRUST               │
│                                                        │
│  - Markdown AST Escaping + Safe URI Protocol Allowlist │
│  - User-Scoped IndexedDB Isolation (`ArtixDB_v2_<hash>`)│
│  - BYOK Keys (`obf:` Default / Opt-In AES-GCM-256)     │
└───────────────────────────┬────────────────────────────┘
                            │ HTTPS / TLS 1.3 + JWT Bearer
                            ▼
┌────────────────────────────────────────────────────────┐
│                   NETWORK / API GATEWAY                │
│                                                        │
│  - Content Security Policy (CSP Headers)               │
│  - Stripe Webhook Signature & Live Subscription Check  │
│  - Origin Whitelist (`isOriginAllowed` in `cors.ts`)   │
└───────────────────────────┬────────────────────────────┘
                            │ Service Role / Authenticated Role
                            ▼
┌────────────────────────────────────────────────────────┐
│                 DATABASE TRUST BOUNDARY                │
│                                                        │
│  - PostgreSQL Row Level Security (RLS) (`auth.uid()`)  │
│  - Atomic CAS (`apply_sync_mutation` `p_base_version`) │
│  - Serialized Quota Trigger (`check_plan_tier_limit`)  │
│  - Atomic Billing RPC (`reconcile_stripe_subscription`)│
└────────────────────────────────────────────────────────┘
```

---

## 2. Threat Modeling & Mitigations

| Threat | Attack Vector | Artix Mitigation | Verification Test |
|---|---|---|---|
| **Cross-Tenant Data Read** | Attacker queries Supabase REST API directly with forged user IDs. | PostgreSQL Row Level Security (RLS) automatically checks `auth.uid() = user_id` for every query. Rejects cross-tenant access at the database kernel level. | `security.test.ts` |
| **Cross-Site Scripting (XSS)** | Malicious Markdown containing `<script>` or `javascript:` URLs in documents. | `MarkdownPreview.tsx` renders via `react-markdown` without `rehype-raw` (escaping raw HTML as text) and filters URLs through `sanitizeMarkdownUrl` (`http:`, `https:`, `mailto:`, relative links). | `security.test.ts` |
| **API Key Theft at Rest** | Offline inspection of `localStorage` for user's third-party AI keys. | Default storage uses `obf:` Base64 obfuscation (casual-inspection guard only); enabling the optional passphrase vault encrypts keys at rest with AES-GCM 256-bit + PBKDF2 (600,000 iterations v:2; legacy v:1 250,000). | `api-saving.test.ts`, `security.test.ts` |
| **Cross-User Local Cache Leak** | User A logs out; User B logs in on same browser profile. | `closeUserRuntime` halts User A's runtime, evicts `TabCoordinator` and `SyncEngine`, closes `ArtixDB_v2_<hash_A>`, clears `QueryClient` and `dirtyTracker`, purges legacy caches (`clearSensitiveBrowserCaches`), and partitions `localStorage` draft/tab keys by user hash. | `correctnessMatrix.test.ts` (Scenario H), `multiAccountEvictionAndStorageScope.test.tsx` |
| **Fake Webhooks / Price Tampering / Out-of-Order Events** | Attacker spoofs webhook, submits unauthorized `priceId`, or replays stale webhook events. | `create-checkout-session` enforces a server-owned Stripe price allowlist; `stripe-webhook` verifies `Stripe-Signature`, retrieves the live subscription from Stripe, enforces strict fail-closed `past_due -> free` (`GRACE_PERIOD_DAYS = 0`), and executes the advisory-locked `reconcile_stripe_subscription` RPC (`subscriptions` + `stripe_events` in 1 transaction). | `billing.test.ts`, `stripeWebhookAndEntitlementPolicy.test.tsx`, `backendConcurrencyAndRls.pg.test.ts` |
| **Offline Concurrency Overwrites** | Out-of-date client attempts to push old state or null baseline, overwriting new work. | `apply_sync_mutation` enforces strict CAS (`p_base_version >= 1` and `version = p_base_version`) across all 4 synced tables (`projects`, `documents`, `system_designs`, `workspace_folders`), while open editors enforce `expectedLocalRevision` (`StaleBufferError`). | `concurrencyCAS.test.ts`, `staleBufferProtection.test.tsx`, `backendConcurrencyAndRls.pg.test.ts` |
| **Expired Offline JWT Lockout** | User boots offline after cached JWT `exp` has elapsed. | `recoverOfflineSessionFromStorage()` unlocks only local `ArtixDB_v2_<hash>` with `isCloudSyncPaused = true` (never spoofing cloud calls) and surfaces a non-destructive re-auth banner if online token refresh fails with a fatal `4xx`. | `expiredTokenOfflineBoot.test.tsx` |

---

## 3. Public Security Policy

Artix maintains a public vulnerability reporting policy in the repository root at [`SECURITY.md`](../../SECURITY.md). Security issues are investigated and triaged within 48 hours.
