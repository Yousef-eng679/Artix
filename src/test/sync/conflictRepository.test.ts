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

  it('records conflict with null base payload during concurrent creation collision', async () => {
    const conflict = await repo.recordConflict({
      entityType: 'document',
      entityId: 'doc-collision',
      userId: 'user-1',
      basePayload: null,
      localPayload: { title: 'Doc Created Locally' },
      remotePayload: { title: 'Doc Created Remotely' },
    });

    expect(conflict.basePayload).toBeNull();
    expect(conflict.localPayload).toEqual({ title: 'Doc Created Locally' });
    expect(conflict.remotePayload).toEqual({ title: 'Doc Created Remotely' });
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

  it('lists conflicts filtered by entityType, entityId, and optional userId', async () => {
    await repo.recordConflict({
      entityType: 'document',
      entityId: 'target-doc',
      userId: 'user-1',
      basePayload: 'b1',
      localPayload: 'l1',
      remotePayload: 'r1',
    });

    await repo.recordConflict({
      entityType: 'document',
      entityId: 'target-doc',
      userId: 'user-1',
      basePayload: 'b2',
      localPayload: 'l2',
      remotePayload: 'r2',
    });

    await repo.recordConflict({
      entityType: 'document',
      entityId: 'other-doc',
      userId: 'user-1',
      basePayload: null,
      localPayload: 'l3',
      remotePayload: 'r3',
    });

    await repo.recordConflict({
      entityType: 'document',
      entityId: 'target-doc',
      userId: 'user-2',
      basePayload: null,
      localPayload: 'u2-l',
      remotePayload: 'u2-r',
    });

    // List by entity for user-1
    const user1Conflicts = await repo.listByEntity('document', 'target-doc', 'user-1');
    expect(user1Conflicts).toHaveLength(2);
    expect(user1Conflicts.every((c) => c.entityId === 'target-doc' && c.userId === 'user-1')).toBe(true);

    // List by entity across all users (userId omitted)
    const allConflictsForDoc = await repo.listByEntity('document', 'target-doc');
    expect(allConflictsForDoc).toHaveLength(3);

    // List by different entity
    const otherDocConflicts = await repo.listByEntity('document', 'other-doc');
    expect(otherDocConflicts).toHaveLength(1);
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
