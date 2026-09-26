import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getArtixDB, deleteArtixDB, ArtixDB } from '../../lib/local/db';
import { ConflictRepository } from '../../lib/repositories/conflictRepository';

describe('ConflictRepository', () => {
  const TEST_DB_NAME = 'ArtixDB_test_conflict_repo';
  let db: ArtixDB;
  let repo: ConflictRepository;

  beforeEach(async () => {
    await deleteArtixDB(TEST_DB_NAME);
    db = getArtixDB(TEST_DB_NAME);
    repo = new ConflictRepository(db);
  });

  afterEach(async () => {
    await deleteArtixDB(TEST_DB_NAME);
  });

  it('records a 3-way conflict without destroying local or remote data', async () => {
    const conflict = await repo.recordConflict({
      entityType: 'document',
      entityId: 'doc-conflict-1',
      userId: 'user-1',
      basePayload: { content: 'Original text' },
      localPayload: { content: 'Local edits' },
      remotePayload: { content: 'Remote concurrent edits' },
    });

    expect(conflict.id).toBeDefined();
    expect(conflict.entityId).toBe('doc-conflict-1');
    expect(conflict.resolvedAt).toBeNull();
    expect(conflict.detectedAt).toBeGreaterThan(0);

    const fetched = await repo.getById(conflict.id);
    expect(fetched).toEqual(conflict);
  });

  it('lists unresolved conflicts and resolves them', async () => {
    const c1 = await repo.recordConflict({
      entityType: 'document',
      entityId: 'doc-1',
      userId: 'user-1',
      basePayload: null,
      localPayload: 'Local 1',
      remotePayload: 'Remote 1',
    });

    const c2 = await repo.recordConflict({
      entityType: 'system_design',
      entityId: 'design-1',
      userId: 'user-1',
      basePayload: null,
      localPayload: 'Local 2',
      remotePayload: 'Remote 2',
    });

    let unresolved = await repo.listUnresolved('user-1');
    expect(unresolved).toHaveLength(2);

    // Resolve c1
    await repo.resolve(c1.id);

    unresolved = await repo.listUnresolved('user-1');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].id).toBe(c2.id);

    const resolvedC1 = await repo.getById(c1.id);
    expect(resolvedC1?.resolvedAt).toBeGreaterThan(0);
  });

  it('deletes a conflict record', async () => {
    const c = await repo.recordConflict({
      entityType: 'document',
      entityId: 'doc-del',
      userId: 'user-1',
      basePayload: null,
      localPayload: null,
      remotePayload: null,
    });

    await repo.delete(c.id);
    expect(await repo.getById(c.id)).toBeUndefined();
  });
});
