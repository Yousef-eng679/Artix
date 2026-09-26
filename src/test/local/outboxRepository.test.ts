import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getArtixDB, deleteArtixDB, ArtixDB } from '../../lib/local/db';
import { OutboxRepository } from '../../lib/repositories/outboxRepository';

describe('OutboxRepository', () => {
  const TEST_DB_NAME = 'ArtixDB_test_outbox_repo';
  let db: ArtixDB;
  let repo: OutboxRepository;

  beforeEach(async () => {
    await deleteArtixDB(TEST_DB_NAME);
    db = getArtixDB(TEST_DB_NAME);
    repo = new OutboxRepository(db);
  });

  afterEach(async () => {
    await deleteArtixDB(TEST_DB_NAME);
  });

  it('enqueues a create mutation when no pending mutation exists', async () => {
    const entry = await repo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-1',
      operation: 'create',
      payload: { title: 'Doc 1', content: 'Initial' },
      localRevision: 1,
    });

    expect(entry).not.toBeNull();
    expect(entry?.entityId).toBe('doc-1');
    expect(entry?.operation).toBe('create');
    expect(entry?.state).toBe('pending');
    expect(entry?.attemptCount).toBe(0);

    const pending = await repo.getPending(undefined, 'user-1');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(entry?.id);
  });

  it('coalesces create + update into a single create operation with merged payload', async () => {
    // 1. Create offline
    await repo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-coalesce',
      operation: 'create',
      payload: { title: 'Initial Title', content: 'Draft 1' },
      localRevision: 1,
    });

    // 2. User edits while still offline
    const updated = await repo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-coalesce',
      operation: 'update',
      payload: { content: 'Draft 2 - Updated' },
      localRevision: 2,
    });

    expect(updated).not.toBeNull();
    expect(updated?.operation).toBe('create'); // Kept as create!
    expect(updated?.localRevision).toBe(2);
    expect(updated?.payload).toEqual({
      title: 'Initial Title',
      content: 'Draft 2 - Updated',
    });

    // Outbox should still only have 1 entry
    const pending = await repo.getPending(undefined, 'user-1');
    expect(pending).toHaveLength(1);
  });

  it('cancels create + delete completely when an entity is created and deleted offline', async () => {
    // 1. Create offline
    await repo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-temp',
      operation: 'create',
      payload: { title: 'Temporary Doc' },
      localRevision: 1,
    });

    expect(await repo.countPending('user-1')).toBe(1);

    // 2. Delete while still offline
    const res = await repo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-temp',
      operation: 'delete',
      payload: null,
      localRevision: 2,
    });

    // Mutation was cancelled completely
    expect(res).toBeNull();
    expect(await repo.countPending('user-1')).toBe(0);
  });

  it('coalesces multiple update operations into a single update with latest payload', async () => {
    // 1. First update
    await repo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-existing',
      operation: 'update',
      payload: { title: 'First Update', content: 'v1' },
      localRevision: 2,
    });

    // 2. Second update
    await repo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-existing',
      operation: 'update',
      payload: { content: 'v2' },
      localRevision: 3,
    });

    // 3. Third update
    const finalUpdate = await repo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-existing',
      operation: 'update',
      payload: { title: 'Final Update' },
      localRevision: 4,
    });

    expect(finalUpdate?.operation).toBe('update');
    expect(finalUpdate?.localRevision).toBe(4);
    expect(finalUpdate?.payload).toEqual({
      title: 'Final Update',
      content: 'v2',
    });

    const pending = await repo.getPending(undefined, 'user-1');
    expect(pending).toHaveLength(1);
  });

  it('converts update + delete into a single delete operation', async () => {
    // 1. Edit an existing remote document
    await repo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-remote',
      operation: 'update',
      payload: { title: 'Changed Title' },
      localRevision: 5,
    });

    // 2. Then delete it
    const res = await repo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-remote',
      operation: 'delete',
      payload: null,
      localRevision: 6,
    });

    expect(res?.operation).toBe('delete');
    expect(res?.localRevision).toBe(6);

    const pending = await repo.getPending(undefined, 'user-1');
    expect(pending).toHaveLength(1);
    expect(pending[0].operation).toBe('delete');
  });

  it('treats duplicate delete + delete as a redundant no-op returning existing entry', async () => {
    const del1 = await repo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-dup-del',
      operation: 'delete',
      payload: null,
      localRevision: 10,
    });

    const del2 = await repo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-dup-del',
      operation: 'delete',
      payload: null,
      localRevision: 11,
    });

    expect(del2?.id).toBe(del1?.id);
    expect(del2?.operation).toBe('delete');
    expect(await repo.countPending('user-1')).toBe(1);
  });

  it('tracks failure retry count and transitions to blocked on max retries', async () => {
    const entry = await repo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'workspace_folder',
      entityId: 'folder-1',
      operation: 'create',
      payload: { name: 'Folder 1' },
      localRevision: 1,
    });

    expect(entry).not.toBeNull();
    const entryId = entry!.id;

    // Fail 1st time
    let failed = await repo.markFailed(entryId, { code: 'NETWORK_TIMEOUT', message: 'Timed out' }, 3);
    expect(failed?.attemptCount).toBe(1);
    expect(failed?.state).toBe('pending');

    // Fail 2nd time
    failed = await repo.markFailed(entryId, { code: 'NETWORK_TIMEOUT', message: 'Timed out' }, 3);
    expect(failed?.attemptCount).toBe(2);
    expect(failed?.state).toBe('pending');

    // Fail 3rd time (reaches maxRetries = 3)
    failed = await repo.markFailed(entryId, { code: 'NETWORK_TIMEOUT', message: 'Timed out' }, 3);
    expect(failed?.attemptCount).toBe(3);
    expect(failed?.state).toBe('blocked'); // Marked blocked!
    expect(failed?.lastError?.code).toBe('NETWORK_TIMEOUT');

    // It should no longer appear in getPending
    const pending = await repo.getPending(undefined, 'user-1');
    expect(pending).toHaveLength(0);
  });

  it('returns undefined when markFailed is called on non-existent entry', async () => {
    const res = await repo.markFailed('non-existent-id', { code: 'ERR', message: 'msg' });
    expect(res).toBeUndefined();
  });

  it('marks completed by deleting the entry from outbox', async () => {
    const entry = await repo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'system_design',
      entityId: 'design-1',
      operation: 'create',
      payload: { name: 'Design 1' },
      localRevision: 1,
    });

    expect(await repo.countPending('user-1')).toBe(1);
    await repo.markCompleted(entry!.id);
    expect(await repo.countPending('user-1')).toBe(0);
  });

  it('marks entry in_flight during active transmission', async () => {
    const entry = await repo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-inflight',
      operation: 'create',
      payload: { title: 'Doc In Flight' },
      localRevision: 1,
    });

    await repo.markInFlight(entry!.id);

    const fetched = await repo.getById(entry!.id);
    expect(fetched?.state).toBe('in_flight');
  });

  it('supports pagination with limit on getPending', async () => {
    for (let i = 1; i <= 5; i++) {
      await repo.enqueue({
        userId: 'user-paging',
        projectId: 'proj-1',
        entityType: 'document',
        entityId: `doc-page-${i}`,
        operation: 'create',
        payload: { title: `Page ${i}` },
        localRevision: 1,
      });
    }

    const firstTwo = await repo.getPending(2, 'user-paging');
    expect(firstTwo).toHaveLength(2);

    const all = await repo.getPending(undefined, 'user-paging');
    expect(all).toHaveLength(5);
  });

  it('clears outbox selectively by user or completely', async () => {
    await repo.enqueue({
      userId: 'user-clear-1',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-c-1',
      operation: 'create',
      payload: {},
      localRevision: 1,
    });
    await repo.enqueue({
      userId: 'user-clear-2',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-c-2',
      operation: 'create',
      payload: {},
      localRevision: 1,
    });

    // Clear user-clear-1 only
    await repo.clear('user-clear-1');
    expect(await repo.countPending('user-clear-1')).toBe(0);
    expect(await repo.countPending('user-clear-2')).toBe(1);

    // Clear all
    await repo.clear();
    expect(await repo.countPending('user-clear-2')).toBe(0);
  });
});
