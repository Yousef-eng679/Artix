import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getArtixDB, deleteArtixDB, ArtixDB } from '../../lib/local/db';
import { SyncMetadataRepository } from '../../lib/repositories/syncMetadataRepository';

describe('SyncMetadataRepository', () => {
  const TEST_DB_NAME = 'ArtixDB_test_sync_meta_repo';
  let db: ArtixDB;
  let repo: SyncMetadataRepository;

  beforeEach(async () => {
    await deleteArtixDB(TEST_DB_NAME);
    db = getArtixDB(TEST_DB_NAME);
    repo = new SyncMetadataRepository(db);
  });

  afterEach(async () => {
    await deleteArtixDB(TEST_DB_NAME);
  });

  it('upserts and retrieves sync metadata', async () => {
    const meta = await repo.upsert({
      entityType: 'document',
      entityId: 'doc-123',
      userId: 'user-1',
      localRevision: 1,
      syncState: 'pending',
    });

    expect(meta.id).toBe('document:doc-123');
    expect(meta.syncState).toBe('pending');
    expect(meta.localRevision).toBe(1);

    const fetched = await repo.get('document', 'doc-123');
    expect(fetched).toEqual(meta);
  });

  it('marks entity as synced with serverVersion and timestamp', async () => {
    await repo.markPending('document', 'doc-123', 'user-1', 2);
    const synced = await repo.markSynced('document', 'doc-123', 'user-1', 'v-100', '2026-09-26T12:00:00Z', 2);

    expect(synced.syncState).toBe('synced');
    expect(synced.serverVersion).toBe('v-100');
    expect(synced.serverUpdatedAt).toBe('2026-09-26T12:00:00Z');
    expect(synced.lastSyncedAt).toBeGreaterThan(0);
  });

  it('marks entity as syncing during in-flight push', async () => {
    await repo.markPending('document', 'doc-inflight', 'user-1', 1);
    const syncing = await repo.markSyncing('document', 'doc-inflight', 'user-1');

    expect(syncing.syncState).toBe('syncing');

    const fetched = await repo.get('document', 'doc-inflight');
    expect(fetched?.syncState).toBe('syncing');
  });

  it('lists entities by sync state with and without user filtering', async () => {
    await repo.markPending('document', 'doc-1', 'user-1', 1);
    await repo.markPending('document', 'doc-2', 'user-1', 1);
    await repo.markPending('document', 'doc-other-user', 'user-2', 1);
    await repo.markSynced('document', 'doc-3', 'user-1', 'v-1');

    const pendingUser1 = await repo.listByState('pending', 'user-1');
    expect(pendingUser1).toHaveLength(2);

    const pendingAll = await repo.listByState('pending');
    expect(pendingAll).toHaveLength(3);

    const synced = await repo.listByState('synced', 'user-1');
    expect(synced).toHaveLength(1);
    expect(synced[0].entityId).toBe('doc-3');
  });

  it('supports error and conflict states', async () => {
    const err = await repo.markError('system_design', 'design-1', 'user-1');
    expect(err.syncState).toBe('error');

    const conflict = await repo.markConflict('system_design', 'design-1', 'user-1');
    expect(conflict.syncState).toBe('conflict');
  });

  it('deletes sync metadata', async () => {
    await repo.markPending('workspace_folder', 'folder-1', 'user-1', 1);
    expect(await repo.get('workspace_folder', 'folder-1')).toBeDefined();

    await repo.delete('workspace_folder', 'folder-1');
    expect(await repo.get('workspace_folder', 'folder-1')).toBeUndefined();
  });
});
