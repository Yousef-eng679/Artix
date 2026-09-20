import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDebouncedSaver } from '@/lib/cache/debouncedSave';
import { loadSettings, lock } from '@/lib/ai/storage';

describe('Storage Quota & Corruption Resilience', () => {
  beforeEach(() => {
    localStorage.clear();
    lock();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should continue saving to remote DB even when localStorage throws QuotaExceededError', async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);

    // Mock localStorage.setItem to throw QuotaExceededError
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      const error = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      throw error;
    });

    const saver = createDebouncedSaver(saveFn, 200, 'doc-quota-test');

    // Should not throw
    expect(() => saver.save('New Content Under Quota Limit')).not.toThrow();

    // Advance timers to trigger remote save
    vi.advanceTimersByTime(250);

    expect(saveFn).toHaveBeenCalledWith('New Content Under Quota Limit');
  });

  it('should return empty settings object when localStorage contains corrupted JSON', () => {
    // Inject invalid JSON string
    localStorage.setItem('artix.ai.settings.v1', '{corrupted: json [unclosed');

    const settings = loadSettings();
    expect(settings).toEqual({});
  });

  it('should handle corrupted legacy Fenix settings safely without crashing', () => {
    localStorage.setItem('fenix.ai.settings.v1', 'not valid json string');

    const settings = loadSettings();
    expect(settings).toEqual({});
  });
});
