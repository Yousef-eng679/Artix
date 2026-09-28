import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Dexie from 'dexie';
import { ArtixDB, resetLocalDBForTesting } from '@/lib/local/db';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { TabCoordinator, resetTabCoordinatorsForTesting } from '@/lib/sync/tabCoordinator';
import { SyncEngine } from '@/lib/sync/syncEngine';
import { PullEngine } from '@/lib/sync/pullEngine';

describe('Phase C10: Concurrent Worker / Leader Correctness', () => {
  let db: ArtixDB;
  let outboxRepo: OutboxRepository;
  let metadataRepo: SyncMetadataRepository;
  let conflictRepo: ConflictRepository;
  let documentRepo: DocumentRepository;
  const userId = 'user-leader-worker-1';

  beforeEach(async () => {
    Dexie.dependencies.indexedDB = indexedDB;
    Dexie.dependencies.IDBKeyRange = IDBKeyRange;
    db = new ArtixDB(`artix_test_c10_${Date.now()}_${Math.random()}`);
    await db.open();

    outboxRepo = new OutboxRepository(db);
    metadataRepo = new SyncMetadataRepository(db);
    conflictRepo = new ConflictRepository(db);
    documentRepo = new DocumentRepository(db, outboxRepo, metadataRepo);
  });

  afterEach(async () => {
    resetTabCoordinatorsForTesting();
    if (db && db.isOpen()) {
      await db.delete();
    }
  });

  it('guarantees only leader pushes to cloud while standby tab delegates sync request', async () => {
    const channelName = `sync-test-channel-${Date.now()}`;
    const coordLeader = new TabCoordinator(channelName, 'scope-c10');
    const coordStandby = new TabCoordinator(channelName, 'scope-c10');

    coordLeader.setLeaderForTesting(true);
    coordStandby.setLeaderForTesting(false);

    let pushCountLeader = 0;
    let pushCountStandby = 0;

    const mockSupabaseLeader: any = {
      from: vi.fn((table: string) => {
        if (table === 'processed_mutations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ data: [], error: null }),
            insert: vi.fn().mockResolvedValue({ error: null }),
          };
        }
        return {
          insert: vi.fn().mockImplementation(() => {
            pushCountLeader++;
            return {
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'doc-standby-1', version: 1, updated_at: new Date().toISOString() },
                  error: null,
                }),
              }),
            };
          }),
          upsert: vi.fn().mockImplementation(() => {
            pushCountLeader++;
            return {
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'doc-standby-1', version: 1, updated_at: new Date().toISOString() },
                  error: null,
                }),
              }),
            };
          }),
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { id: 'doc-standby-1', version: 1, updated_at: new Date().toISOString() },
            error: null,
          }),
        };
      }),
    };

    const mockSupabaseStandby: any = {
      from: vi.fn(() => {
        pushCountStandby++;
        return {
          insert: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
      }),
    };

    const pullEngineLeader = new PullEngine({
      supabaseClient: mockSupabaseLeader,
      conflictRepo,
      syncMetadataRepo: metadataRepo,
    });
    vi.spyOn(pullEngineLeader, 'pullAll').mockResolvedValue(undefined as any);

    const pullEngineStandby = new PullEngine({
      supabaseClient: mockSupabaseStandby,
      conflictRepo,
      syncMetadataRepo: metadataRepo,
    });
    vi.spyOn(pullEngineStandby, 'pullAll').mockResolvedValue(undefined as any);

    const syncEngineLeader = new SyncEngine({
      supabaseClient: mockSupabaseLeader,
      outboxRepo,
      syncMetadataRepo: metadataRepo,
      conflictRepo,
      pullEngine: pullEngineLeader,
      tabCoordinator: coordLeader,
    });

    const syncEngineStandby = new SyncEngine({
      supabaseClient: mockSupabaseStandby,
      outboxRepo,
      syncMetadataRepo: metadataRepo,
      conflictRepo,
      pullEngine: pullEngineStandby,
      tabCoordinator: coordStandby,
    });

    // Standby tab creates document locally
    await documentRepo.create({
      id: 'doc-standby-1',
      title: 'Created by Standby Tab',
      content: 'Local first content',
      projectId: 'proj-1',
      userId,
    });

    const pendingBefore = await outboxRepo.getPending(undefined, userId);
    expect(pendingBefore).toHaveLength(1);

    // Standby tab triggers sync: should delegate to leader
    const requestSyncSpy = vi.spyOn(coordStandby, 'requestLeaderSync');
    await syncEngineStandby.triggerSync(userId);

    expect(requestSyncSpy).toHaveBeenCalled();
    expect(pushCountStandby).toBe(0);

    // Leader receives sync request and drains outbox
    await syncEngineLeader.triggerSync(userId);

    expect(pushCountLeader).toBeGreaterThanOrEqual(1);

    // Outbox is now drained
    const pendingAfter = await outboxRepo.getPending(undefined, userId);
    expect(pendingAfter).toHaveLength(0);

    // Metadata confirms synchronized state
    const meta = await metadataRepo.get('document', 'doc-standby-1', userId);
    expect(meta?.syncState).toBe('synced');
    expect(meta?.serverVersion).toBe('1');

    syncEngineLeader.destroy();
    syncEngineStandby.destroy();
    coordLeader.destroy();
    coordStandby.destroy();
  });

  it('immediately recovers orphaned in-flight leases without waiting for timeout when promoted to leader', async () => {
    // Simulate Tab A (crashed leader) claiming an entry for 30 seconds
    const mutationId = 'mut-crash-lease-1';
    await outboxRepo.enqueueInTx({
      mutationId,
      entityType: 'document',
      entityId: 'doc-lease-1',
      userId,
      projectId: 'proj-1',
      operation: 'update',
      baseServerVersion: '1',
      localRevision: 2,
      payload: { title: 'Updated Title' },
    });

    const [entry] = await outboxRepo.getPending(undefined, userId);
    expect(entry).toBeDefined();

    // Tab A claims lease for 30,000 ms into the future
    await outboxRepo.markInFlight(entry.id, 'crashed-tab-A', 30000);

    const inFlightBefore = await outboxRepo.getInFlight(userId);
    expect(inFlightBefore).toHaveLength(1);
    expect(inFlightBefore[0].leaseOwner).toBe('crashed-tab-A');
    expect(inFlightBefore[0].leaseExpiresAt).toBeGreaterThan(Date.now() + 20000);

    // Tab B becomes leader
    const tabBId = 'promoted-tab-B';
    const recovered = await outboxRepo.recoverStaleLeases({
      currentTabId: tabBId,
      forceOrphanedByOtherTabs: true,
      now: Date.now(), // Real timestamp, lease is NOT naturally expired
    });

    expect(recovered).toBe(1);

    // Verify entry is immediately restored to pending with cleared lease
    const inFlightAfter = await outboxRepo.getInFlight(userId);
    expect(inFlightAfter).toHaveLength(0);

    const pendingRestored = await outboxRepo.getPending(undefined, userId);
    expect(pendingRestored).toHaveLength(1);
    expect(pendingRestored[0].state).toBe('pending');
    expect(pendingRestored[0].leaseOwner).toBeNull();
    expect(pendingRestored[0].leaseExpiresAt).toBeNull();
  });

  it('achieves exactly-once logical effect when leader crashes after server commit and new leader retries', async () => {
    const mutationId = 'mut-failover-post-commit-1';

    // Seed document locally
    await db.documents.put({
      id: 'doc-failover-1',
      title: 'Original Title',
      content: 'Original',
      projectId: 'proj-1',
      userId,
      folderId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await metadataRepo.upsert({
      entityType: 'document',
      entityId: 'doc-failover-1',
      userId,
      serverVersion: '1',
      syncState: 'synced',
    });

    // Enqueue an update mutation
    await outboxRepo.enqueueInTx({
      mutationId,
      entityType: 'document',
      entityId: 'doc-failover-1',
      userId,
      projectId: 'proj-1',
      operation: 'update',
      baseServerVersion: '1',
      localRevision: 2,
      payload: { title: 'Updated After Crash', content: 'Updated' },
    });

    const [entry] = await outboxRepo.getPending(undefined, userId);
    // Tab A claims lease
    await outboxRepo.markInFlight(entry.id, 'tab-A-crashed', 30000);

    // Mock server state: server already recorded the mutation in processed_mutations
    // simulating Tab A crashing right after the server committed
    const processedMutationsLedger = new Map<string, any>();
    processedMutationsLedger.set(mutationId, {
      mutation_id: mutationId,
      entity_type: 'document',
      entity_id: 'doc-failover-1',
      user_id: userId,
      version: 2,
      updated_at: '2026-09-28T14:30:00.000Z',
    });

    let serverCommitExecutionCount = 0;

    const mockSupabaseTabB: any = {
      from: vi.fn((table: string) => {
        if (table === 'processed_mutations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockImplementation((_col: string, val: string) => {
              const record = processedMutationsLedger.get(val);
              return {
                maybeSingle: vi.fn().mockResolvedValue({
                  data: record
                    ? {
                        mutation_id: record.mutation_id,
                        version: record.version,
                        updated_at: record.updated_at,
                      }
                    : null,
                  error: null,
                }),
                single: vi.fn().mockResolvedValue({
                  data: record
                    ? {
                        mutation_id: record.mutation_id,
                        version: record.version,
                        updated_at: record.updated_at,
                      }
                    : null,
                  error: null,
                }),
              };
            }),
            insert: vi.fn().mockResolvedValue({ error: null }),
            upsert: vi.fn().mockResolvedValue({ error: null }),
          };
        }
        if (table === 'documents') {
          return {
            update: vi.fn().mockImplementation(() => {
              serverCommitExecutionCount++;
              return {
                eq: vi.fn().mockReturnThis(),
                select: vi.fn().mockReturnThis(),
                single: vi.fn().mockResolvedValue({
                  data: { id: 'doc-failover-1', version: 2, updated_at: '2026-09-28T14:30:00.000Z' },
                  error: null,
                }),
              };
            }),
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: { id: 'doc-failover-1', version: 2, updated_at: '2026-09-28T14:30:00.000Z' },
              error: null,
            }),
          };
        }
        return {};
      }),
    };

    const coordTabB = new TabCoordinator('test-failover-channel', 'scope-failover');
    coordTabB.setLeaderForTesting(true);

    const pullEngineTabB = new PullEngine({
      supabaseClient: mockSupabaseTabB,
      conflictRepo,
      syncMetadataRepo: metadataRepo,
    });
    vi.spyOn(pullEngineTabB, 'pullAll').mockResolvedValue(undefined as any);

    const syncEngineTabB = new SyncEngine({
      supabaseClient: mockSupabaseTabB,
      outboxRepo,
      syncMetadataRepo: metadataRepo,
      conflictRepo,
      pullEngine: pullEngineTabB,
      tabCoordinator: coordTabB,
    });

    // Tab B drains outbox: it will recover the orphaned lease and push mutationId
    await syncEngineTabB.triggerSync(userId);

    // Because the server had already processed mutationId, the push adapter returned
    // the recorded version without re-executing a physical mutation on documents
    expect(serverCommitExecutionCount).toBe(0);

    // Outbox is marked completed
    const pendingAfter = await outboxRepo.getPending(undefined, userId);
    expect(pendingAfter).toHaveLength(0);

    // Metadata is acknowledged with version 2
    const metaAfter = await metadataRepo.get('document', 'doc-failover-1', userId);
    expect(metaAfter?.syncState).toBe('synced');
    expect(metaAfter?.serverVersion).toBe('2');

    syncEngineTabB.destroy();
    coordTabB.destroy();
  });

  it('notifies subscribers immediately when leadership state changes', () => {
    const coordinator = new TabCoordinator('leadership-notif-channel', 'scope-notif');
    coordinator.setLeaderForTesting(false);

    const leadershipSpy = vi.fn();
    const unsub = coordinator.onLeadershipChange(leadershipSpy);

    // Promote to leader
    coordinator.setLeaderForTesting(true);
    expect(leadershipSpy).toHaveBeenCalledWith(true);

    // Demote
    coordinator.setLeaderForTesting(false);
    expect(leadershipSpy).toHaveBeenCalledWith(false);

    unsub();
    coordinator.setLeaderForTesting(true);
    expect(leadershipSpy).toHaveBeenCalledTimes(2);

    coordinator.destroy();
  });
});
