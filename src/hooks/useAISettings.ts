import { useEffect, useState, useCallback } from 'react';
import { AISettings } from '@/lib/ai/types';
import {
  loadSettings,
  saveSettings,
  clearSettings,
  hasPrimaryProvider,
  isEncrypted,
  isUnlocked,
  unlock as unlockStorage,
  lock as lockStorage,
  enableEncryption as enableEnc,
  disableEncryption as disableEnc,
  changePassphrase as changePass,
} from '@/lib/ai/storage';

export function useAISettings() {
  const [settings, setSettings] = useState<AISettings>(() => loadSettings());
  const [encrypted, setEncrypted] = useState<boolean>(() => isEncrypted());
  const [unlocked, setUnlocked] = useState<boolean>(() => !isEncrypted() || isUnlocked());

  useEffect(() => {
    const handler = () => {
      setSettings(loadSettings());
      setEncrypted(isEncrypted());
      setUnlocked(!isEncrypted() || isUnlocked());
    };
    window.addEventListener('artix-ai-settings-changed', handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener('artix-ai-settings-changed', handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  const update = useCallback(async (next: AISettings) => {
    await saveSettings(next);
    setSettings(next);
  }, []);

  const clear = useCallback(() => {
    clearSettings();
    setSettings({});
  }, []);

  const unlock = useCallback(async (passphrase: string) => {
    await unlockStorage(passphrase);
  }, []);

  const lock = useCallback(() => {
    lockStorage();
  }, []);

  const enableEncryption = useCallback(async (passphrase: string) => {
    await enableEnc(passphrase);
  }, []);

  const disableEncryption = useCallback(async (passphrase: string) => {
    await disableEnc(passphrase);
  }, []);

  const changePassphrase = useCallback(async (oldP: string, newP: string) => {
    await changePass(oldP, newP);
  }, []);

  return {
    settings,
    update,
    clear,
    isConfigured: hasPrimaryProvider(settings),
    encrypted,
    unlocked,
    unlock,
    lock,
    enableEncryption,
    disableEncryption,
    changePassphrase,
  };
}
