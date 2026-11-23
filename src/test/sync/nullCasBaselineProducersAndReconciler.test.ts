import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ArtixDB, deleteArtixDB, getArtixDB, migrateLegacyArtixDB } from '@/lib/local/db';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { SystemDesignRepository } from '@/lib/repositories/systemDesignRepository';
import { WorkspaceFolderRepository } from '@/lib/repositories/folderRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { SyncEngine } from '@/lib/sync/syncEngine';
import { createTabCloseGuard } from '@/lib/cache/tabCloseGuard';

describe('TASK-03: Null-CAS Baseline Producer Elimination, Pre-Push Reconciler & Local TabCloseGuard (C-03, OF-14)', () => {
  let db: ArtixDB;
  let outboxRepo: OutboxRepository;
  let syncMetadataRepo: SyncMetadataRepository;
  let conflictRepo: ConflictRepository;
  let docRepo: DocumentRepository;
  let designRepo: SystemDesignRepository;
  let folderRepo: WorkspaceFolderRepository;

  const userId = 'user-task-03';
  const projectId = 'proj-task-03';

  beforeEach(async () => {
    db = new ArtixDB(`TestDB_Task03_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    await db.open();
    outboxRepo = new OutboxRepository(db);
    syncMetadataRepo = new SyncMetadataRepository(db);
    conflictRepo = new ConflictRepository(db);
    docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);
    designRepo = new SystemDesignRepository(db, outboxRepo, syncMetadataRepo);
    folderRepo = new WorkspaceFolderRepository(db, outboxRepo, syncMetadataRepo);
    localStorage.clear();
  });

  afterEach(async () => {
    await db.delete();
    await deleteArtixDB('ArtixDB');
    vi.restoreAllMocks();
  });

  it('1. DocumentRepository.restore and SystemDesignRepository.restore propagate serverVersion or convert unpushed/remotely-deleted entities to create', async () => {
    // Case A: Synced document at v5 soft-deleted locally (pending delete in outbox), then restored before push
    await docRepo.applyRemoteSnapshot({
      id: 'doc-restore-v5',
      userId,
      projectId,
      title: 'Synced Spec',
      content: 'Spec v5',
      serverVersion: '5',
      updatedAt: '2026-11-01T10:00:00Z',
    });
    await docRepo.delete('doc-restore-v5');
    // Simulate outbox cleared or separate restore while server still has v5:
    await outboxRepo.clear(userId);
    await docRepo.restore('doc-restore-v5');

    const docPending = await outboxRepo.getPending(undefined, userId);
    expect(docPending).toHaveLength(1);
    expect(docPending[0].operation).toBe('update');
    expect(docPending[0].baseServerVersion).toBe('5');

    // Case B: Synced system design at v8 soft-deleted locally, outbox cleared, then restored while server has v8
    await outboxRepo.clear(userId);
    await designRepo.applyRemoteSnapshot({
      id: 'design-restore-v8',
      userId,
      projectId,
      name: 'Arch v8',
      serverVersion: '8',
      updatedAt: '2026-11-01T10:00:00Z',
    });
    await designRepo.delete('design-restore-v8');
    await outboxRepo.clear(userId);
    await designRepo.restore('design-restore-v8');

    const designPending = await outboxRepo.getPending(undefined, userId);
    expect(designPending).toHaveLength(1);
    expect(designPending[0].operation).toBe('update');
    expect(designPending[0].baseServerVersion).toBe('8');

    // Case C: Offline-created document deleted offline (create+delete cancelled -> serverVersion is null), then restored!
    await outboxRepo.clear(userId);
    const offlineDoc = await docRepo.create({
      userId,
      projectId,
      title: 'Born Offline',
      content: 'Draft',
    });
    await docRepo.delete(offlineDoc.id); // cancels create -> 0 outbox entries, serverVersion null
    expect(await outboxRepo.countPending(userId)).toBe(0);

    await docRepo.restore(offlineDoc.id);
    const offlineRestoredPending = await outboxRepo.getPending(undefined, userId);
    expect(offlineRestoredPending).toHaveLength(1);
    expect(offlineRestoredPending[0].operation).toBe('create');
    expect(offlineRestoredPending[0].baseServerVersion).toBeNull();

    // Case D: Remotely-confirmed deleted document (syncState = 'deleted_synced') restored locally -> must re-create!
    await outboxRepo.clear(userId);
    await syncMetadataRepo.upsert({
      entityType: 'document',
      entityId: 'doc-restore-v5',
      userId,
      syncState: 'deleted_synced',
      serverVersion: '6',
    });
    await db.documents.update('doc-restore-v5', { isDeleted: true });
    await docRepo.restore('doc-restore-v5');

    const resurrectedPending = await outboxRepo.getPending(undefined, userId);
    expect(resurrectedPending).toHaveLength(1);
    expect(resurrectedPending[0].operation).toBe('create');
    expect(resurrectedPending[0].baseServerVersion).toBeNull();
  });

  it('2. skipOutbox / applyRemoteSnapshot without serverVersion never wipes an existing valid sync_metadata.serverVersion', async () => {
    await docRepo.applyRemoteSnapshot({
      id: 'doc-keep-ver',
      userId,
      projectId,
      title: 'Original',
      content: 'v4 content',
      serverVersion: '4',
      updatedAt: '2026-11-01T10:00:00Z',
    });
    await designRepo.applyRemoteSnapshot({
      id: 'design-keep-ver',
      userId,
      projectId,
      name: 'Design Original',
      serverVersion: '9',
      updatedAt: '2026-11-01T10:00:00Z',
    });
    await folderRepo.applyRemoteSnapshot({
      id: 'folder-keep-ver',
      userId,
      projectId,
      name: 'Folder Original',
      serverVersion: '3',
      updatedAt: '2026-11-01T10:00:00Z',
    });

    await docRepo.update('doc-keep-ver', { title: 'Silent Local Refresh' }, { skipOutbox: true });
    await designRepo.update('design-keep-ver', { name: 'Silent Design Refresh' }, { skipOutbox: true });
    await folderRepo.rename('folder-keep-ver', 'Silent Folder Refresh', { skipOutbox: true });

    expect((await syncMetadataRepo.get('document', 'doc-keep-ver'))?.serverVersion).toBe('4');
    expect((await syncMetadataRepo.get('system_design', 'design-keep-ver'))?.serverVersion).toBe('9');
    expect((await syncMetadataRepo.get('workspace_folder', 'folder-keep-ver'))?.serverVersion).toBe('3');
  });

  it('3. OutboxRepository.enqueueInTx heals empty/zero baseServerVersion with incoming valid baseServerVersion', async () => {
    await db.outbox.add({
      id: 'corrupt-outbox-1',
      mutationId: 'mut-corrupt-1',
      userId,
      projectId,
      entityType: 'document',
      entityId: 'doc-corrupt-base',
      operation: 'update',
      baseServerVersion: '',
      localRevision: 1,
      payload: { title: 'Old' },
      state: 'pending',
      attemptCount: 0,
      createdAt: 1000,
      updatedAt: 1000,
    });

    const compacted = await outboxRepo.enqueue({
      userId,
      projectId,
      entityType: 'document',
      entityId: 'doc-corrupt-base',
      operation: 'update',
      baseServerVersion: '7',
      localRevision: 2,
      payload: { title: 'New' },
    });

    expect(compacted?.baseServerVersion).toBe('7');
  });

  it('4. migrateLegacyArtixDB backfills missing outbox baseServerVersion from migrated sync_metadata', async () => {
    const legacyDb = getArtixDB('ArtixDB');
    await legacyDb.open();

    await legacyDb.sync_metadata.put({
      id: 'document:legacy-doc-1',
      entityType: 'document',
      entityId: 'legacy-doc-1',
      userId,
      syncState: 'pending',
      serverVersion: '11',
      serverUpdatedAt: '2026-10-01T00:00:00Z',
      localRevision: 2,
      lastSyncedAt: 1700000000000,
    });

    await legacyDb.outbox.put({
      id: 'legacy-outbox-1',
      mutationId: 'legacy-mut-1',
      userId,
      projectId,
      entityType: 'document',
      entityId: 'legacy-doc-1',
      operation: 'update',
      baseServerVersion: null,
      localRevision: 2,
      payload: { title: 'Legacy Edit' },
      state: 'pending',
      attemptCount: 0,
      createdAt: 1700000001000,
      updatedAt: 1700000001000,
    });

    const res = await migrateLegacyArtixDB(db, userId);
    expect(res.migrated).toBe(true);

    const migratedEntry = await outboxRepo.getById('legacy-outbox-1');
    expect(migratedEntry?.baseServerVersion).toBe('11');
  });

  it('5. SyncEngine pre-push reconciler heals missing baseline when serverUpdatedAt matches and raises 3-way conflict when remote diverged', async () => {
    // Subcase A: sync_metadata has serverUpdatedAt matching remote row -> heals baseline to v4 and pushes cleanly
    await syncMetadataRepo.upsert({
      entityType: 'document',
      entityId: 'doc-heal-match',
      userId,
      syncState: 'pending',
      serverVersion: null,
      serverUpdatedAt: '2026-11-01T08:00:00Z',
      localRevision: 2,
    });
    await db.outbox.add({
      id: 'outbox-heal-match',
      mutationId: 'mut-heal-match',
      userId,
      projectId,
      entityType: 'document',
      entityId: 'doc-heal-match',
      operation: 'update',
      baseServerVersion: null,
      localRevision: 2,
      payload: { title: 'Healed Update' },
      state: 'pending',
      attemptCount: 0,
      createdAt: 1000,
      updatedAt: 1000,
    });

    // Subcase B: sync_metadata has serverUpdatedAt that DIFFERS from remote row -> must fail closed into 3-way conflict without pushing!
    await syncMetadataRepo.upsert({
      entityType: 'document',
      entityId: 'doc-heal-diverged',
      userId,
      syncState: 'pending',
      serverVersion: null,
      serverUpdatedAt: '2026-11-01T08:00:00Z',
      localRevision: 2,
      baseSnapshot: { title: 'Base Title', content: 'Base' },
    });
    await db.outbox.add({
      id: 'outbox-heal-diverged',
      mutationId: 'mut-heal-diverged',
      userId,
      projectId,
      entityType: 'document',
      entityId: 'doc-heal-diverged',
      operation: 'update',
      baseServerVersion: null,
      localRevision: 2,
      payload: { title: 'Diverged Local Update' },
      state: 'pending',
      attemptCount: 0,
      createdAt: 2000,
      updatedAt: 2000,
    });

    const rpcCalls: any[] = [];
    const mockSupabase = {
      rpc: vi.fn(async (_fn: string, params: any) => {
        rpcCalls.push(params);
        return {
          data: { status: 'applied', version: 5, updated_at: '2026-11-01T09:00:00Z' },
          error: null,
        };
      }),
      from: vi.fn((table: string) => {
        if (table === 'sync_changes') {
          return {
            select: () => ({
              eq: () => ({
                gt: () => ({
                  order: () => ({
                    limit: async () => ({ data: [], error: null }),
                  }),
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => {
                if (id === 'doc-heal-match') {
                  return {
                    data: {
                      id: 'doc-heal-match',
                      version: 4,
                      title: 'Server Unchanged',
                      updated_at: '2026-11-01T08:00:00Z',
                    },
                    error: null,
                  };
                }
                if (id === 'doc-heal-diverged') {
                  return {
                    data: {
                      id: 'doc-heal-diverged',
                      version: 6,
                      title: 'Concurrent Remote Edit',
                      updated_at: '2026-11-01T08:45:00Z',
                    },
                    error: null,
                  };
                }
                return { data: null, error: null };
              },
            }),
          }),
        };
      }),
    };

    const engine = new SyncEngine({
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
    });

    await engine.triggerSync(userId);

    // Subcase A pushed with healed p_base_version = 4
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].p_entity_id).toBe('doc-heal-match');
    expect(rpcCalls[0].p_base_version).toBe(4);
    expect((await syncMetadataRepo.get('document', 'doc-heal-match'))?.syncState).toBe('synced');

    // Subcase B did NOT push; recorded 3-way conflict and blocked entry
    const divergedOutbox = await outboxRepo.getById('outbox-heal-diverged');
    expect(divergedOutbox?.state).toBe('blocked');
    const conflicts = await conflictRepo.listByEntity('document', 'doc-heal-diverged', userId);
    expect(conflicts).toHaveLength(1);
    expect((conflicts[0].remotePayload as any)?.version).toBe(6);

    engine.destroy();
  });

  it('6. createTabCloseGuard persists dirty content locally without calling navigator.sendBeacon or fetch (OF-14)', () => {
    const beaconSpy = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: beaconSpy });
    vi.stubGlobal('fetch', fetchSpy);

    const flushed: Array<{ id: string; content: string }> = [];
    const guard = createTabCloseGuard((id, content) => {
      flushed.push({ id, content });
    });

    guard.markDirty('doc-unload-1', 'Unsaved local draft');
    guard.handleBeforeUnload();

    expect(beaconSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem('artix.draft.doc-unload-1')).toBe('Unsaved local draft');
    expect(flushed).toEqual([{ id: 'doc-unload-1', content: 'Unsaved local draft' }]);

    guard.markClean('doc-unload-1');
    expect(localStorage.getItem('artix.draft.doc-unload-1')).toBeNull();

    vi.unstubAllGlobals();
  });
});
