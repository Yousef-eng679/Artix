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

export function obfuscateApiKey(key?: string): string | undefined {
  if (!key) return key;
  if (key.startsWith('obf:')) return key;
  try {
    return `obf:${btoa(key)}`;
  } catch {
    return key;
  }
}

export function deobfuscateApiKey(stored?: string): string | undefined {
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

export class OperationInvalidatedError extends Error {
  constructor(message = 'Operation invalidated: storage was locked or cleared.') {
    super(message);
    this.name = 'OperationInvalidatedError';
  }
}

// Concurrency controls (Task §2.1b)
let stateEpoch = 0;
let operationTail: Promise<unknown> = Promise.resolve();
let latestSaveId = 0;

function enqueueOperation<T>(op: () => Promise<T>): Promise<T> {
  const next = operationTail.then(op, op);
  operationTail = next.catch(() => {});
  return next;
}

export async function saveSettings(settings: AISettings): Promise<void> {
  const requestEpoch = stateEpoch;
  const saveId = ++latestSaveId;

  return enqueueOperation(async () => {
    // If invalidated by lock() or clearSettings() while waiting in queue, abort
    if (requestEpoch !== stateEpoch) return;

    // Coalescing optimization: skip intermediate save if a newer save was already queued
    if (saveId !== latestSaveId) return;

    if (isEncrypted()) {
      if (!isUnlocked()) throw new Error('AI keys are locked. Unlock to save.');
      const pass = memoryPassphrase!;
      const blob = await encryptJSON(settings, pass);

      // Verify not invalidated during encryption
      if (requestEpoch !== stateEpoch) return;
      if (!isUnlocked() || memoryPassphrase !== pass) return;

      memoryCache = settings;
      localStorage.setItem(ENC_KEY, JSON.stringify(blob));
      notifyChange();
      return;
    }

    // Plaintext save
    if (requestEpoch !== stateEpoch) return;
    localStorage.setItem(KEY, JSON.stringify(sanitizeSettingsForStorage(settings)));
    notifyChange();
  });
}

export function clearSettings(): void {
  stateEpoch++;
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
  const requestEpoch = stateEpoch;

  return enqueueOperation(async () => {
    if (requestEpoch !== stateEpoch) {
      throw new OperationInvalidatedError();
    }
    const raw = localStorage.getItem(ENC_KEY);
    if (!raw) throw new Error('No encrypted AI settings found.');
    const blob = JSON.parse(raw) as EncryptedBlob;
    const settings = await decryptJSON<AISettings>(blob, passphrase);

    if (requestEpoch !== stateEpoch) {
      throw new OperationInvalidatedError();
    }

    memoryCache = settings;
    memoryPassphrase = passphrase;
    notifyChange();
    return settings;
  });
}

export function lock(): void {
  stateEpoch++;
  memoryCache = null;
  memoryPassphrase = null;
  notifyChange();
}

export async function enableEncryption(passphrase: string): Promise<void> {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters.');
  }
  const requestEpoch = stateEpoch;

  return enqueueOperation(async () => {
    if (requestEpoch !== stateEpoch) {
      throw new OperationInvalidatedError();
    }
    const current = loadSettings();
    const blob = await encryptJSON(current, passphrase);

    if (requestEpoch !== stateEpoch) {
      throw new OperationInvalidatedError();
    }

    localStorage.setItem(ENC_KEY, JSON.stringify(blob));
    localStorage.removeItem(KEY);
    memoryCache = current;
    memoryPassphrase = passphrase;
    notifyChange();
  });
}

export async function disableEncryption(passphrase: string): Promise<void> {
  const requestEpoch = stateEpoch;

  return enqueueOperation(async () => {
    if (requestEpoch !== stateEpoch) {
      throw new OperationInvalidatedError();
    }
    const raw = localStorage.getItem(ENC_KEY);
    if (!raw) return;
    const blob = JSON.parse(raw) as EncryptedBlob;
    const settings = await decryptJSON<AISettings>(blob, passphrase);

    if (requestEpoch !== stateEpoch) {
      throw new OperationInvalidatedError();
    }

    localStorage.setItem(KEY, JSON.stringify(sanitizeSettingsForStorage(settings)));
    localStorage.removeItem(ENC_KEY);
    memoryCache = null;
    memoryPassphrase = null;
    notifyChange();
  });
}

export async function changePassphrase(oldPass: string, newPass: string): Promise<void> {
  if (!newPass || newPass.length < 8) {
    throw new Error('Passphrase must be at least 8 characters.');
  }
  const requestEpoch = stateEpoch;

  return enqueueOperation(async () => {
    if (requestEpoch !== stateEpoch) {
      throw new OperationInvalidatedError();
    }
    const raw = localStorage.getItem(ENC_KEY);
    if (!raw) throw new Error('Encryption is not enabled.');
    const blob = JSON.parse(raw) as EncryptedBlob;
    const settings = await decryptJSON<AISettings>(blob, oldPass);
    const newBlob = await encryptJSON(settings, newPass);

    if (requestEpoch !== stateEpoch) {
      throw new OperationInvalidatedError();
    }

    localStorage.setItem(ENC_KEY, JSON.stringify(newBlob));
    memoryCache = settings;
    memoryPassphrase = newPass;
    notifyChange();
  });
}
