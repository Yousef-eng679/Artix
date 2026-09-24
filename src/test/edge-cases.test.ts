/**
 * edge-cases.test.ts
 * ──────────────────
 * Unit tests for the Artix caching and data-safety strategy.
 *
 * Architecture Classification:
 *  - Active Production Caching:
 *      1. Debounced Auto-Save (debouncedSave.ts) — wired into useAutoSave
 *      2. Tab Close Protection (tabCloseGuard.ts) — wired into useAutoSave
 *      4. Save Queue (saveQueue.ts)             — wired into useAutoSave
 *      5. Draft Recovery (draftRecovery.ts)     — wired into Editor / SystemArchitect
 *  - Unwired / Orphaned Utility Coverage:
 *      3. Multi-Tab Sync (tabSync.ts)          — standalone utility, not currently wired to production UI
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// 1.  D E B O U N C E D   A U T O - S A V E
// ─────────────────────────────────────────────────────────────────────────────
describe('DebouncedAutoSave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('should NOT fire the save callback on every keystroke', async () => {
    const { createDebouncedSaver } = await import('@/lib/cache/debouncedSave');
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const saver = createDebouncedSaver(saveFn, 300);

    // Simulate rapid keystrokes — 5 chars in 250 ms total
    saver.save('H');
    vi.advanceTimersByTime(50);
    saver.save('He');
    vi.advanceTimersByTime(50);
    saver.save('Hel');
    vi.advanceTimersByTime(50);
    saver.save('Hell');
    vi.advanceTimersByTime(50);
    saver.save('Hello');
    vi.advanceTimersByTime(50); // total 250 ms — still within debounce window

    expect(saveFn).not.toHaveBeenCalled();

    // After debounce window fires
    vi.advanceTimersByTime(300);
    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(saveFn).toHaveBeenCalledWith('Hello');
  });

  it('should skip save when content has not changed', async () => {
    const { createDebouncedSaver } = await import('@/lib/cache/debouncedSave');
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const saver = createDebouncedSaver(saveFn, 300);

    saver.save('Same');
    vi.advanceTimersByTime(300);
    expect(saveFn).toHaveBeenCalledTimes(1);

    // Same content again — should be a no-op
    saver.save('Same');
    vi.advanceTimersByTime(300);
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it('should report hasPending correctly', async () => {
    const { createDebouncedSaver } = await import('@/lib/cache/debouncedSave');
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const saver = createDebouncedSaver(saveFn, 300);

    expect(saver.hasPending()).toBe(false);

    saver.save('Draft');
    expect(saver.hasPending()).toBe(true);

    vi.advanceTimersByTime(300);
    expect(saver.hasPending()).toBe(false);
  });

  it('should expose flushSync to force-save pending content immediately', async () => {
    const { createDebouncedSaver } = await import('@/lib/cache/debouncedSave');
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const saver = createDebouncedSaver(saveFn, 300);

    saver.save('Urgent');
    // Don't wait for timer — flush immediately
    saver.flushSync();

    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(saveFn).toHaveBeenCalledWith('Urgent');
  });

  it('should update localStorage draft cache on every debounce trigger', async () => {
    const { createDebouncedSaver } = await import('@/lib/cache/debouncedSave');
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const docId = 'doc-abc-123';
    const saver = createDebouncedSaver(saveFn, 300, docId);

    saver.save('Cached content');

    // Even before the DB save fires, localStorage should have the draft
    const draft = localStorage.getItem(`artix.draft.${docId}`);
    expect(draft).toBe('Cached content');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2.  T A B   C L O S E   P R O T E C T I O N
// ─────────────────────────────────────────────────────────────────────────────
describe('TabCloseProtection', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('should flush pending content using sendBeacon on beforeunload', async () => {
    const { createTabCloseGuard } = await import('@/lib/cache/tabCloseGuard');
    const beaconSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: beaconSpy });

    const guard = createTabCloseGuard('/api/save');

    // Simulate pending content
    guard.markDirty('doc-1', 'Unsaved paragraph');
    guard.handleBeforeUnload();

    expect(beaconSpy).toHaveBeenCalledTimes(1);
    const [url, body] = beaconSpy.mock.calls[0];
    expect(url).toBe('/api/save');
    const payload = JSON.parse(body);
    expect(payload.documentId).toBe('doc-1');
    expect(payload.content).toBe('Unsaved paragraph');

    vi.unstubAllGlobals();
  });

  it('should NOT fire sendBeacon when there is no pending content', async () => {
    const { createTabCloseGuard } = await import('@/lib/cache/tabCloseGuard');
    const beaconSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: beaconSpy });

    const guard = createTabCloseGuard('/api/save');

    // Nothing dirty — close the tab
    guard.handleBeforeUnload();

    expect(beaconSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('should fall back to keepalive fetch when sendBeacon is unavailable', async () => {
    const { createTabCloseGuard } = await import('@/lib/cache/tabCloseGuard');
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: undefined });
    const fetchSpy = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal('fetch', fetchSpy);

    const guard = createTabCloseGuard('/api/save');
    guard.markDirty('doc-2', 'Fallback content');
    guard.handleBeforeUnload();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/save');
    expect(opts.keepalive).toBe(true);

    vi.unstubAllGlobals();
  });

  it('should clear dirty state after a successful DB save', async () => {
    const { createTabCloseGuard } = await import('@/lib/cache/tabCloseGuard');
    const beaconSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: beaconSpy });

    const guard = createTabCloseGuard('/api/save');

    guard.markDirty('doc-3', 'Draft');
    guard.markClean('doc-3'); // DB save succeeded → mark clean

    guard.handleBeforeUnload();
    expect(beaconSpy).not.toHaveBeenCalled(); // Nothing to flush
    vi.unstubAllGlobals();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3.  M U L T I - T A B   S Y N C   (Unwired / Orphaned Utility Coverage)
// ─────────────────────────────────────────────────────────────────────────────
describe('MultiTabSync (Unwired / Orphaned Utility Coverage)', () => {
  let mockChannel: {
    postMessage: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    onmessage: ((ev: { data: unknown }) => void) | null;
  };

  beforeEach(() => {
    localStorage.clear();
    mockChannel = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
    vi.stubGlobal('BroadcastChannel', vi.fn(() => mockChannel));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should claim leader role when no other tab holds the lock', async () => {
    const { createTabSync } = await import('@/lib/cache/tabSync');
    const sync = createTabSync('doc-edit');

    expect(sync.isLeader()).toBe(true);
  });

  it('should broadcast content updates to other tabs', async () => {
    const { createTabSync } = await import('@/lib/cache/tabSync');
    const sync = createTabSync('doc-edit');

    sync.broadcast({ type: 'CONTENT_UPDATE', docId: 'doc-1', content: 'Hello from Tab A' });

    expect(mockChannel.postMessage).toHaveBeenCalledTimes(1);
    expect(mockChannel.postMessage).toHaveBeenCalledWith({
      type: 'CONTENT_UPDATE',
      docId: 'doc-1',
      content: 'Hello from Tab A',
    });
  });

  it('should invoke onRemoteUpdate when receiving a message from another tab', async () => {
    const { createTabSync } = await import('@/lib/cache/tabSync');
    const onRemote = vi.fn();
    const sync = createTabSync('doc-edit', { onRemoteUpdate: onRemote });

    // Simulate incoming message from another tab
    const incomingData = { type: 'CONTENT_UPDATE', docId: 'doc-1', content: 'From Tab B' };
    mockChannel.onmessage!({ data: incomingData });

    expect(onRemote).toHaveBeenCalledWith(incomingData);
  });

  it('should relinquish leader role on destroy and notify other tabs', async () => {
    const { createTabSync } = await import('@/lib/cache/tabSync');
    const sync = createTabSync('doc-edit');

    sync.destroy();

    expect(mockChannel.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'LEADER_RESIGN' })
    );
    expect(mockChannel.close).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4.  S A V E   Q U E U E   &   O P T I M I S T I C   L O C K I N G
// ─────────────────────────────────────────────────────────────────────────────
describe('SaveQueue (Optimistic Locking)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('should serialize concurrent save calls — never run two in parallel', async () => {
    const { createSaveQueue } = await import('@/lib/cache/saveQueue');

    let concurrentCalls = 0;
    let maxConcurrent = 0;
    const slowSave = vi.fn().mockImplementation(async () => {
      concurrentCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      await new Promise((r) => setTimeout(r, 100));
      concurrentCalls--;
      return { updated_at: new Date().toISOString() };
    });

    const queue = createSaveQueue(slowSave);

    // Fire 3 saves simultaneously
    const p1 = queue.enqueue({ id: 'doc-1', content: 'A' });
    const p2 = queue.enqueue({ id: 'doc-1', content: 'B' });
    const p3 = queue.enqueue({ id: 'doc-1', content: 'C' });

    // Run all timers to completion
    await vi.runAllTimersAsync();
    await Promise.all([p1, p2, p3]);

    expect(maxConcurrent).toBe(1); // Never more than one in-flight
    expect(slowSave).toHaveBeenCalledTimes(3);
  });

  it('should track version and reject stale writes', async () => {
    const { createSaveQueue } = await import('@/lib/cache/saveQueue');

    const saveFn = vi.fn()
      .mockResolvedValueOnce({ updated_at: '2026-07-14T10:00:00Z' }) // v1
      .mockRejectedValueOnce(new Error('VERSION_CONFLICT'));           // stale

    const queue = createSaveQueue(saveFn);

    await queue.enqueue({ id: 'doc-1', content: 'First' });
    expect(queue.getVersion('doc-1')).toBe('2026-07-14T10:00:00Z');

    // Simulate a stale overwrite attempt
    await expect(queue.enqueue({ id: 'doc-1', content: 'Stale' })).rejects.toThrow('VERSION_CONFLICT');
  });

  it('should update version after each successful save', async () => {
    const { createSaveQueue } = await import('@/lib/cache/saveQueue');

    const saveFn = vi.fn()
      .mockResolvedValueOnce({ updated_at: '2026-07-14T10:00:00Z' })
      .mockResolvedValueOnce({ updated_at: '2026-07-14T10:00:05Z' })
      .mockResolvedValueOnce({ updated_at: '2026-07-14T10:00:10Z' });

    const queue = createSaveQueue(saveFn);

    await queue.enqueue({ id: 'doc-1', content: 'v1' });
    expect(queue.getVersion('doc-1')).toBe('2026-07-14T10:00:00Z');

    await queue.enqueue({ id: 'doc-1', content: 'v2' });
    expect(queue.getVersion('doc-1')).toBe('2026-07-14T10:00:05Z');

    await queue.enqueue({ id: 'doc-1', content: 'v3' });
    expect(queue.getVersion('doc-1')).toBe('2026-07-14T10:00:10Z');
  });

  it('should handle saves for different documents independently', async () => {
    const { createSaveQueue } = await import('@/lib/cache/saveQueue');

    const saveFn = vi.fn().mockImplementation(async (payload) => ({
      updated_at: `ts-${payload.id}`,
    }));

    const queue = createSaveQueue(saveFn);

    await queue.enqueue({ id: 'doc-a', content: 'Alpha' });
    await queue.enqueue({ id: 'doc-b', content: 'Beta' });

    expect(queue.getVersion('doc-a')).toBe('ts-doc-a');
    expect(queue.getVersion('doc-b')).toBe('ts-doc-b');
  });

  it('should integrate debounced saver with saveQueue for serial executions', async () => {
    const { createDebouncedSaver } = await import('@/lib/cache/debouncedSave');
    const { createSaveQueue } = await import('@/lib/cache/saveQueue');

    let inFlight = 0;
    let maxInFlight = 0;
    const saveOrder: string[] = [];

    const mockDbSave = vi.fn().mockImplementation(async (payload) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 50));
      saveOrder.push(payload.content);
      inFlight--;
      return { updated_at: `time-${payload.content}` };
    });

    const queue = createSaveQueue(mockDbSave);
    const saver = createDebouncedSaver(
      async (content: string) => {
        await queue.enqueue({ id: 'doc-integrated', content });
      },
      100,
      'doc-integrated'
    );

    // Rapid edits
    saver.save('edit-1');
    saver.save('edit-2');
    saver.save('edit-3');

    // Fast-forward past debounce window
    await vi.advanceTimersByTimeAsync(150);

    expect(maxInFlight).toBe(1);
    expect(mockDbSave).toHaveBeenCalledTimes(1);
    expect(saveOrder).toEqual(['edit-3']); // Debounce batched to final edit
    expect(queue.getVersion('doc-integrated')).toBe('time-edit-3');
  });

  it('should reject stale updates when expectedUpdatedAt does not match (optimistic locking guard)', async () => {
    // Simulate Supabase update with optimistic concurrency guard: .eq('updated_at', expectedUpdatedAt)
    const mockDb = {
      id: 'doc-optimistic',
      content: 'Current Server Content',
      updated_at: '2026-09-20T10:00:00Z',
    };

    const updateDocumentWithGuard = async ({
      id,
      content,
      expectedUpdatedAt,
    }: {
      id: string;
      content: string;
      expectedUpdatedAt?: string;
    }) => {
      if (id !== mockDb.id) throw new Error('Not found');
      // Exact-match guard
      if (expectedUpdatedAt && expectedUpdatedAt !== mockDb.updated_at) {
        throw new Error('VERSION_CONFLICT: Document has been modified by another session');
      }
      mockDb.content = content;
      mockDb.updated_at = '2026-09-20T10:05:00Z';
      return { updated_at: mockDb.updated_at };
    };

    // Attempt update with matching version -> succeeds
    const successResult = await updateDocumentWithGuard({
      id: 'doc-optimistic',
      content: 'New Content from Session 1',
      expectedUpdatedAt: '2026-09-20T10:00:00Z',
    });
    expect(successResult.updated_at).toBe('2026-09-20T10:05:00Z');

    // Attempt update with stale version (older or newer clock skew) -> rejected
    await expect(
      updateDocumentWithGuard({
        id: 'doc-optimistic',
        content: 'Stale Content from Session 2',
        expectedUpdatedAt: '2026-09-20T10:00:00Z', // Old version
      })
    ).rejects.toThrow('VERSION_CONFLICT');

    await expect(
      updateDocumentWithGuard({
        id: 'doc-optimistic',
        content: 'Clock Skewed Content from Session 3',
        expectedUpdatedAt: '2026-09-20T11:00:00Z', // Future version
      })
    ).rejects.toThrow('VERSION_CONFLICT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5.  D R A F T   R E C O V E R Y   O N   M O U N T   (Task §2.3)
// ─────────────────────────────────────────────────────────────────────────────
describe('DraftRecoveryOnMount', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('should recover document draft from localStorage when differing from loaded content', async () => {
    const { getRecoverableDraft } = await import('@/lib/cache/draftRecovery');
    const docId = 'test-doc-123';
    localStorage.setItem(`artix.draft.${docId}`, 'recovered content from crash');

    const recovered = getRecoverableDraft(docId, 'old server content');
    expect(recovered).toBe('recovered content from crash');
  });

  it('should silently clear draft and return null when draft matches server content', async () => {
    const { getRecoverableDraft } = await import('@/lib/cache/draftRecovery');
    const docId = 'test-doc-sync';
    localStorage.setItem(`artix.draft.${docId}`, 'identical content');

    const recovered = getRecoverableDraft(docId, 'identical content');
    expect(recovered).toBeNull();
    expect(localStorage.getItem(`artix.draft.${docId}`)).toBeNull();
  });

  it('should return null when draft is missing or empty whitespace', async () => {
    const { getRecoverableDraft } = await import('@/lib/cache/draftRecovery');
    expect(getRecoverableDraft('missing-id', 'some content')).toBeNull();

    localStorage.setItem('artix.draft.blank-id', '   ');
    expect(getRecoverableDraft('blank-id', 'some content')).toBeNull();
  });

  it('should recover valid board state draft differing from server board state', async () => {
    const { getRecoverableBoardDraft } = await import('@/lib/cache/draftRecovery');
    const designId = 'design-123';
    const serverState = {
      nodes: [{ id: '1', type: 'database', position: { x: 0, y: 0 }, data: { label: 'DB' } }],
      edges: [],
    };
    const draftState = {
      nodes: [
        { id: '1', type: 'database', position: { x: 0, y: 0 }, data: { label: 'DB' } },
        { id: '2', type: 'server', position: { x: 100, y: 100 }, data: { label: 'API' } },
      ],
      edges: [{ id: 'e1-2', source: '1', target: '2' }],
    };

    localStorage.setItem(`artix.draft.${designId}`, JSON.stringify(draftState));

    const recovered = getRecoverableBoardDraft(designId, serverState);
    expect(recovered).toEqual(draftState);
  });

  it('should silently clear board draft when it matches server board state', async () => {
    const { getRecoverableBoardDraft } = await import('@/lib/cache/draftRecovery');
    const designId = 'design-same';
    const serverState = {
      nodes: [{ id: '1', type: 'database', position: { x: 0, y: 0 }, data: { label: 'DB' } }],
      edges: [],
    };

    localStorage.setItem(`artix.draft.${designId}`, JSON.stringify(serverState));

    const recovered = getRecoverableBoardDraft(designId, serverState);
    expect(recovered).toBeNull();
    expect(localStorage.getItem(`artix.draft.${designId}`)).toBeNull();
  });

  it('should gracefully ignore corrupted JSON board draft without throwing', async () => {
    const { getRecoverableBoardDraft } = await import('@/lib/cache/draftRecovery');
    const designId = 'design-corrupt';
    const serverState = { nodes: [], edges: [] };

    localStorage.setItem(`artix.draft.${designId}`, '{{{not-valid-json... broken');

    const recovered = getRecoverableBoardDraft(designId, serverState);
    expect(recovered).toBeNull();
  });

  it('should flush recovered draft through debounced saver and clear draft upon successful DB save', async () => {
    const { getRecoverableDraft } = await import('@/lib/cache/draftRecovery');
    const { createDebouncedSaver } = await import('@/lib/cache/debouncedSave');
    const docId = 'doc-recovery-flush';
    const draftContent = 'Unsaved draft before crash';
    localStorage.setItem(`artix.draft.${docId}`, draftContent);

    const recovered = getRecoverableDraft(docId, 'Original content');
    expect(recovered).toBe(draftContent);

    const mockDbSave = vi.fn().mockResolvedValue(undefined);
    const saver = createDebouncedSaver(mockDbSave, 300, docId);

    // Component mounts with recovered draft and triggers save
    saver.save(recovered!);

    // Debounce timer fires
    await vi.advanceTimersByTimeAsync(350);

    expect(mockDbSave).toHaveBeenCalledTimes(1);
    expect(mockDbSave).toHaveBeenCalledWith(draftContent);

    // Once DB save finishes, draft key is cleared from localStorage
    expect(localStorage.getItem(`artix.draft.${docId}`)).toBeNull();
  });
});
