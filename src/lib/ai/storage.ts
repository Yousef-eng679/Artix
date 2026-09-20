import { AISettings } from './types';
import { decryptJSON, encryptJSON, EncryptedBlob } from './crypto';

const KEY = 'artix.ai.settings.v1';
const ENC_KEY = 'artix.ai.settings.enc.v1';

// In-memory cache for encrypted mode.
let memoryCache: AISettings | null = null;
let memoryPassphrase: string | null = null;

export function isEncrypted(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(ENC_KEY) !== null;
}

export function isUnlocked(): boolean {
  return memoryCache !== null && memoryPassphrase !== null;
}

function obfuscateApiKey(key?: string): string | undefined {
  if (!key) return key;
  if (key.startsWith('obf:')) return key;
  try {
    return `obf:${btoa(key)}`;
  } catch {
    return key;
  }
}

function deobfuscateApiKey(stored?: string): string | undefined {
  if (!stored) return stored;
  if (!stored.startsWith('obf:')) return stored;
  try {
    return atob(stored.slice(4));
  } catch {
    return stored;
  }
}

function sanitizeSettingsForStorage(s: AISettings): AISettings {
  const clone = JSON.parse(JSON.stringify(s)) as AISettings;
  if (clone.primary?.apiKey) {
    clone.primary.apiKey = obfuscateApiKey(clone.primary.apiKey);
  }
  return clone;
}

function restoreSettingsFromStorage(s: AISettings): AISettings {
  const clone = JSON.parse(JSON.stringify(s)) as AISettings;
  if (clone.primary?.apiKey) {
    clone.primary.apiKey = deobfuscateApiKey(clone.primary.apiKey);
  }
  return clone;
}

export function loadSettings(): AISettings {
  if (typeof window === 'undefined') return {};
  if (isEncrypted()) {
    return isUnlocked() ? memoryCache! : {};
  }
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      // Migrate legacy fenix settings if present
      const legacyRaw = localStorage.getItem('fenix.ai.settings.v1');
      if (legacyRaw) {
        localStorage.setItem(KEY, legacyRaw);
        localStorage.removeItem('fenix.ai.settings.v1');
        const legacyEnc = localStorage.getItem('fenix.ai.settings.enc.v1');
        if (legacyEnc) {
          localStorage.setItem(ENC_KEY, legacyEnc);
          localStorage.removeItem('fenix.ai.settings.enc.v1');
        }
        return restoreSettingsFromStorage(JSON.parse(legacyRaw) as AISettings);
      }
      return {};
    }
    return restoreSettingsFromStorage(JSON.parse(raw) as AISettings);
  } catch {
    return {};
  }
}

function notifyChange() {
  window.dispatchEvent(new CustomEvent('artix-ai-settings-changed'));
}

let saveRevision = 0;

export async function saveSettings(settings: AISettings): Promise<void> {
  if (isEncrypted()) {
    if (!isUnlocked()) throw new Error('AI keys are locked. Unlock to save.');
    const revision = ++saveRevision;
    const blob = await encryptJSON(settings, memoryPassphrase!);
    if (revision !== saveRevision) return; // stale write, skip
    if (!isUnlocked() || !memoryPassphrase) return; // storage locked while encrypting
    memoryCache = settings;
    localStorage.setItem(ENC_KEY, JSON.stringify(blob));
    notifyChange();
    return;
  }
  localStorage.setItem(KEY, JSON.stringify(sanitizeSettingsForStorage(settings)));
  notifyChange();
}

export function clearSettings(): void {
  localStorage.removeItem(KEY);
  localStorage.removeItem(ENC_KEY);
  memoryCache = null;
  memoryPassphrase = null;
  notifyChange();
}

export function hasPrimaryProvider(s: AISettings = loadSettings()): boolean {
  if (!s.primary?.provider || !s.primary.model) return false;
  return !!s.primary.apiKey;
}

// ---- Passphrase encryption controls ----

export async function unlock(passphrase: string): Promise<AISettings> {
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw) throw new Error('No encrypted AI settings found.');
  const blob = JSON.parse(raw) as EncryptedBlob;
  const settings = await decryptJSON<AISettings>(blob, passphrase);
  memoryCache = settings;
  memoryPassphrase = passphrase;
  notifyChange();
  return settings;
}

export function lock(): void {
  memoryCache = null;
  memoryPassphrase = null;
  notifyChange();
}

export async function enableEncryption(passphrase: string): Promise<void> {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters.');
  }
  const current = loadSettings();
  const blob = await encryptJSON(current, passphrase);
  localStorage.setItem(ENC_KEY, JSON.stringify(blob));
  localStorage.removeItem(KEY);
  memoryCache = current;
  memoryPassphrase = passphrase;
  notifyChange();
}

export async function disableEncryption(passphrase: string): Promise<void> {
  // Verify passphrase by decrypting first.
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw) return;
  const blob = JSON.parse(raw) as EncryptedBlob;
  const settings = await decryptJSON<AISettings>(blob, passphrase);
  localStorage.setItem(KEY, JSON.stringify(sanitizeSettingsForStorage(settings)));
  localStorage.removeItem(ENC_KEY);
  memoryCache = null;
  memoryPassphrase = null;
  notifyChange();
}

export async function changePassphrase(oldPass: string, newPass: string): Promise<void> {
  if (!newPass || newPass.length < 8) {
    throw new Error('Passphrase must be at least 8 characters.');
  }
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw) throw new Error('Encryption is not enabled.');
  const blob = JSON.parse(raw) as EncryptedBlob;
  const settings = await decryptJSON<AISettings>(blob, oldPass);
  const newBlob = await encryptJSON(settings, newPass);
  localStorage.setItem(ENC_KEY, JSON.stringify(newBlob));
  memoryCache = settings;
  memoryPassphrase = newPass;
  notifyChange();
}
