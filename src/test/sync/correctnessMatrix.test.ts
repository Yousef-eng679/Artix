import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Dexie from 'dexie';
import {
  ArtixDB,
  closeAllArtixDBs,
  deleteArtixDB,
} from '@/lib/local/db';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { SyncEngine } from '@/lib/sync/syncEngine';
import { PullEngine } from '@/lib/sync/pullEngine';
import { TabCoordinator, resetTabCoordinatorsForTesting } from '@/lib/sync/tabCoordinator';
import {
  openUserRuntime,
  closeUserRuntime,
} from '@/lib/sync/userSyncRuntime';
import { TombstoneManager } from '@/lib/sync/tombstoneManager';

describe('Phase C12: Correctness Test Matrix (Scenarios A through J)', () => {
  beforeEach(() => {
    Dexie.dependencies.indexedDB = indexedDB;
    Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  });

  afterEach(async () => {
    resetTabCoordinatorsForTesting();
    await closeUserRuntime();
    await closeAllArtixDBs();
  });

  // =========================================================================
  // SCENARIO A: Local Durability (Offline create -> edit -> reload/restart)
  // =========================================================================
  it('Scenario A: Local durability guarantees offline mutations survive simulated restart', async () => {
    const dbName = `artix_test_matrix_scen_a_${Date.now()}`;
    const userId = 'user-matrix-a';

    // 1. Session 1: Create and edit offline
    const db1 = new ArtixDB(dbName);
    await db1.open();
    const outbox1 = new OutboxRepository(db1);
    const meta1 = new SyncMetadataRepository(db1);
    const docRepo1 = new DocumentRepository(db1, outbox1, meta1);

    await docRepo1.create({
      id: 'doc-durability-1',
      title: 'Initial Draft',
      content: 'Offline content',
      projectId: 'proj-a',
      userId,
    });

    await docRepo1.update('doc-durability-1', {
      title: 'Edited Draft While Offline',
      content: 'Updated content',
    }, userId);

    // Verify state in session 1
    const docSession1 = await docRepo1.getById('doc-durability-1');
    expect(docSession1?.title).toBe('Edited Draft While Offline');
    expect(docSession1?.localRevision).toBe(2);

    const pendingSession1 = await outbox1.getPending(undefined, userId);
    expect(pendingSession1).toHaveLength(1);
    expect((pendingSession1[0].payload as any).title).toBe('Edited Draft While Offline');

    // 2. Simulate complete browser restart: close db1
    await db1.close();

    // 3. Session 2: Re-open database from disk
    const db2 = new ArtixDB(dbName);
    await db2.open();
    const outbox2 = new OutboxRepository(db2);
    const meta2 = new SyncMetadataRepository(db2);
    const docRepo2 = new DocumentRepository(db2, outbox2, meta2);

    const docSession2 = await docRepo2.getById('doc-durability-1');
    expect(docSession2).toBeDefined();
    expect(docSession2?.title).toBe('Edited Draft While Offline');
    expect(docSession2?.localRevision).toBe(2);

    const pendingSession2 = await outbox2.getPending(undefined, userId);
    expect(pendingSession2).toHaveLength(1);
    expect(pendingSession2[0].localRevision).toBe(2);

    await db2.delete();
  });

  // =========================================================================
  // SCENARIO B: Ambiguous Remote Result & Idempotent Retry
  // =========================================================================
  it('Scenario B: Ambiguous remote outcome succeeds idempotently on retry without duplication', async () => {
    const dbName = `artix_test_matrix_scen_b_${Date.now()}`;
    const userId = 'user-matrix-b';
    const db = new ArtixDB(dbName);
    await db.open();

    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);
    const docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);

    // Create document locally
    await docRepo.create({
      id: 'doc-ambiguous-1',
      title: 'Ambiguous Push Doc',
      content: 'Payload',
      projectId: 'proj-b',
      userId,
    });

    const [entry] = await outboxRepo.getPending(undefined, userId);
    const stableMutationId = entry.mutationId;
    expect(stableMutationId).toBeDefined();

    // Simulate Server Ledger
    const serverProcessedLedger = new Map<string, any>();
    let serverInsertCount = 0;

    const mockSupabase: any = {
      from: vi.fn((table: string) => {
        if (table === 'processed_mutations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockImplementation((_col: string, val: string) => {
              const record = serverProcessedLedger.get(val);
              return {
                maybeSingle: vi.fn().mockResolvedValue({
                  data: record ? {
                    mutation_id: record.mutation_id,
                    version: record.version,
                    updated_at: record.updated_at,
                  } : null,
                  error: null,
                }),
                single: vi.fn().mockResolvedValue({
                  data: record ? {
                    mutation_id: record.mutation_id,
                    version: record.version,
                    updated_at: record.updated_at,
                  } : null,
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
            upsert: vi.fn().mockImplementation(() => {
              serverInsertCount++;
              serverProcessedLedger.set(stableMutationId, {
                mutation_id: stableMutationId,
                version: 1,
                updated_at: new Date().toISOString(),
              });
              return {
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'doc-ambiguous-1', version: 1, updated_at: new Date().toISOString() },
                    error: null,
                  }),
                }),
              };
            }),
          };
        }
        return {};
      }),
    };

    const pullEngine = new PullEngine({
      supabaseClient: mockSupabase,
      conflictRepo,
      syncMetadataRepo,
    });
    vi.spyOn(pullEngine, 'pullAll').mockResolvedValue(undefined as any);

    const syncEngine = new SyncEngine({
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
      pullEngine,
    });

    // Simulate response lost after server commit: ledger already has it
    serverProcessedLedger.set(stableMutationId, {
      mutation_id: stableMutationId,
      version: 1,
      updated_at: new Date().toISOString(),
    });

    // Pass 2: Retry with exact same mutationId
    await syncEngine.triggerSync(userId);

    // Idempotent execution: physical upsert on documents was skipped
    expect(serverInsertCount).toBe(0);

    // Outbox was cleanly drained
    const pendingAfter = await outboxRepo.getPending(undefined, userId);
    expect(pendingAfter).toHaveLength(0);

    const meta = await syncMetadataRepo.get('document', 'doc-ambiguous-1', userId);
    expect(meta?.syncState).toBe('synced');
    expect(meta?.serverVersion).toBe('1');

    syncEngine.destroy();
    await db.delete();
  });

  // =========================================================================
  // SCENARIO C: Concurrent Edit & CAS Baseline Guard
  // =========================================================================
  it('Scenario C: Concurrent edits across devices detect version mismatch and throw 409 conflict', async () => {
    const dbName = `artix_test_matrix_scen_c_${Date.now()}`;
    const userId = 'user-matrix-c';
    const db = new ArtixDB(dbName);
    await db.open();

    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);
    const docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);

    // Device B has document seeded with baseline version 10
    await docRepo.applyRemoteSnapshot({
      id: 'doc-concurrent-1',
      title: 'Branch B Edit',
      content: 'Device B content',
      projectId: 'proj-c',
      userId,
      serverVersion: '10',
      updatedAt: '2026-09-28T12:00:00Z',
    });

    // User updates locally -> enqueues mutation with baseServerVersion 10
    await docRepo.update('doc-concurrent-1', { title: 'Branch B Modified' }, userId);

    const remoteServerRow = {
      id: 'doc-concurrent-1',
      version: 11,
      title: 'Device A Modified Concurrently',
      content: 'Content from Device A',
      updated_at: '2026-09-28T12:30:00Z',
    };

    // Server has already moved forward to version 11
    const createChain = (isMismatch: boolean): any => ({
      eq: vi.fn().mockImplementation((col: string, val: any) => {
        if (col === 'version' && val === 10) {
          return createChain(true);
        }
        return createChain(isMismatch);
      }),
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockImplementation(() => {
          if (isMismatch) {
            return Promise.resolve({
              data: null,
              error: null,
            });
          }
          return Promise.resolve({
            data: { id: 'doc-concurrent-1', version: 10, updated_at: new Date().toISOString() },
            error: null,
          });
        }),
      }),
    });

    const mockSupabase: any = {
      from: vi.fn((table: string) => {
        if (table === 'processed_mutations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          };
        }
        if (table === 'documents') {
          return {
            update: vi.fn().mockReturnValue(createChain(false)),
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: remoteServerRow,
              error: null,
            }),
          };
        }
        return {};
      }),
    };

    const syncEngine = new SyncEngine({
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
    });

    // Device B attempts to push: rejected by CAS mismatch
    await syncEngine.triggerSync(userId);

    // Verify outbox entry was classified as blocked
    const allEntries = await db.outbox.toArray();
    expect(allEntries[0].state).toBe('blocked');

    // 3-way conflict recorded
    const conflicts = await conflictRepo.listByEntity('document', 'doc-concurrent-1', userId);
    expect(conflicts.length).toBe(1);

    syncEngine.destroy();
    await db.delete();
  });

  // =========================================================================
  // SCENARIO D: Local Edit During Push (Revision Safety)
  // =========================================================================
  it('Scenario D: Acknowledgement for revision N does not overwrite newer local revision N+1', async () => {
    const dbName = `artix_test_matrix_scen_d_${Date.now()}`;
    const userId = 'user-matrix-d';
    const db = new ArtixDB(dbName);
    await db.open();

    const syncMetadataRepo = new SyncMetadataRepository(db);

    // Entity is currently at revision 11 locally
    await syncMetadataRepo.upsert({
      entityType: 'document',
      entityId: 'doc-racing-1',
      userId,
      serverVersion: '1',
      syncState: 'pending',
      localRevision: 11,
    });

    // In-flight push was started for revision 10. Ack for revision 10 now arrives.
    const { isFullySynced } = await syncMetadataRepo.acknowledgePush({
      entityType: 'document',
      entityId: 'doc-racing-1',
      userId,
      ackLocalRevision: 10, // Stale ack
      serverVersion: '2',
      serverUpdatedAt: new Date().toISOString(),
    });

    // Must NOT mark entity as fully synced
    expect(isFullySynced).toBe(false);

    // Local state remains pending for revision 11, with baseline updated to server version 2
    const meta = await syncMetadataRepo.get('document', 'doc-racing-1', userId);
    expect(meta?.syncState).toBe('pending');
    expect(meta?.localRevision).toBe(11);
    expect(meta?.serverVersion).toBe('2');

    await db.delete();
  });

  // =========================================================================
  // SCENARIO E: Remote Stale Snapshot Rejection
  // =========================================================================
  it('Scenario E: Stale remote snapshot arriving via pull does not overwrite pending local work', async () => {
    const dbName = `artix_test_matrix_scen_e_${Date.now()}`;
    const userId = 'user-matrix-e';
    const db = new ArtixDB(dbName);
    await db.open();

    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);
    const docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);

    // Seed document with local pending edit
    await docRepo.create({
      id: 'doc-stale-pull-1',
      title: 'Local Pending Title',
      content: 'Important unsaved local work',
      projectId: 'proj-e',
      userId,
    });

    // Establish baseline at version 2
    await syncMetadataRepo.upsert({
      entityType: 'document',
      entityId: 'doc-stale-pull-1',
      userId,
      serverVersion: '2',
      syncState: 'pending',
    });

    // Stale snapshot arriving from server feed with version 1 (older than baseline version 2)
    const staleChangeFeed = [
      {
        sequence: 1,
        user_id: userId,
        entity_type: 'document',
        entity_id: 'doc-stale-pull-1',
        operation: 'update',
        entity_version: 1,
        payload: {
          id: 'doc-stale-pull-1',
          title: 'Old Server Title v1',
          content: 'Old remote content',
          user_id: userId,
          project_id: 'proj-e',
          version: 1,
          updated_at: '2026-09-28T00:00:00.000Z',
        },
        changed_at: '2026-09-28T00:00:00.000Z',
      },
    ];

    const mockSupabase: any = {
      from: vi.fn((table: string) => {
        if (table === 'sync_changes') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: staleChangeFeed,
              error: null,
            }),
          };
        }
        return {};
      }),
    };

    const pullEngine = new PullEngine({
      supabaseClient: mockSupabase,
      db,
      documentRepo: docRepo,
      conflictRepo,
      syncMetadataRepo,
    });

    // Pull Engine pulls and processes feed batch
    await pullEngine.pullBatch(userId);

    // Verify local document was NOT overwritten by stale server version
    const docAfter = await docRepo.getById('doc-stale-pull-1');
    expect(docAfter?.title).toBe('Local Pending Title');
    expect(docAfter?.content).toBe('Important unsaved local work');

    await db.delete();
  });

  // =========================================================================
  // SCENARIO F: Remote Delete Reconnection
  // =========================================================================
  it('Scenario F: Remote delete arriving while client is offline reconciles into confirmed tombstone', async () => {
    const dbName = `artix_test_matrix_scen_f_${Date.now()}`;
    const userId = 'user-matrix-f';
    const db = new ArtixDB(dbName);
    await db.open();

    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);
    const docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);

    // Document was synced at version 3
    await docRepo.applyRemoteSnapshot({
      id: 'doc-remote-del-1',
      title: 'Document on Server',
      content: 'To be deleted remotely',
      projectId: 'proj-f',
      userId,
      serverVersion: '3',
      updatedAt: '2026-09-28T10:00:00Z',
    });

    // Client reconnects: remote delete event arrives from sync_changes feed
    const remoteDeleteFeed = [
      {
        sequence: 15,
        user_id: userId,
        entity_type: 'document',
        entity_id: 'doc-remote-del-1',
        operation: 'delete',
        entity_version: 4,
        payload: { id: 'doc-remote-del-1' },
        changed_at: '2026-09-28T12:00:00Z',
      },
    ];

    const mockSupabase: any = {
      from: vi.fn((table: string) => {
        if (table === 'sync_changes') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: remoteDeleteFeed,
              error: null,
            }),
          };
        }
        return {};
      }),
    };

    const pullEngine = new PullEngine({
      supabaseClient: mockSupabase,
      db,
      documentRepo: docRepo,
      conflictRepo,
      syncMetadataRepo,
    });

    await pullEngine.pullBatch(userId);

    // Document is soft deleted locally
    const docAfter = await docRepo.getById('doc-remote-del-1');
    expect(docAfter).toBeNull(); // getById excludes soft-deleted

    const docWithDeleted = await docRepo.getByIdIncludeDeleted('doc-remote-del-1');
    expect(docWithDeleted?.isDeleted).toBe(true);

    const metaAfter = await syncMetadataRepo.get('document', 'doc-remote-del-1', userId);
    expect(metaAfter?.syncState).toBe('deleted_synced');
    expect(metaAfter?.serverVersion).toBe('4');

    // Tombstone classification confirms REMOTE_CONFIRMED_DELETE
    const tombstoneMgr = new TombstoneManager(db);
    const classification = await tombstoneMgr.getTombstoneState('document', 'doc-remote-del-1', userId);
    expect(classification).toBe('REMOTE_CONFIRMED_DELETE');

    await db.delete();
  });

  // =========================================================================
  // SCENARIO G: Leader Crash Mid-Push Failover
  // =========================================================================
  it('Scenario G: Leader crash mid-push immediately transfers orphaned leases to standby upon takeover', async () => {
    const dbName = `artix_test_matrix_scen_g_${Date.now()}`;
    const userId = 'user-matrix-g';
    const db = new ArtixDB(dbName);
    await db.open();

    const outboxRepo = new OutboxRepository(db);

    // Leader Tab A enqueues and claims mutation
    await outboxRepo.enqueueInTx({
      mutationId: 'mut-leader-crash-1',
      entityType: 'document',
      entityId: 'doc-crash-1',
      userId,
      projectId: 'proj-g',
      operation: 'create',
      baseServerVersion: null,
      localRevision: 1,
      payload: { title: 'Leader Crash Doc' },
    });

    const [entry] = await outboxRepo.getPending(undefined, userId);
    // Tab A claims lease for 30s
    await outboxRepo.markInFlight(entry.id, 'leader-tab-A', 30000);

    // Leader Tab A crashes!
    // Standby Tab B is elected leader
    const tabBId = 'standby-promoted-to-leader-tab-B';
    const recovered = await outboxRepo.recoverStaleLeases({
      currentTabId: tabBId,
      forceOrphanedByOtherTabs: true,
      now: Date.now(), // Real time, no waiting 30s
    });

    expect(recovered).toBe(1);

    const [restoredEntry] = await outboxRepo.getPending(undefined, userId);
    expect(restoredEntry.state).toBe('pending');
    expect(restoredEntry.leaseOwner).toBeNull();
    expect(restoredEntry.leaseExpiresAt).toBeNull();

    await db.delete();
  });

  // =========================================================================
  // SCENARIO H: Account Switch Lifecycle & Data Isolation
  // =========================================================================
  it('Scenario H: Account switch cleanly shuts down User A runtime and establishes isolated User B runtime', async () => {
    const userAId = 'user-matrix-h-alice';
    const userBId = 'user-matrix-h-bob';

    // 1. User Alice logs in
    const runtimeAlice = await openUserRuntime(userAId);
    expect(runtimeAlice.isActive()).toBe(true);
    expect(runtimeAlice.userId).toBe(userAId);

    // Alice creates document
    await runtimeAlice.documentRepo.create({
      id: 'doc-alice-secret',
      title: 'Alice Private Document',
      content: 'Alice secret notes',
      projectId: 'proj-alice',
      userId: userAId,
    });

    const aliceDocs = await runtimeAlice.documentRepo.listByProject(userAId, 'proj-alice');
    expect(aliceDocs).toHaveLength(1);
    expect(aliceDocs[0].id).toBe('doc-alice-secret');

    // 2. Switch account: Bob logs in
    const runtimeBob = await openUserRuntime(userBId);
    expect(runtimeBob.isActive()).toBe(true);
    expect(runtimeBob.userId).toBe(userBId);

    // Alice's runtime was stopped
    expect(runtimeAlice.isActive()).toBe(false);

    // Bob cannot see Alice's document (Strict User Isolation)
    const bobDocs = await runtimeBob.documentRepo.listByProject(userBId, 'proj-alice');
    expect(bobDocs).toHaveLength(0);

    const bobAliceDocQuery = await runtimeBob.documentRepo.getById('doc-alice-secret');
    expect(bobAliceDocQuery).toBeNull();

    await closeUserRuntime();
  });

  // =========================================================================
  // SCENARIO I: Realtime Independence
  // =========================================================================
  it('Scenario I: System converges via cursor-based pull when Realtime is completely offline', async () => {
    const dbName = `artix_test_matrix_scen_i_${Date.now()}`;
    const userId = 'user-matrix-i';
    const db = new ArtixDB(dbName);
    await db.open();

    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);
    const docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);

    // Mock remote change feed with a pending server event
    const serverChanges = [
      {
        sequence: 101,
        user_id: userId,
        entity_type: 'document',
        entity_id: 'doc-feed-1',
        operation: 'create',
        entity_version: 1,
        payload: {
          id: 'doc-feed-1',
          title: 'Remote Feed Document',
          content: 'Pulled via cursor',
          user_id: userId,
          project_id: 'proj-i',
          version: 1,
          updated_at: new Date().toISOString(),
        },
        changed_at: new Date().toISOString(),
      },
    ];

    const mockSupabase: any = {
      from: vi.fn((table: string) => {
        if (table === 'sync_changes') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: serverChanges,
              error: null,
            }),
          };
        }
        return {};
      }),
    };

    const pullEngine = new PullEngine({
      supabaseClient: mockSupabase,
      db,
      documentRepo: docRepo,
      conflictRepo,
      syncMetadataRepo,
    });

    // Realtime is completely disabled. System executes cursor pull directly.
    const result = await pullEngine.pullBatch(userId);
    expect(result.pulledCount).toBe(1);
    expect(result.newCursor).toBe(101);

    // Document was converged into local database
    const localDoc = await docRepo.getById('doc-feed-1');
    expect(localDoc).toBeDefined();
    expect(localDoc?.title).toBe('Remote Feed Document');

    await db.delete();
  });

  // =========================================================================
  // SCENARIO J: Duplicate Event Deduplication
  // =========================================================================
  it('Scenario J: Repeated delivery of identical server changes is deduplicated without redundant mutations', async () => {
    const dbName = `artix_test_matrix_scen_j_${Date.now()}`;
    const userId = 'user-matrix-j';
    const db = new ArtixDB(dbName);
    await db.open();

    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);
    const docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);

    const duplicateEvents = [
      {
        sequence: 50,
        user_id: userId,
        entity_type: 'document' as const,
        entity_id: 'doc-dup-1',
        operation: 'create' as const,
        entity_version: 5,
        payload: {
          id: 'doc-dup-1',
          title: 'Original Title',
          content: 'Original Content',
          user_id: userId,
          project_id: 'proj-j',
          version: 5,
          updated_at: new Date().toISOString(),
        },
        changed_at: new Date().toISOString(),
      },
    ];

    const mockSupabase: any = {
      from: vi.fn((table: string) => {
        if (table === 'sync_changes') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockImplementation((col: string, val: number) => {
              // Cursor filter: only return changes with sequence > val
              const eligible = duplicateEvents.filter((e) => e.sequence > val);
              return {
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: eligible,
                    error: null,
                  }),
                }),
              };
            }),
          };
        }
        return {};
      }),
    };

    const pullEngine = new PullEngine({
      supabaseClient: mockSupabase,
      db,
      documentRepo: docRepo,
      conflictRepo,
      syncMetadataRepo,
    });

    // First arrival: applied cleanly, cursor advances to 50
    const pass1 = await pullEngine.pullBatch(userId);
    expect(pass1.pulledCount).toBe(1);
    expect(pass1.newCursor).toBe(50);

    const docFirstPass = await docRepo.getById('doc-dup-1');
    expect(docFirstPass?.title).toBe('Original Title');
    const localRevFirstPass = docFirstPass?.localRevision;

    // Second arrival: exact same event delivered from server feed
    const pass2 = await pullEngine.pullBatch(userId);
    expect(pass2.pulledCount).toBe(0); // Cursor filter suppressed duplicate!

    // Verify local revision did not churn or increment redundantly
    const docSecondPass = await docRepo.getById('doc-dup-1');
    expect(docSecondPass?.localRevision).toBe(localRevFirstPass);
    expect(docSecondPass?.title).toBe('Original Title');

    // No conflicts or phantom outbox items were created
    const conflicts = await conflictRepo.listUnresolved(userId);
    expect(conflicts).toHaveLength(0);

    await db.delete();
  });
});
