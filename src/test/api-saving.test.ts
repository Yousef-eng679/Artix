import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  saveSettings,
  loadSettings,
  clearSettings,
  isEncrypted,
  isUnlocked,
  enableEncryption,
  disableEncryption,
  unlock,
  lock,
  changePassphrase,
  OperationInvalidatedError,
} from '../lib/ai/storage';
import { AISettings } from '../lib/ai/types';
import * as cryptoModule from '../lib/ai/crypto';

describe('API Settings Saving & Encryption', () => {
  beforeEach(() => {
    localStorage.clear();
    lock(); // Reset memory cache
  });

  it('should save and load settings in plaintext by default', async () => {
    const settings: AISettings = {
      primary: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'sk-12345',
      },
    };

    await saveSettings(settings);
    expect(isEncrypted()).toBe(false);

    const loaded = loadSettings();
    expect(loaded).toEqual(settings);
  });

  it('should enable encryption and lock/unlock settings correctly', async () => {
    const settings: AISettings = {
      primary: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        apiKey: 'sk-ant-123',
      },
    };

    // 1. Save settings in plaintext first
    await saveSettings(settings);

    // 2. Enable encryption with a passphrase
    const passphrase = 'my-secure-password';
    await enableEncryption(passphrase);
    expect(isEncrypted()).toBe(true);

    // After enabling encryption, settings are loaded from memory (unlocked state)
    expect(isUnlocked()).toBe(true);
    expect(loadSettings()).toEqual(settings);

    // 3. Lock the storage
    lock();
    expect(isUnlocked()).toBe(false);
    expect(loadSettings()).toEqual({}); // Locked settings return empty object

    // 4. Unlock with correct passphrase
    const unlockedSettings = await unlock(passphrase);
    expect(isUnlocked()).toBe(true);
    expect(unlockedSettings).toEqual(settings);
    expect(loadSettings()).toEqual(settings);

    // 5. Lock and try unlocking with WRONG passphrase (should throw error)
    lock();
    await expect(unlock('wrong-password')).rejects.toThrow();
    expect(isUnlocked()).toBe(false);
  });

  it('should disable encryption and restore plaintext values', async () => {
    const settings: AISettings = {
      primary: {
        provider: 'google',
        model: 'gemini-2.0-flash',
        apiKey: 'ai-gemini-key',
      },
    };

    await saveSettings(settings);
    const passphrase = 'password123';
    await enableEncryption(passphrase);
    expect(isEncrypted()).toBe(true);

    // Disable encryption
    await disableEncryption(passphrase);
    expect(isEncrypted()).toBe(false);
    expect(loadSettings()).toEqual(settings);

    // Verify no raw API key in localStorage — must be obfuscated
    const stored = localStorage.getItem('artix.ai.settings.v1');
    expect(stored).not.toContain('ai-gemini-key');
    expect(stored).toContain('obf:');
  });

  it('should completely clear all settings', async () => {
    const settings: AISettings = {
      primary: {
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'another-key',
      },
    };

    await saveSettings(settings);
    expect(loadSettings()).toEqual(settings);

    clearSettings();
    expect(loadSettings()).toEqual({});
    expect(localStorage.getItem('artix.ai.settings.v1')).toBeNull();
    expect(localStorage.getItem('artix.ai.settings.enc.v1')).toBeNull();
  });

  it('should handle rapid saves without stale data in encrypted mode', async () => {
    const passphrase = 'password123';
    await enableEncryption(passphrase);
    expect(isUnlocked()).toBe(true);

    // Three rapid saves without awaiting intermediate ones
    const p1 = saveSettings({ primary: { provider: 'openai', model: 'gpt-4', apiKey: 'A' } });
    const p2 = saveSettings({ primary: { provider: 'openai', model: 'gpt-4', apiKey: 'B' } });
    const p3 = saveSettings({ primary: { provider: 'openai', model: 'gpt-4', apiKey: 'C' } });

    await Promise.all([p1, p2, p3]);

    const loaded = loadSettings();
    expect(loaded.primary?.apiKey).toBe('C');
  });

  describe('Concurrency Hardening (Task §2.1b)', () => {
    it('Case A (FIFO): enableEncryption followed immediately by saveSettings persists v2 in newly encrypted vault', async () => {
      // Initially plaintext
      const p1 = enableEncryption('strong-passphrase-123');
      const p2 = saveSettings({ primary: { provider: 'google', model: 'gemini', apiKey: 'v2-key' } });

      await Promise.all([p1, p2]);

      expect(isEncrypted()).toBe(true);
      expect(isUnlocked()).toBe(true);

      const loaded = loadSettings();
      expect(loaded.primary?.apiKey).toBe('v2-key');

      // Verify that ENC_KEY has the encrypted blob decryptable with strong-passphrase-123 containing v2-key
      const raw = localStorage.getItem('artix.ai.settings.enc.v1');
      expect(raw).not.toBeNull();
      const decrypted = await cryptoModule.decryptJSON<AISettings>(JSON.parse(raw!), 'strong-passphrase-123');
      expect(decrypted.primary?.apiKey).toBe('v2-key');
    });

    it('Case B (FIFO): saveSettings followed immediately by enableEncryption incorporates v2 into the encrypted vault', async () => {
      // Plaintext save followed immediately by encryption
      const p1 = saveSettings({ primary: { provider: 'openai', model: 'gpt-4o', apiKey: 'v2-plaintext' } });
      const p2 = enableEncryption('strong-passphrase-123');

      await Promise.all([p1, p2]);

      expect(isEncrypted()).toBe(true);
      expect(isUnlocked()).toBe(true);
      expect(loadSettings().primary?.apiKey).toBe('v2-plaintext');

      const raw = localStorage.getItem('artix.ai.settings.enc.v1');
      expect(raw).not.toBeNull();
      const decrypted = await cryptoModule.decryptJSON<AISettings>(JSON.parse(raw!), 'strong-passphrase-123');
      expect(decrypted.primary?.apiKey).toBe('v2-plaintext');
    });

    it('FIFO: changePassphrase followed immediately by saveSettings encrypts with the new passphrase', async () => {
      await enableEncryption('old-passphrase-123');
      expect(isUnlocked()).toBe(true);

      const p1 = changePassphrase('old-passphrase-123', 'new-passphrase-456');
      const p2 = saveSettings({ primary: { provider: 'anthropic', model: 'claude-3', apiKey: 'v3-key' } });

      await Promise.all([p1, p2]);

      expect(isEncrypted()).toBe(true);
      expect(isUnlocked()).toBe(true);

      const raw = localStorage.getItem('artix.ai.settings.enc.v1');
      expect(raw).not.toBeNull();

      // Successfully decrypted with new passphrase
      const decryptedNew = await cryptoModule.decryptJSON<AISettings>(JSON.parse(raw!), 'new-passphrase-456');
      expect(decryptedNew.primary?.apiKey).toBe('v3-key');

      // Old passphrase must fail
      await expect(cryptoModule.decryptJSON(JSON.parse(raw!), 'old-passphrase-123')).rejects.toThrow();
    });

    it('Test A (unlock + clearSettings): rejects unlock and does not resurrect cleared vault', async () => {
      await enableEncryption('password123');
      lock();
      expect(isUnlocked()).toBe(false);

      let resolveDecrypt: () => void;
      const pausePromise = new Promise<void>((resolve) => {
        resolveDecrypt = resolve;
      });

      const originalDecrypt = cryptoModule.decryptJSON;
      const spy = vi.spyOn(cryptoModule, 'decryptJSON').mockImplementation(async (blob, pass) => {
        await pausePromise;
        return originalDecrypt(blob, pass);
      });

      const unlockPromise = unlock('password123');

      // While decrypt is paused in-flight, synchronously clearSettings()
      clearSettings();

      // Resume decrypt
      resolveDecrypt!();

      // unlock must reject with OperationInvalidatedError
      await expect(unlockPromise).rejects.toThrow(OperationInvalidatedError);

      // Storage and memory must remain completely cleared
      expect(isUnlocked()).toBe(false);
      expect(loadSettings()).toEqual({});
      expect(localStorage.getItem('artix.ai.settings.v1')).toBeNull();
      expect(localStorage.getItem('artix.ai.settings.enc.v1')).toBeNull();

      spy.mockRestore();
    });

    it('Test B (unlock + lock): rejects unlock and keeps memory locked', async () => {
      await enableEncryption('password123');
      lock();
      expect(isUnlocked()).toBe(false);

      let resolveDecrypt: () => void;
      const pausePromise = new Promise<void>((resolve) => {
        resolveDecrypt = resolve;
      });

      const originalDecrypt = cryptoModule.decryptJSON;
      const spy = vi.spyOn(cryptoModule, 'decryptJSON').mockImplementation(async (blob, pass) => {
        await pausePromise;
        return originalDecrypt(blob, pass);
      });

      const unlockPromise = unlock('password123');

      // While decrypt is paused in-flight, synchronously lock()
      lock();

      // Resume decrypt
      resolveDecrypt!();

      // unlock must reject with OperationInvalidatedError
      await expect(unlockPromise).rejects.toThrow(OperationInvalidatedError);

      // Memory must remain locked
      expect(isUnlocked()).toBe(false);
      expect(loadSettings()).toEqual({});

      spy.mockRestore();
    });

    it('should cleanly abort saveSettings without mutating storage when lock() occurs in-flight', async () => {
      await enableEncryption('password123');
      expect(isUnlocked()).toBe(true);

      let resolveEncrypt: () => void;
      const pausePromise = new Promise<void>((resolve) => {
        resolveEncrypt = resolve;
      });

      const originalEncrypt = cryptoModule.encryptJSON;
      const spy = vi.spyOn(cryptoModule, 'encryptJSON').mockImplementation(async (val, pass) => {
        await pausePromise;
        return originalEncrypt(val, pass);
      });

      const savePromise = saveSettings({ primary: { provider: 'openai', model: 'gpt-4', apiKey: 'stale-after-lock' } });

      // Synchronously lock while encrypt is in-flight
      lock();
      expect(isUnlocked()).toBe(false);

      // Resume encrypt
      resolveEncrypt!();

      // saveSettings resolves as harmless no-op
      await savePromise;

      // Storage must remain locked and NOT contain stale-after-lock
      expect(isUnlocked()).toBe(false);
      expect(loadSettings()).toEqual({});

      spy.mockRestore();
    });

    it('should reject state transitions with OperationInvalidatedError if cleared while in queue', async () => {
      // Plaintext mode initially
      let resolveEncrypt: () => void;
      const pausePromise = new Promise<void>((resolve) => {
        resolveEncrypt = resolve;
      });

      const originalEncrypt = cryptoModule.encryptJSON;
      const spy = vi.spyOn(cryptoModule, 'encryptJSON').mockImplementation(async (val, pass) => {
        await pausePromise;
        return originalEncrypt(val, pass);
      });

      const p1 = enableEncryption('passphrase-one');

      // While p1 is awaiting encrypt, call clearSettings()
      clearSettings();

      // Resume encrypt
      resolveEncrypt!();

      await expect(p1).rejects.toThrow(OperationInvalidatedError);
      expect(isEncrypted()).toBe(false);

      spy.mockRestore();
    });
  });
});
