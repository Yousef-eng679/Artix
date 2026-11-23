// WebCrypto AES-GCM encryption with PBKDF2-derived key.
// Used to protect AI provider API keys stored in localStorage behind a user passphrase.
//
// Versioned envelope migration (Decision A3 / TASK-22):
//   - v: 2 (default for all new encryptions): 600,000 PBKDF2-SHA256 iterations (OWASP 2023+ recommendation)
//   - v: 1 (legacy backward-compatible read): 250,000 PBKDF2-SHA256 iterations

export const PBKDF2_ITERATIONS_V1 = 250_000;
export const PBKDF2_ITERATIONS_V2 = 600_000;
export const PBKDF2_ITERATIONS = PBKDF2_ITERATIONS_V2;

const KEY_LEN = 256;
const SALT_LEN = 16;
const IV_LEN = 12;

export interface EncryptedBlobV1 {
  v: 1;
  salt: string; // base64
  iv: string; // base64
  ct: string; // base64
}

export interface EncryptedBlobV2 {
  v: 2;
  salt: string; // base64
  iv: string; // base64
  ct: string; // base64
}

export type EncryptedBlob = EncryptedBlobV1 | EncryptedBlobV2;

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function resolveIterationsForBlob(version: number): number {
  if (version === 2) return PBKDF2_ITERATIONS_V2;
  if (version === 1) return PBKDF2_ITERATIONS_V1;
  throw new Error(`Unsupported encrypted vault version: ${String(version)}`);
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: KEY_LEN },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJSON(value: unknown, passphrase: string): Promise<EncryptedBlobV2> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS_V2);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return { v: 2, salt: toB64(salt), iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

export async function decryptJSON<T = unknown>(
  blob: EncryptedBlob,
  passphrase: string,
): Promise<T> {
  const iterations = resolveIterationsForBlob(blob.v);
  const saltBytes = fromB64(blob.salt);
  const ivBytes = fromB64(blob.iv);
  const ctBytes = fromB64(blob.ct);
  const key = await deriveKey(passphrase, saltBytes, iterations);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes as BufferSource },
    key,
    ctBytes as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}
