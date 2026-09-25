import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ArtixDB, deleteArtixDB } from '@/lib/local/db';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { EntityNotFoundError } from '@/lib/local/errors';

describe('DocumentRepository', () => {
  const testDbName = 'ArtixDB_test_doc_repo';
  let db: ArtixDB;
  let repo: DocumentRepository;

  beforeEach(async () => {
    await deleteArtixDB(testDbName);
    db = new ArtixDB(testDbName);
    repo = new DocumentRepository(db);
  });

  afterEach(async () => {
    await deleteArtixDB(testDbName);
  });

  it('creates document with auto-generated UUID and localRevision 1', async () => {
    const doc = await repo.create({
      userId: 'user-1',
      projectId: 'proj-1',
      title: 'Architecture Overview',
      content: '# System Architecture\nInitial design.',
    });

    expect(doc.id).toBeDefined();
    expect(doc.userId).toBe('user-1');
    expect(doc.projectId).toBe('proj-1');
    expect(doc.title).toBe('Architecture Overview');
    expect(doc.content).toBe('# System Architecture\nInitial design.');
    expect(doc.localRevision).toBe(1);
    expect(doc.isDeleted).toBe(false);

    const fetched = await repo.getById(doc.id);
    expect(fetched).toEqual(doc);
  });

  it('increments localRevision on updates and records new updatedAt timestamp', async () => {
    const doc = await repo.create({
      userId: 'user-1',
      projectId: 'proj-1',
      title: 'Draft PRD',
      content: 'Version 1',
    });

    // Small delay to verify timestamp progression
    await new Promise((r) => setTimeout(r, 10));

    const updated = await repo.update(doc.id, {
      content: 'Version 2 with more specs',
    });

    expect(updated.localRevision).toBe(2);
    expect(updated.content).toBe('Version 2 with more specs');
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(doc.updatedAt).getTime());

    const updatedAgain = await repo.update(doc.id, {
      title: 'Final PRD',
    });

    expect(updatedAgain.localRevision).toBe(3);
    expect(updatedAgain.title).toBe('Final PRD');
  });

  it('throws EntityNotFoundError when updating non-existent document', async () => {
    await expect(repo.update('non-existent-id', { title: 'Foo' })).rejects.toThrow(
      EntityNotFoundError
    );
  });

  it('performs soft delete by setting isDeleted and hiding from getById and listByProject', async () => {
    const doc = await repo.create({
      userId: 'user-1',
      projectId: 'proj-1',
      title: 'To Be Deleted',
    });

    await repo.delete(doc.id);

    // Regular getById ignores soft-deleted records
    const fetched = await repo.getById(doc.id);
    expect(fetched).toBeNull();

    // Regular list ignores soft-deleted records
    const list = await repo.listByProject('user-1', 'proj-1');
    expect(list.some((d) => d.id === doc.id)).toBe(false);

    // But getByIdIncludeDeleted preserves it for sync/recovery
    const raw = await repo.getByIdIncludeDeleted(doc.id);
    expect(raw).toBeDefined();
    expect(raw?.isDeleted).toBe(true);
    expect(raw?.localRevision).toBe(2); // revision bumped on delete
  });

  it('restores a soft-deleted document', async () => {
    const doc = await repo.create({
      userId: 'user-1',
      projectId: 'proj-1',
      title: 'Rescue Me',
    });

    await repo.delete(doc.id);
    expect(await repo.getById(doc.id)).toBeNull();

    const restored = await repo.restore(doc.id);
    expect(restored.isDeleted).toBe(false);
    expect(restored.localRevision).toBe(3); // create(1) -> delete(2) -> restore(3)

    const reFetched = await repo.getById(doc.id);
    expect(reFetched).toBeDefined();
    expect(reFetched?.title).toBe('Rescue Me');
  });

  it('filters documents by user and project properly', async () => {
    await repo.create({ userId: 'user-1', projectId: 'proj-A', title: 'Doc 1' });
    await repo.create({ userId: 'user-1', projectId: 'proj-A', title: 'Doc 2' });
    await repo.create({ userId: 'user-1', projectId: 'proj-B', title: 'Doc 3' });
    await repo.create({ userId: 'user-2', projectId: 'proj-A', title: 'User 2 Doc' });

    const user1ProjA = await repo.listByProject('user-1', 'proj-A');
    expect(user1ProjA).toHaveLength(2);

    const user1ProjB = await repo.listByProject('user-1', 'proj-B');
    expect(user1ProjB).toHaveLength(1);
    expect(user1ProjB[0].title).toBe('Doc 3');

    const user2ProjA = await repo.listByProject('user-2', 'proj-A');
    expect(user2ProjA).toHaveLength(1);
    expect(user2ProjA[0].title).toBe('User 2 Doc');
  });
});
