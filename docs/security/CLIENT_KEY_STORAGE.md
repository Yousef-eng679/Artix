# Client-Side BYOK Key Encryption & Storage Security

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/ai/crypto.ts`, `src/lib/ai/storage.ts`, `src/test/security.test.ts`

---

## 1. Overview

Artix adopts a **Bring-Your-Own-Key (BYOK)** model for third-party AI frontier models (OpenAI, Anthropic, Google Gemini, Groq, OpenRouter). Users provide their private API keys directly. 

To eliminate the catastrophic risk of plaintext API key exposure in browser `localStorage`, Artix implements zero-knowledge, client-side cryptography.

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
│  - Salt: 16 cryptographically random bytes (crypto.getRandomValues)
│  - Iteration Count: 100,000 iterations                │
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
  "ciphertext": "<base64>",
  "iv": "<base64>",
  "salt": "<base64>",
  "version": 1
}
```

---

## 3. Storage Sanitization & Key Obfuscation (`storage.ts`)

When encryption is disabled by the user or when the user switches passphrases:
1. `sanitizeSettingsForStorage()` is invoked automatically.
2. Raw API keys are masked or obfuscated in memory before writing to `localStorage`.
3. The application never stores raw, unencrypted API keys in plaintext in `localStorage`.
4. Keys are injected into memory only during active inference API calls, and headers are wiped immediately after the network socket closes.

---

## 4. Security Invariants

- **Zero-Knowledge**: The Artix server and Supabase database never receive or store the user's AI API keys or encryption passphrases.
- **Brute-Force Resistance**: 100,000 rounds of PBKDF2 with a 128-bit random salt render offline dictionary attacks computationally prohibitive.
- **Tamper Evidence**: AES-GCM's 128-bit authentication tag guarantees that any modification of the ciphertext or IV in `localStorage` causes decryption to throw an authentication tag mismatch exception.
