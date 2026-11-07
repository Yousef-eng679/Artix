# Client-Side BYOK Key Encryption & Storage Security

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/ai/crypto.ts`, `src/lib/ai/storage.ts`, `src/test/security.test.ts`, `src/test/sync/circularImportsDiff3AndCryptoV2.test.ts`

---

## 1. Overview

Artix adopts a **Bring-Your-Own-Key (BYOK)** model for third-party AI frontier models (OpenAI, Anthropic, Google Gemini, Groq, OpenRouter). Users provide their private API keys directly.

To protect API keys at rest when the passphrase vault is enabled, Artix implements zero-knowledge, client-side cryptography in `localStorage`.

---

## 2. Cryptographic Specification

Implemented in `src/lib/ai/crypto.ts` using the browser's native **Web Cryptography API** (`window.crypto.subtle`):

```text
User Passphrase
       │
       ▼
┌────────────────────────────────────────────────────────┐
│           Key Derivation Function (PBKDF2)             │
│                                                        │
│  - Salt: 16 cryptographically random bytes             │
│  - Iteration Count: 600,000 iterations (v: 2 default)  │
│    (250,000 iterations retained for legacy v: 1 read)  │
│  - Digest Algorithm: SHA-256                           │
│  - Derived Key Length: 256 bits                        │
└───────────────────────────┬────────────────────────────┘
                            │ Derived Symmetric Key
                            ▼
┌────────────────────────────────────────────────────────┐
│             Symmetric Encryption (AES-GCM)             │
│                                                        │
│  - Algorithm: AES-GCM 256-bit                          │
│  - Initialization Vector (IV): 12 random bytes         │
│  - Authentication Tag Length: 128 bits                 │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
Encrypted Payload Serialized to localStorage:
{
  "v": 2,
  "salt": "<base64>",
  "iv": "<base64>",
  "ct": "<base64>"
}
```

---

## 3. Storage Sanitization & Key Obfuscation (`storage.ts`)

When passphrase encryption is not enabled by the user:
1. `sanitizeSettingsForStorage()` encodes stored keys with an `obf:` Base64 prefix (`obf:${btoa(key)}`) as a casual-inspection guard only.
2. When passphrase encryption is enabled (`enableEncryption`), plaintext `localStorage` keys are removed and only `artix.ai.settings.enc.v1` persists.
3. On `signOut()`, `lock()` increments `stateEpoch` and wipes `memoryCache` and `memoryPassphrase` from RAM.

---

## 4. Security Invariants

- **Zero-Knowledge**: The Artix server and Supabase database never receive or store the user's AI API keys or encryption passphrases.
- **Brute-Force Resistance**: 600,000 rounds of PBKDF2-SHA256 (`v: 2`) with a 128-bit random salt protect encrypted vaults against offline dictionary attacks, while `v: 1` (250,000 rounds) vaults remain decryptable and upgrade automatically on save.
- **Tamper Evidence**: AES-GCM's 128-bit authentication tag guarantees that any modification of `ct` or `iv` in `localStorage` causes decryption to reject.
