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

describe('TASK-09 (S-02, S-05): Atomic Push-Ack / Push-Fail Dexie Transactions & leaseToken Stale-Tab Fencing', () => {
  const userId = 'user-task-09';
  const projectId = '99999999-1111-4111-8111-999999999999';
  let db: ArtixDB;

  beforeEach(async () => {
    const dbName = `ArtixDB_task09_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    db = new ArtixDB(dbName);
  });

  afterEach(async () => {
    const name = db.name;
    db.close();
    await deleteArtixDB(name);
  });

  it('1. stamps a unique leaseToken on markInFlight and clears leaseToken on recoverStaleLeases', async () => {
    const outboxRepo = new OutboxRepository(db);
    const docRepo = new DocumentRepository(db, outboxRepo);

    const doc = await docRepo.create({
      userId,
      projectId,
      title: 'Lease Token Doc',
      content: 'v1',
    });

    const [entry] = await outboxRepo.listByEntity(userId, 'document', doc.id);
    const tokenA = await (outboxRepo.markInFlight(entry.id, 'tab-A', 30_000) as Promise<any>);

    expect(typeof tokenA).toBe('string');
    expect(tokenA.length).toBeGreaterThan(10);

    const inFlightA = await outboxRepo.getById(entry.id);
    expect((inFlightA as any)?.leaseToken).toBe(tokenA);

    await outboxRepo.recoverStaleLeases({ now: Date.now() + 60_000 });
    const recovered = await outboxRepo.getById(entry.id);
    expect(recovered?.state).toBe('pending');
    expect((recovered as any)?.leaseToken).toBeNull();

    const tokenB = await (outboxRepo.markInFlight(entry.id, 'tab-B', 30_000) as Promise<any>);
    expect(typeof tokenB).toBe('string');
    expect(tokenB).not.toBe(tokenA);
  });

  it('2. S-02: rolls back outbox deletion atomically if sync_metadata acknowledgement throws mid-transaction', async () => {
    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);
    const docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);

    const doc = await docRepo.create({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      userId,
      projectId,
      title: 'Atomic Ack Doc',
      content: 'v1',
    });

    const [entry] = await outboxRepo.listByEntity(userId, 'document', doc.id);

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
      rpc: vi.fn(async () => ({
        data: { status: 'applied', version: 1, updated_at: '2026-11-01T12:00:00.000Z' },
        error: null,
      })),
    };

    // Inject storage failure on sync_metadata write AFTER push succeeds!
    const putSpy = vi
      .spyOn(db.sync_metadata, 'put')
      .mockImplementationOnce(() => Promise.reject(new Error('Simulated IndexedDB crash mid-ack')) as any);

    const coordinator = new TabCoordinator({ channelName: `ack-atomic-${Date.now()}` });
    vi.spyOn(coordinator, 'isLeaderTab').mockReturnValue(true);

    const syncEngine = new SyncEngine({
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
      pullEngine: new PullEngine({ supabaseClient: mockSupabase, db }),
      tabCoordinator: coordinator,
    });

    // Wait: markSyncing also calls sync_metadata.put, so only fail during post-push acknowledgement!
    putSpy.mockRestore();
    let putCallCount = 0;
    const origPut = db.sync_metadata.put.bind(db.sync_metadata);
    vi.spyOn(db.sync_metadata, 'put').mockImplementation(((item: any, key?: any) => {
      putCallCount++;
      // Call 1 is markSyncing before push; Call 2 is post-push acknowledgement!
      if (putCallCount === 2) {
        return Promise.reject(new Error('Simulated IndexedDB crash mid-ack'));
      }
      return origPut(item, key);
    }) as any);

    await syncEngine.triggerSync(userId);

    // ATOMIC INVARIANT: Because sync_metadata.put threw during post-push ack,
    // the outbox entry MUST NOT have been deleted!
    const stillInOutbox = await outboxRepo.getById(entry.id);
    expect(stillInOutbox).toBeDefined();

    syncEngine.destroy();
    coordinator.destroy();
  });

  it('3. S-02: rolls back outbox blocked transition atomically if conflict table write throws mid-transaction', async () => {
    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);
    const docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);

    await docRepo.applyRemoteSnapshot({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      userId,
      projectId,
      title: 'Atomic Conflict Doc',
      content: 'v1',
      serverVersion: '1',
    });
    await docRepo.update('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { content: 'Local edit' });
    const [entry] = await outboxRepo.listByEntity(
      userId,
      'document',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );

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
      rpc: vi.fn(async () => ({
        data: {
          status: 'conflict',
          reason: 'version_mismatch',
          current_version: 2,
          current_row: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', content: 'Remote v2', version: 2 },
        },
        error: null,
      })),
    };

    vi.spyOn(db.conflicts, 'add').mockImplementationOnce(
      () => Promise.reject(new Error('Simulated IndexedDB crash writing conflict')) as any,
    );

    const coordinator = new TabCoordinator({ channelName: `conf-atomic-${Date.now()}` });
    vi.spyOn(coordinator, 'isLeaderTab').mockReturnValue(true);

    const syncEngine = new SyncEngine({
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
      pullEngine: new PullEngine({ supabaseClient: mockSupabase, db }),
      tabCoordinator: coordinator,
    });

    await syncEngine.triggerSync(userId);

    // ATOMIC INVARIANT: Entry must NOT be stranded in 'blocked' state with zero ConflictRecord!
    const afterCrash = await outboxRepo.getById(entry.id);
    expect(afterCrash?.state).not.toBe('blocked');
    expect(await conflictRepo.listUnresolved(userId)).toHaveLength(0);

    syncEngine.destroy();
    coordinator.destroy();
  });

  it('4. S-05: fences out zombie leader Tab A when lease expired and Tab B already reclaimed/completed or blocked the entry', async () => {
    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);
    const docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);

    // Subcase A: Zombie Tab A fails with timeout AFTER Tab B already completed the push!
    const doc1 = await docRepo.create({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      userId,
      projectId,
      title: 'Fenced Doc 1',
      content: 'v1',
    });

    let rejectTabA!: (err: Error) => void;
    const tabAPushEntered = new Promise<void>((resolve) => {
      (globalThis as any).__tabAEntered = resolve;
    });

    const supabaseTabA = {
      from: () => ({}),
      rpc: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            (globalThis as any).__tabAEntered();
            rejectTabA = reject;
          }),
      ),
    };

    const supabaseTabB = {
      from: () => ({}),
      rpc: vi.fn(async () => ({
        data: { status: 'applied', version: 1, updated_at: '2026-11-01T12:10:00.000Z' },
        error: null,
      })),
    };

    const coordA = {
      isLeaderTab: () => true,
      getTabId: () => 'tab-A',
      requestLeaderSync: vi.fn(),
      onLeadershipChange: () => () => {},
      onSyncRequest: () => () => {},
    } as unknown as TabCoordinator;

    const coordB = {
      isLeaderTab: () => true,
      getTabId: () => 'tab-B',
      requestLeaderSync: vi.fn(),
      onLeadershipChange: () => () => {},
      onSyncRequest: () => () => {},
    } as unknown as TabCoordinator;

    const engineA = new SyncEngine({
      supabaseClient: supabaseTabA,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
      pullEngine: { pullAll: async () => ({ totalPulled: 0, finalCursor: 0 }) } as any,
      tabCoordinator: coordA,
    });

    const engineB = new SyncEngine({
      supabaseClient: supabaseTabB,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
      pullEngine: { pullAll: async () => ({ totalPulled: 0, finalCursor: 0 }) } as any,
      tabCoordinator: coordB,
    });

    const tabAPromise = engineA.triggerSync(userId);
    await tabAPushEntered;

    // Tab A's lease expires -> Tab B reclaims & pushes doc1 to 'synced' (version 1)
    await outboxRepo.recoverStaleLeases({ now: Date.now() + 60_000 });
    await engineB.triggerSync(userId);

    const metaAfterB = await syncMetadataRepo.get('document', doc1.id);
    expect(metaAfterB?.syncState).toBe('synced');
    expect(metaAfterB?.serverVersion).toBe('1');

    // Now Zombie Tab A wakes up and rejects with TimeoutError!
    // Must be fenced out — MUST NOT overwrite sync_metadata.syncState to 'error'!
    rejectTabA(new Error('Network transport request timed out'));
    await tabAPromise;

    const metaAfterZombieFail = await syncMetadataRepo.get('document', doc1.id);
    expect(metaAfterZombieFail?.syncState).toBe('synced');
    expect(metaAfterZombieFail?.serverVersion).toBe('1');

    // Subcase B: Zombie Tab A resolves with stale success AFTER Tab B reclaimed & recorded a 409 CONFLICT!
    await docRepo.update(doc1.id, { content: 'Local edit v2' });
    let resolveTabA2!: (val: any) => void;
    const tabA2Entered = new Promise<void>((resolve) => {
      (globalThis as any).__tabA2Entered = resolve;
    });
    supabaseTabA.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          (globalThis as any).__tabA2Entered();
          resolveTabA2 = resolve;
        }),
    );
    supabaseTabB.rpc.mockImplementationOnce(async () => ({
      data: {
        status: 'conflict',
        reason: 'version_mismatch',
        current_version: 9,
        current_row: { id: doc1.id, content: 'Remote v9', version: 9 },
      },
      error: null,
    }));

    const tabA2Promise = engineA.triggerSync(userId);
    await tabA2Entered;

    // Lease expires -> Tab B reclaims & records authoritative conflict (state='blocked', syncState='conflict')
    await outboxRepo.recoverStaleLeases({ now: Date.now() + 60_000 });
    await engineB.triggerSync(userId);

    expect((await syncMetadataRepo.get('document', doc1.id))?.syncState).toBe('conflict');
    expect(await conflictRepo.listUnresolved(userId)).toHaveLength(1);

    // Zombie Tab A resolves late with stale version 2 -> MUST BE FENCED OUT!
    resolveTabA2({
      data: { status: 'applied', version: 2, updated_at: '2026-11-01T12:11:00.000Z' },
      error: null,
    });
    await tabA2Promise;

    const [blockedEntry] = await outboxRepo.listByEntity(userId, 'document', doc1.id);
    expect(blockedEntry?.state).toBe('blocked');
    expect((await syncMetadataRepo.get('document', doc1.id))?.syncState).toBe('conflict');

    delete (globalThis as any).__tabAEntered;
    delete (globalThis as any).__tabA2Entered;
    engineA.destroy();
    engineB.destroy();
  });
});
