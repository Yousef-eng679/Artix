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
│  - Stripe Webhook Cryptographic Signature Validation   │
│  - Rate Limiting on Supabase Edge Functions            │
└───────────────────────────┬────────────────────────────┘
                            │ Service Role / Authenticated Role
                            ▼
┌────────────────────────────────────────────────────────┐
│                 DATABASE TRUST BOUNDARY                │
│                                                        │
│  - PostgreSQL Row Level Security (RLS) (`auth.uid()`)  │
│  - Trigger-Based Resource Limit Enforcement            │
│  - Cascade Foreign Key Constraints                     │
└────────────────────────────────────────────────────────┘
```

---

## 2. Threat Modeling & Mitigations

| Threat | Attack Vector | Artix Mitigation | Verification Test |
|---|---|---|---|
| **Cross-Tenant Data Read** | Attacker queries Supabase REST API directly with forged user IDs. | PostgreSQL Row Level Security (RLS) automatically checks `auth.uid() = user_id` for every query. Rejects cross-tenant access at the database kernel level. | `security.test.ts` |
| **Cross-Site Scripting (XSS)** | Malicious Markdown containing `<script>` or `javascript:` URLs in documents. | `MarkdownPreview.tsx` renders via `react-markdown` without `rehype-raw` (escaping raw HTML as text) and filters URLs through `sanitizeMarkdownUrl` (`http:`, `https:`, `mailto:`, relative links). | `security.test.ts` |
| **API Key Theft at Rest** | Offline inspection of `localStorage` for user's third-party AI keys. | Default storage uses `obf:` Base64 obfuscation (casual-inspection guard only); enabling the optional passphrase vault encrypts keys at rest with AES-GCM 256-bit + PBKDF2 (250,000 iterations). | `api-saving.test.ts`, `security.test.ts` |
| **Cross-User Local Cache Leak** | User A logs out; User B logs in on same browser profile. | `openUserRuntime` halts User A's runtime, closes database handles, and initializes User B's isolated database namespace (`ArtixDB_v2_<hash_B>`). | `correctnessMatrix.test.ts` (Scenario H) |
| **Fake Webhooks / Price Tampering** | Attacker spoofs webhook or submits unauthorized `priceId` to checkout. | `create-checkout-session` enforces a server-owned Stripe price allowlist; `stripe-webhook` verifies `Stripe-Signature` and validates purchased price ID, interval, and status before granting `pro`. | `billing.test.ts` |
| **Offline Concurrency Overwrites** | Out-of-date client attempts to push old state, overwriting new work. | PostgreSQL CAS version predicate (`version = baseServerVersion`) rejects stale updates with HTTP 409 Conflict. | `concurrencyCAS.test.ts` |

---

## 3. Public Security Policy

Artix maintains a public vulnerability reporting policy in the repository root at [`SECURITY.md`](../../SECURITY.md). Security issues are investigated and triaged within 48 hours.
