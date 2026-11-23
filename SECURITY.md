# Security Policy & Threat Model — Artix

> **Documentation Version**: v2.5.0 — Productionized Billing, Strict CAS & True Offline-First Architecture

This document details the security architecture, data isolation guarantees, threat model, and cryptographic implementations of the Artix platform.

---

## 1. Data Model & Storage Boundaries

Artix operates with a strict partition between two categories of user data:

| Data Category | Examples | Storage Location | Custody & Access |
|:---|:---|:---|:---|
| **Account & Workspace Data** | User profiles, `projects`, `workspace_folders`, `documents`, `system_designs`, AI generation logs, `subscriptions`, `manual_grants`, `sync_changes`, `processed_mutations` | Supabase Cloud (PostgreSQL 17) + User-Scoped Client IndexedDB (`ArtixDB_v2_<hash>`, schema v3) & `localStorage` (`getUserScopeHash`) | Multi-tenant cloud database guarded by PostgreSQL Row Level Security (RLS) and encrypted at rest (AES-256). Client IndexedDB and draft/tab `localStorage` keys are strictly partitioned per user ID hash, with legacy browser caches purged via `clearSensitiveBrowserCaches()` on boot, account switch, and sign-out. |
| **User AI Credentials (BYOK)** | OpenAI, Anthropic, Google Gemini, Groq, OpenRouter API keys | Client Browser (`localStorage` & RAM) | **Zero-Knowledge / Client-Side Only.** Keys are stored solely on the user's device and are never transmitted to Artix servers or Supabase. |

---

## 2. Account Data Protections

### A. Row Level Security (RLS) & Function Privilege Hardening
All **14** `public` schema tables (`projects`, `documents`, `system_designs`, `workspace_folders`, `profiles`, `prd_generations`, `vibe_generations`, `agentic_workflows`, `subscriptions`, `stripe_events`, `manual_grants`, `processed_mutations`, `sync_changes`, and `sync_retention_state`) have PostgreSQL Row Level Security enabled:
- Every client read, insert, update, and delete operation on user-owned tables is scoped to `auth.uid() = user_id`; users can never query or modify records belonging to other tenants.
- `public.stripe_events` and `public.sync_retention_state` have RLS enabled with zero `anon` or `authenticated` policies (accessible exclusively to `service_role` and internal database maintenance routines).
- `public.manual_grants` permits `authenticated` `SELECT` on the caller's own row (`auth.uid() = user_id`) while restricting all writes to `service_role`.
- `public.apply_sync_mutation` executes as `SECURITY INVOKER` so all sync mutations inherit caller RLS, while `SECURITY DEFINER` trigger functions (`check_plan_tier_limit`, `record_sync_change`, `handle_new_user`) enforce pinned `SET search_path = public` and `REVOKE ALL ... FROM PUBLIC, anon, authenticated`.
- Database foreign keys enforce `ON DELETE CASCADE` referencing `auth.users(id)`, and `check_plan_tier_limit()` serializes per-user quota checks via `pg_advisory_xact_lock` across workspace entities and monthly AI generation tables.

### B. Payment, Price Allowlist & Atomic Webhook Reconciliation
- Checkout session creation (`/functions/v1/create-checkout-session`) validates requested plans against an authoritative server-owned Stripe Price ID allowlist (`supabase/functions/_shared/billingPolicy.ts`) before calling Stripe.
- Stripe billing webhooks (`/functions/v1/stripe-webhook`) verify the cryptographic `Stripe-Signature` header via `constructEventAsync`, perform a live `stripe.subscriptions.retrieve()` lookup, and evaluate `validateSubscriptionEntitlement()` under a strict **fail-closed** policy: `past_due`, `unpaid`, `canceled`, `incomplete`, `incomplete_expired`, and `paused` all resolve to `plan_tier = 'free'`; only `active` or `trialing` subscriptions matching an allowlisted Pro price ID and billing interval grant `'pro'` (unless an active `public.manual_grants` row overrides).
- Both `public.subscriptions` (guarded by monotonic `stripe_event_created_at` and `reconciliation_version` under a per-user `pg_advisory_xact_lock`) and `public.stripe_events` are committed atomically in a **single PostgreSQL RPC transaction** (`public.reconcile_stripe_subscription`, restricted to `service_role`). Any Stripe API or database error returns `HTTP 500` so Stripe retries webhook delivery.

### C. Origin Whitelist & Open Redirect Defense (Task §1.5)
- Edge Functions (`create-checkout-session`, `create-portal-session`) validate `origin` and `return_url` against an allowed origin whitelist via `isOriginAllowed()`.
- Requests from unauthorized origins or protocol-relative/javascript URLs are rejected with `HTTP 400 Bad Request`.

### D. Content Security Policy (CSP)
- Production headers restrict script execution, framing (`frame-ancestors 'none'`), object injection (`object-src 'none'`), and base URI manipulation (`base-uri 'self'`).
- AI provider network calls are constrained to verified endpoints (`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, `api.groq.com`, `openrouter.ai`, and localhost Ollama).

### E. Markdown Rendering & Link Protocol Sanitization
- `MarkdownPreview.tsx` renders user Markdown via `react-markdown` AST nodes without `rehype-raw`, escaping raw inline HTML (`<script>`, event-handler attributes, `<iframe/>`) as inert text.
- Link and media URLs pass through `sanitizeMarkdownUrl`, which strips `javascript:`, `vbscript:`, `data:`, control-character-obfuscated schemes, and protocol-relative `//` URLs, permitting only `http:`, `https:`, `mailto:`, and relative references.

---

## 3. Client-Side API Key Protection Model (BYOK)

Artix features a Bring-Your-Own-Key (BYOK) model allowing users to connect their own AI provider accounts. Stored API keys exist in one of three distinct operational states:

```
                  ┌─────────────────────────────────┐
                  │   State 1: Unencrypted/Default   │
                  │   Stored in localStorage as     │
                  │   obf:<base64-encoded-key>      │
                  └────────────────┬────────────────┘
                                   │ User sets passphrase
                                   ▼
                  ┌─────────────────────────────────┐
                  │   State 2: Locked Vault         │
                  │   AES-256-GCM encrypted blob    │
                  │   Passphrase cleared from RAM   │
                  └────────────────┬────────────────┘
                                   │ User enters passphrase
                                   ▼
                  ┌─────────────────────────────────┐
                  │   State 3: Unlocked Session     │
                  │   Keys decrypted into memory    │
                  │   Active until locked or reload │
                  └─────────────────────────────────┘
```

### Cryptographic Implementation Specifications ([`src/lib/ai/crypto.ts`](./src/lib/ai/crypto.ts))
- **Cipher:** `AES-256-GCM` authenticated symmetric encryption.
- **Key Derivation Function:** `PBKDF2` with `SHA-256`.
- **Iteration Count:** **600,000 rounds** for all `v: 2` saves (`PBKDF2_ITERATIONS_V2 = 600_000`), with backward-compatible decryption for legacy `v: 1` blobs (**250,000 rounds**, `PBKDF2_ITERATIONS_V1 = 250_000`).
- **Salt Length:** 16 cryptographically secure random bytes (`crypto.getRandomValues`).
- **IV Length:** 12 cryptographically secure random bytes per encryption.
- **Envelope Format:** Versioned JSON `{ v: 2, salt: "<b64>", iv: "<b64>", ct: "<b64>" }` (legacy `{ v: 1, ... }` transparently upgraded on next save).

### State Breakdown & Security Guarantees:
1. **State 1: Unencrypted/Default:**
   - Keys are stored in `localStorage` under `artix.ai.settings.v1` with an `obf:` prefix (`obf:${btoa(key)}`).
   - *Threat addressed:* Prevents casual inspection over the shoulder or raw string scanning in browser devtools.
   - *Limitation:* Does not prevent decryption by anyone with read access to `localStorage`.
2. **State 2: Locked Vault:**
   - Keys are encrypted with the PBKDF2-derived key.
   - The plaintext key and decrypted cache are removed from memory (`memoryCache = null; memoryPassphrase = null;`).
   - Plaintext `localStorage` key is removed; only `artix.ai.settings.enc.v1` persists.
   - *Threat addressed:* Protects keys at rest against physical access, stolen backups, and offline disk analysis.
3. **State 3: Unlocked Session:**
   - Passphrase is held in memory to allow automated AI interactions without repeated passphrase prompts.
   - Concurrency is protected via revision-counter checking (`saveRevision`) to prevent race conditions during updates.
   - **Critical Threat Boundary (Live XSS):**
     *When the vault is unlocked, the plain keys reside in volatile JavaScript memory. Any malicious script executing in the browser (via Cross-Site Scripting) can access memory and intercept keys.*
     *Therefore, client-side encryption is an **at-rest defense**, NOT a defense against live in-page XSS. The primary defense against XSS is our strict Content Security Policy, dependency vetting, and input sanitization.*

---

## 4. Architectural Alternatives Evaluated

During the design of the BYOK security architecture, three alternative models were analyzed:

| Alternative Model | Why Not Implemented |
|:---|:---|
| **Non-Extractable CryptoKey Objects** | WebCrypto `CryptoKey` cannot be sent directly as HTTP Bearer tokens to third-party AI APIs (OpenAI/Anthropic require raw authorization headers). Raw keys must be extracted in memory to sign or send HTTP requests. |
| **WebAuthn / Passkeys** | Hardware passkeys provide excellent authentication but cannot derive arbitrary symmetric decryption keys across different browser instances without platform-dependent PRF (Pseudo-Random Function) extensions that lack universal browser support. |
| **Server-Mediated Proxy Custody** | Storing user keys on our backend defeats the zero-knowledge privacy commitment and makes Artix a high-value target for credential exfiltration. |

---

## 5. What Artix Does NOT Protect Against

Understanding the threat boundaries is essential for accurate risk management:

- **Compromised Client Device:** Malware, keyloggers, or malicious browser extensions with broad permissions running on the user's machine can capture passphrases and memory.
- **Forgotten Passphrase with Active Vault:** Because Artix employs zero-knowledge encryption, forgotten passphrases cannot be recovered by support. A "Reset Vault" function is provided which purges the encrypted vault to allow re-entry.
- **Untrusted Third-Party AI Providers:** When you input an API key for OpenAI, Anthropic, or Google, requests and document snippets are sent directly to that provider. Users must trust the respective provider's data retention and privacy policies.

---

## 6. Reporting Security Vulnerabilities

We take security seriously and welcome reports from security researchers and the developer community.

If you discover a potential vulnerability in Artix:
1. **Do not disclose publicly** or file a public GitHub issue.
2. Email full technical details, proof-of-concept steps, and affected components to the repository maintainer:
   - **Security Contact:** `yousef-eng679` via GitHub Security Advisories or direct maintainer channel.
3. Allow reasonable time for remediation before any coordinated disclosure.
