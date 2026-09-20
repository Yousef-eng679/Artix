import { describe, it, expect, beforeEach } from 'vitest';
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
} from '../lib/ai/storage';
import { AISettings } from '../lib/ai/types';

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
});
