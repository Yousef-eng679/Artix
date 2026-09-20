# Security Policy & Threat Model — Artix

This document details the security architecture, data isolation guarantees, threat model, and cryptographic implementations of the Artix platform.

---

## 1. Data Model & Storage Boundaries

Artix operates with a strict partition between two categories of user data:

| Data Category | Examples | Storage Location | Custody & Access |
|:---|:---|:---|:---|
| **Account & Workspace Data** | User profiles, projects, documents, system architecture boards, subscription status | Supabase Cloud (PostgreSQL) | Multi-tenant database guarded by PostgreSQL Row Level Security (RLS). Encrypted at rest (AES-256). |
| **User AI Credentials (BYOK)** | OpenAI, Anthropic, Google Gemini, Groq, OpenRouter API keys | Client Browser (`localStorage` & RAM) | **Zero-Knowledge / Client-Side Only.** Keys are stored solely on the user's device and are never transmitted to Artix servers or Supabase. |

---

## 2. Account Data Protections

### A. Row Level Security (RLS)
All application tables (`projects`, `documents`, `system_designs`, `subscriptions`, `stripe_events`) have PostgreSQL Row Level Security enabled.
- Every read, insert, update, and delete operation is scoped to `auth.uid() = user_id`.
- Users can never query or modify records belonging to other tenants.
- Database foreign keys enforce `ON DELETE CASCADE` referencing `auth.users(id)`.

### B. Payment & Webhook Cryptographic Verification
- Stripe billing webhooks (`/functions/v1/stripe-webhook`) require and verify the cryptographic `Stripe-Signature` header via Stripe's `constructEventAsync`.
- Webhook idempotency is enforced via `public.stripe_events` to prevent replay attacks and duplicate credit processing.

### C. Origin Whitelist & Open Redirect Defense (Task §1.5)
- Edge Functions (`create-checkout-session`, `create-portal-session`) validate `origin` and `return_url` against an allowed origin whitelist via `isOriginAllowed()`.
- Requests from unauthorized origins or protocol-relative/javascript URLs are rejected with `HTTP 400 Bad Request`.

### D. Content Security Policy (CSP)
- Production headers restrict script execution, framing (`frame-ancestors 'none'`), object injection (`object-src 'none'`), and base URI manipulation (`base-uri 'self'`).
- AI provider network calls are constrained to verified endpoints (`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, `api.groq.com`, `openrouter.ai`, and localhost Ollama).

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

### Cryptographic Implementation Specifications ([`src/lib/ai/crypto.ts`](file:///c:/Fenix-main/src/lib/ai/crypto.ts))
- **Cipher:** `AES-256-GCM` authenticated symmetric encryption.
- **Key Derivation Function:** `PBKDF2` with `SHA-256`.
- **Iteration Count:** **250,000 rounds** (`PBKDF2_ITERATIONS = 250_000`).
- **Salt Length:** 16 cryptographically secure random bytes (`crypto.getRandomValues`).
- **IV Length:** 12 cryptographically secure random bytes per encryption.
- **Envelope Format:** Versioned JSON `{ v: 1, salt: "<b64>", iv: "<b64>", ct: "<b64>" }`.

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
