import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ArtixDB } from '@/lib/local/db';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { PullEngine } from '@/lib/sync/pullEngine';
import { TombstoneManager } from '@/lib/sync/tombstoneManager';

describe('Phase C8: Tombstones & Remote Delete Correctness', () => {
  let db: ArtixDB;
  let docRepo: DocumentRepository;
  let outboxRepo: OutboxRepository;
  let syncMetadataRepo: SyncMetadataRepository;
  let conflictRepo: ConflictRepository;
  let tombstoneManager: TombstoneManager;

  const userId = 'user-tombstone-c8';
  const projectId = 'proj-tombstone-c8';

  beforeEach(async () => {
    db = new ArtixDB(`TestDB_Tombstones_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
    await db.open();

    outboxRepo = new OutboxRepository(db);
    syncMetadataRepo = new SyncMetadataRepository(db);
    conflictRepo = new ConflictRepository(db);
    docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);
    tombstoneManager = new TombstoneManager(db);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('remote delete while offline is ingested, soft-deletes entity, and marks REMOTE_CONFIRMED_DELETE', async () => {
    // 1. Initial document
    await docRepo.applyRemoteSnapshot({
      id: 'doc-rem-del-1',
      userId,
      projectId,
      title: 'Active Document',
      content: 'Hello World',
      serverVersion: '1',
      updatedAt: '2026-09-28T10:00:00Z',
    });

    expect(await tombstoneManager.getTombstoneState('document', 'doc-rem-del-1', userId)).toBe('ACTIVE');

    // 2. Remote delete arrives
    const mockSupabase = {
      from: (table: string) => {
        if (table === 'sync_changes') {
          return {
            select: () => ({
              eq: () => ({
                gt: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({
                        data: [
                          {
                            sequence: 201,
                            entity_type: 'document',
                            entity_id: 'doc-rem-del-1',
                            entity_version: 2,
                            operation: 'delete',
                            payload: {},
                            changed_at: '2026-09-28T11:00:00Z',
                          },
                        ],
                        error: null,
                      }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      },
    };

    const pullEngine = new PullEngine({
      supabaseClient: mockSupabase,
      db,
      documentRepo: docRepo,
      conflictRepo,
      syncMetadataRepo,
    });

    const result = await pullEngine.pullAll(userId);
    expect(result.totalPulled).toBe(1);

    // Invariant: Regular queries filter out deleted document
    expect(await docRepo.getById('doc-rem-del-1')).toBeNull();

    // Invariant: Tombstone state is REMOTE_CONFIRMED_DELETE
    const state = await tombstoneManager.getTombstoneState('document', 'doc-rem-del-1', userId);
    expect(state).toBe('REMOTE_CONFIRMED_DELETE');

    // Invariant: Metadata is marked deleted_synced
    const meta = await syncMetadataRepo.get('document', 'doc-rem-del-1');
    expect(meta?.syncState).toBe('deleted_synced');
  });

  it('local delete while offline sets LOCAL_PENDING_DELETE with CAS baseline in outbox', async () => {
    // 1. Initial document synced at version 3
    await docRepo.applyRemoteSnapshot({
      id: 'doc-loc-del-1',
      userId,
      projectId,
      title: 'Doc to Delete Offline',
      content: 'Content v3',
      serverVersion: '3',
      updatedAt: '2026-09-28T10:00:00Z',
    });

    // 2. User deletes locally offline
    await docRepo.delete('doc-loc-del-1');

    // Invariant: Regular query returns null
    expect(await docRepo.getById('doc-loc-del-1')).toBeNull();

    // Invariant: Tombstone state is LOCAL_PENDING_DELETE
    const state = await tombstoneManager.getTombstoneState('document', 'doc-loc-del-1', userId);
    expect(state).toBe('LOCAL_PENDING_DELETE');

    // Invariant: Outbox has delete mutation with baseServerVersion = '3'
    const pending = await outboxRepo.getPending(undefined, userId);
    expect(pending.length).toBe(1);
    expect(pending[0].operation).toBe('delete');
    expect(pending[0].baseServerVersion).toBe('3');
  });

  it('concurrent delete convergence: remote delete cancels pending outbox delete without false conflict', async () => {
    // 1. Initial document
    await docRepo.applyRemoteSnapshot({
      id: 'doc-both-del-1',
      userId,
      projectId,
      title: 'Doc Deleted on Both Clients',
      content: 'Content',
      serverVersion: '1',
      updatedAt: '2026-09-28T10:00:00Z',
    });

    // 2. Local user deletes offline
    await docRepo.delete('doc-both-del-1');
    expect((await outboxRepo.getPending(undefined, userId)).length).toBe(1);

    // 3. Remote feed delivers delete for the same document
    const mockSupabase = {
      from: (table: string) => {
        if (table === 'sync_changes') {
          return {
            select: () => ({
              eq: () => ({
                gt: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({
                        data: [
                          {
                            sequence: 205,
                            entity_type: 'document',
                            entity_id: 'doc-both-del-1',
                            entity_version: 2,
                            operation: 'delete',
                            payload: {},
                            changed_at: '2026-09-28T11:00:00Z',
                          },
                        ],
                        error: null,
                      }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      },
    };

    const pullEngine = new PullEngine({
      supabaseClient: mockSupabase,
      db,
      documentRepo: docRepo,
      conflictRepo,
      syncMetadataRepo,
    });

    await pullEngine.pullAll(userId);

    // Invariant: Pending outbox delete was cleanly removed (no CAS conflict push needed!)
    const remainingOutbox = await db.outbox.toArray();
    expect(remainingOutbox.length).toBe(0);

    // Invariant: No false conflict created
    const conflicts = await conflictRepo.listByEntity('document', 'doc-both-del-1', userId);
    expect(conflicts.length).toBe(0);

    // Invariant: State converged cleanly to REMOTE_CONFIRMED_DELETE
    expect(await tombstoneManager.getTombstoneState('document', 'doc-both-del-1', userId)).toBe(
      'REMOTE_CONFIRMED_DELETE'
    );
  });

  it('local delete vs remote update records conflict and blocks outbox', async () => {
    // 1. Initial document at version 2
    await docRepo.applyRemoteSnapshot({
      id: 'doc-del-vs-upd',
      userId,
      projectId,
      title: 'Original Cloud Doc',
      content: 'Content v2',
      serverVersion: '2',
      updatedAt: '2026-09-28T10:00:00Z',
    });

    // 2. User deletes locally offline
    await docRepo.delete('doc-del-vs-upd');

    // 3. Remote client updated the document to version 3 concurrently
    const mockSupabase = {
      from: (table: string) => {
        if (table === 'sync_changes') {
          return {
            select: () => ({
              eq: () => ({
                gt: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({
                        data: [
                          {
                            sequence: 206,
                            entity_type: 'document',
                            entity_id: 'doc-del-vs-upd',
                            entity_version: 3,
                            operation: 'update',
                            payload: {
                              project_id: projectId,
                              title: 'Remote Concurrent Update',
                              content: 'Concurrent Body Content',
                              updated_at: '2026-09-28T11:00:00Z',
                            },
                            changed_at: '2026-09-28T11:00:00Z',
                          },
                        ],
                        error: null,
                      }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      },
    };

    const pullEngine = new PullEngine({
      supabaseClient: mockSupabase,
      db,
      documentRepo: docRepo,
      conflictRepo,
      syncMetadataRepo,
    });

    await pullEngine.pullAll(userId);

    // Invariant: Conflict recorded between local delete and remote update
    const conflicts = await conflictRepo.listByEntity('document', 'doc-del-vs-upd', userId);
    expect(conflicts.length).toBe(1);
    expect((conflicts[0].localPayload as any).deleted).toBe(true);
    expect((conflicts[0].remotePayload as any).title).toBe('Remote Concurrent Update');

    // Invariant: Outbox entry is BLOCKED
    const outbox = await db.outbox.toArray();
    expect(outbox[0].state).toBe('blocked');

    // Invariant: Tombstone state is REMOTE_DELETE_CONFLICT
    expect(await tombstoneManager.getTombstoneState('document', 'doc-del-vs-upd', userId)).toBe(
      'REMOTE_DELETE_CONFLICT'
    );
  });

  it('resurrection guard: stale remote update cannot resurrect a confirmed tombstone', async () => {
    // 1. Confirmed deleted document at version 5
    await docRepo.applyRemoteSnapshot({
      id: 'doc-tombstone-stale',
      userId,
      projectId,
      title: 'Deleted Doc',
      content: 'Gone',
      serverVersion: '5',
      updatedAt: '2026-09-28T10:00:00Z',
    });
    await docRepo.delete('doc-tombstone-stale', { skipOutbox: true });

    // Mark as confirmed deleted
    await syncMetadataRepo.upsertInTx({
      entityType: 'document',
      entityId: 'doc-tombstone-stale',
      userId,
      syncState: 'deleted_synced',
      serverVersion: '5',
      serverUpdatedAt: '2026-09-28T10:30:00Z',
    });

    expect(await tombstoneManager.getTombstoneState('document', 'doc-tombstone-stale', userId)).toBe(
      'REMOTE_CONFIRMED_DELETE'
    );

    // 2. Stale remote update arriving with version 4 (or 5)
    const mockSupabase = {
      from: (table: string) => {
        if (table === 'sync_changes') {
          return {
            select: () => ({
              eq: () => ({
                gt: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({
                        data: [
                          {
                            sequence: 207,
                            entity_type: 'document',
                            entity_id: 'doc-tombstone-stale',
                            entity_version: 4, // Stale!
                            operation: 'update',
                            payload: {
                              project_id: projectId,
                              title: 'Zombie Stale Replay',
                              content: 'Zombie Body',
                              updated_at: '2026-09-28T09:00:00Z',
                            },
                            changed_at: '2026-09-28T09:00:00Z',
                          },
                        ],
                        error: null,
                      }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      },
    };

    const pullEngine = new PullEngine({
      supabaseClient: mockSupabase,
      db,
      documentRepo: docRepo,
      conflictRepo,
      syncMetadataRepo,
    });

    await pullEngine.pullAll(userId);

    // Invariant: Non-resurrection! Document is NOT resurrected
    expect(await docRepo.getById('doc-tombstone-stale')).toBeNull();
    const stored = await db.documents.get('doc-tombstone-stale');
    expect(stored?.isDeleted).toBe(true);
    expect(stored?.title).toBe('Deleted Doc'); // Did NOT overwrite with 'Zombie Stale Replay'
  });

  it('safe tombstone purging removes confirmed tombstones older than retention window without pending work', async () => {
    // 1. Confirmed old tombstone (eligible for purge)
    const oldDeletedDoc = await docRepo.applyRemoteSnapshot({
      id: 'doc-old-purgeable',
      userId,
      projectId,
      title: 'Old Deleted Doc',
      content: '',
      serverVersion: '10',
    });
    await db.documents.update(oldDeletedDoc.id, {
      isDeleted: true,
      deletedAt: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString(), // 35 days old
    });
    await syncMetadataRepo.upsertInTx({
      entityType: 'document',
      entityId: oldDeletedDoc.id,
      userId,
      syncState: 'deleted_synced',
      serverVersion: '10',
    });

    // 2. Pending tombstone (synced on server, then deleted locally offline)
    const pendingDoc = await docRepo.applyRemoteSnapshot({
      id: 'doc-pending-purge',
      userId,
      projectId,
      title: 'Pending Deleted Doc',
      serverVersion: '1',
    });
    await docRepo.delete(pendingDoc.id);

    // 3. Run purge with 30-day retention
    const purgeResult = await tombstoneManager.purgeTombstones(userId, 30 * 24 * 60 * 60 * 1000);
    expect(purgeResult.purgedDocuments).toBe(1);
    expect(purgeResult.totalPurged).toBe(1);

    // Invariant: Old confirmed tombstone was purged
    expect(await db.documents.get(oldDeletedDoc.id)).toBeUndefined();
    expect(await syncMetadataRepo.get('document', oldDeletedDoc.id)).toBeUndefined();
    expect(await tombstoneManager.getTombstoneState('document', oldDeletedDoc.id, userId)).toBe(
      'PURGED_TOMBSTONE'
    );

    // Invariant: Pending delete was NOT purged
    expect(await db.documents.get(pendingDoc.id)).toBeDefined();
    expect(await tombstoneManager.getTombstoneState('document', pendingDoc.id, userId)).toBe(
      'LOCAL_PENDING_DELETE'
    );
  });
});
