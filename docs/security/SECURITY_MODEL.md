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
│  - Presentation Sandbox (DOMPurify HTML Sanitization)  │
│  - User-Scoped IndexedDB Isolation (`ArtixDB_v2_<hash>`)│
│  - BYOK Client Key Encryption (PBKDF2 + AES-GCM 256)   │
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
| **Cross-Site Scripting (XSS)** | Malicious Markdown containing `<script>` or `javascript:` URLs in documents. | `MarkdownPreview.tsx` filters all rendered HTML through DOMPurify with strict protocol whitelisting (`http`, `https`, `mailto`). Strips dangerous attributes and scripts. | `MarkdownPreviewXSS.test.tsx` |
| **API Key Theft from LocalStorage** | Rogue browser extension attempts to read user's third-party OpenAI or Anthropic keys. | When client encryption is enabled, keys are encrypted using AES-GCM 256-bit with PBKDF2 (100,000 iterations). Plaintext keys are never stored on disk. | `api-saving.test.ts` |
| **Cross-User Local Cache Leak** | User A logs out; User B logs in on same browser profile. | `openUserRuntime` halts User A's runtime, closes database handles, and initializes User B's isolated database namespace (`ArtixDB_v2_<hash_B>`). | `correctnessMatrix.test.ts` (Scenario H) |
| **Fake Stripe Webhooks** | Attacker sends spoofed `checkout.session.completed` POST request to elevate subscription. | Edge function verifies `stripe-signature` header using `stripe.webhooks.constructEventAsync()` and Stripe webhook signing secret. Rejects forged requests with 400 Bad Request. | `billing.test.ts` |
| **Offline Concurrency Overwrites** | Out-of-date client attempts to push old state, overwriting new work. | PostgreSQL CAS version predicate (`version = baseServerVersion`) rejects stale updates with HTTP 409 Conflict. | `concurrencyCAS.test.ts` |

---

## 3. Public Security Policy

Artix maintains a public vulnerability reporting policy in the repository root at [`SECURITY.md`](../../SECURITY.md). Security issues are investigated and triaged within 48 hours.
