import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ArtixDB, deleteArtixDB } from '@/lib/local/db';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { PullEngine } from '@/lib/sync/pullEngine';
import { SyncEngine } from '@/lib/sync/syncEngine';
import { TabCoordinator } from '@/lib/sync/tabCoordinator';

describe('TASK-08 (S-05, S-08, OF-09, OF-10): Bound userId Reconnect Pull, Enqueue Wakeup, Single Retry Timer & pendingFollowUpSync', () => {
  const userId = 'user-task-08';
  const projectId = '88888888-8888-4888-8888-888888888888';
  let db: ArtixDB;
  let originalOnLineDescriptor: PropertyDescriptor | undefined;

  function setOnline(online: boolean) {
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => online,
    });
  }

  beforeEach(async () => {
    originalOnLineDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
    setOnline(true);
    const dbName = `ArtixDB_task08_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    db = new ArtixDB(dbName);
  });

  afterEach(async () => {
    vi.useRealTimers();
    setOnline(true);
    if (originalOnLineDescriptor) {
      Object.defineProperty(window.navigator, 'onLine', originalOnLineDescriptor);
    }
    const name = db.name;
    db.close();
    await deleteArtixDB(name);
  });

  it('1. OF-10: bound userId ensures window "online" reconnect, leader election, and cross-tab sync requests run pullAll(userId) before drainOutbox', async () => {
    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);

    const pullAllSpy = vi.fn(async (_uid: string) => ({ totalPulled: 1, finalCursor: 5 }));
    const mockPullEngine = { pullAll: pullAllSpy } as unknown as PullEngine;

    let leadershipCallback: ((isLeader: boolean) => void) | undefined;
    let syncReqCallback: (() => void) | undefined;
    const mockCoordinator = {
      isLeaderTab: () => true,
      getTabId: () => 'tab-leader',
      requestLeaderSync: vi.fn(),
      onLeadershipChange: (cb: (isLeader: boolean) => void) => {
        leadershipCallback = cb;
        return () => {};
      },
      onSyncRequest: (cb: () => void) => {
        syncReqCallback = cb;
        return () => {};
      },
    } as unknown as TabCoordinator;

    setOnline(false);
    const syncEngine = new SyncEngine({
      userId,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
      pullEngine: mockPullEngine,
      tabCoordinator: mockCoordinator,
    } as any);

    // 1. Reconnect online event -> must pull with bound userId!
    setOnline(true);
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => {
      expect(pullAllSpy).toHaveBeenCalledWith(userId);
    });

    // 2. Leadership election -> must pull with bound userId!
    pullAllSpy.mockClear();
    leadershipCallback?.(true);
    await vi.waitFor(() => {
      expect(pullAllSpy).toHaveBeenCalledWith(userId);
    });

    // 3. Standby tab sync request -> must pull with bound userId!
    pullAllSpy.mockClear();
    syncReqCallback?.();
    await vi.waitFor(() => {
      expect(pullAllSpy).toHaveBeenCalledWith(userId);
    });

    syncEngine.destroy();
  });

  it('2. OF-09: enqueuing a local mutation while online automatically wakes SyncEngine post-commit without manual triggerSync()', async () => {
    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);
    const docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);

    const pushedIds: string[] = [];
    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            gt: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        }),
      }),
      rpc: vi.fn(async (_fn: string, params: Record<string, any>) => {
        pushedIds.push(params.p_entity_id);
        return {
          data: { status: 'applied', version: 1, updated_at: '2026-11-01T12:00:00.000Z' },
          error: null,
        };
      }),
    };

    const coordinator = new TabCoordinator({ channelName: `wake-${Date.now()}` });
    vi.spyOn(coordinator, 'isLeaderTab').mockReturnValue(true);

    const syncEngine = new SyncEngine({
      userId,
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
      pullEngine: new PullEngine({ supabaseClient: mockSupabase, db }),
      tabCoordinator: coordinator,
    } as any);

    // Create document via DocumentRepository WITHOUT calling syncEngine.triggerSync() manually!
    const created = await docRepo.create({
      id: '99999999-9999-4999-8999-999999999999',
      userId,
      projectId,
      title: 'Auto Wake Doc',
      content: 'Pushes automatically!',
    });

    await vi.waitFor(() => {
      expect(pushedIds).toEqual([created.id]);
    });

    const meta = await syncMetadataRepo.get('document', created.id);
    expect(meta?.syncState).toBe('synced');

    syncEngine.destroy();
    coordinator.destroy();
  });

  it('3. S-08 / OF-09: schedules a single nextRetryAt timer after transient push failure and automatically drains once backoff elapses', async () => {
    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);
    const docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);

    let attempt = 0;
    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            gt: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        }),
      }),
      rpc: vi.fn(async () => {
        attempt++;
        if (attempt === 1) {
          throw new Error('Failed to fetch: transient flake');
        }
        return {
          data: { status: 'applied', version: 1, updated_at: '2026-11-01T12:05:00.000Z' },
          error: null,
        };
      }),
    };

    const coordinator = new TabCoordinator({ channelName: `timer-${Date.now()}` });
    vi.spyOn(coordinator, 'isLeaderTab').mockReturnValue(true);

    // Create offline first so we control initial trigger
    setOnline(false);
    const doc = await docRepo.create({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId,
      projectId,
      title: 'Retry Timer Doc',
      content: 'Will retry automatically',
    });

    setOnline(true);
    const syncEngine = new SyncEngine({
      userId,
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
      pullEngine: new PullEngine({ supabaseClient: mockSupabase, db }),
      tabCoordinator: coordinator,
    } as any);

    await syncEngine.triggerSync(userId);
    expect(attempt).toBe(1);
    expect(await outboxRepo.countPending(userId)).toBe(1);

    // Shorten stored nextRetryAt to 60ms so real timer fires deterministically with fake-indexeddb
    const [failedEntry] = await outboxRepo.getPending(undefined, userId);
    await db.outbox.update(failedEntry.id, { nextRetryAt: Date.now() + 60 });

    // Trigger sync while still in backoff -> schedules timer for ~60ms and automatically retries!
    await syncEngine.triggerSync(userId);
    expect(attempt).toBe(1);

    await vi.waitFor(
      async () => {
        expect(attempt).toBe(2);
        expect(await outboxRepo.countPending(userId)).toBe(0);
      },
      { timeout: 1500 },
    );

    syncEngine.destroy();
    coordinator.destroy();
  });

  it('4. S-05: pendingFollowUpSync chains an immediate follow-up pull+drain pass when triggerSync() is called mid-flight', async () => {
    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);

    let pullCalls = 0;
    let releaseFirstPull!: () => void;
    const firstPullEntered = new Promise<void>((resolve) => {
      // resolved inside pullAll #1
      (globalThis as any).__resolveFirstPullEntered = resolve;
    });
    const firstPullGate = new Promise<void>((resolve) => {
      releaseFirstPull = resolve;
    });

    const mockPullEngine = {
      pullAll: vi.fn(async () => {
        pullCalls++;
        if (pullCalls === 1) {
          (globalThis as any).__resolveFirstPullEntered();
          await firstPullGate;
        }
        return { totalPulled: 0, finalCursor: pullCalls };
      }),
    } as unknown as PullEngine;

    const coordinator = new TabCoordinator({ channelName: `followup-${Date.now()}` });
    vi.spyOn(coordinator, 'isLeaderTab').mockReturnValue(true);

    const syncEngine = new SyncEngine({
      userId,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
      pullEngine: mockPullEngine,
      tabCoordinator: coordinator,
    } as any);

    const p1 = syncEngine.triggerSync(userId);
    await firstPullEntered;

    // Call triggerSync twice while pass #1 is mid-flight -> must coalesce into ONE follow-up pass (#2)!
    const p2 = syncEngine.triggerSync(userId);
    const p3 = syncEngine.triggerSync(userId);

    releaseFirstPull();
    await Promise.all([p1, p2, p3]);

    expect(pullCalls).toBe(2);

    delete (globalThis as any).__resolveFirstPullEntered;
    syncEngine.destroy();
    coordinator.destroy();
  });
});
