import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ArtixDB, deleteArtixDB } from '@/lib/local/db';
import { WorkspaceFolderRepository } from '@/lib/repositories/folderRepository';
import { DuplicateNameError } from '@/lib/local/errors';

describe('WorkspaceFolderRepository', () => {
  const testDbName = 'ArtixDB_test_folder_repo';
  let db: ArtixDB;
  let repo: WorkspaceFolderRepository;

  beforeEach(async () => {
    await deleteArtixDB(testDbName);
    db = new ArtixDB(testDbName);
    repo = new WorkspaceFolderRepository(db);
  });

  afterEach(async () => {
    await deleteArtixDB(testDbName);
  });

  it('creates and lists folders sorted alphabetically', async () => {
    await repo.create({ userId: 'user-1', projectId: 'proj-1', name: 'Zeta Docs' });
    await repo.create({ userId: 'user-1', projectId: 'proj-1', name: 'Alpha Specs' });
    await repo.create({ userId: 'user-1', projectId: 'proj-1', name: 'Beta Designs' });

    const list = await repo.listByProject('user-1', 'proj-1');
    expect(list.map((f) => f.name)).toEqual(['Alpha Specs', 'Beta Designs', 'Zeta Docs']);
  });

  it('prevents case-insensitive duplicate folder names in the same project', async () => {
    await repo.create({ userId: 'user-1', projectId: 'proj-1', name: 'Architecture' });

    await expect(
      repo.create({ userId: 'user-1', projectId: 'proj-1', name: 'architecture' })
    ).rejects.toThrow(DuplicateNameError);

    await expect(
      repo.create({ userId: 'user-1', projectId: 'proj-1', name: '  ARCHITECTURE  ' })
    ).rejects.toThrow(DuplicateNameError);
  });

  it('allows same folder name in different projects or different users', async () => {
    const folderA = await repo.create({ userId: 'user-1', projectId: 'proj-A', name: 'Designs' });
    const folderB = await repo.create({ userId: 'user-1', projectId: 'proj-B', name: 'Designs' });
    const folderC = await repo.create({ userId: 'user-2', projectId: 'proj-A', name: 'Designs' });

    expect(folderA.id).toBeDefined();
    expect(folderB.id).toBeDefined();
    expect(folderC.id).toBeDefined();
  });

  it('prevents renaming to a duplicate name, but allows saving the exact same name', async () => {
    const f1 = await repo.create({ userId: 'user-1', projectId: 'proj-1', name: 'Folder 1' });
    await repo.create({ userId: 'user-1', projectId: 'proj-1', name: 'Folder 2' });

    // Renaming to itself is allowed
    const same = await repo.rename(f1.id, 'Folder 1');
    expect(same.name).toBe('Folder 1');

    // Renaming to existing folder in same project throws
    await expect(repo.rename(f1.id, 'folder 2')).rejects.toThrow(DuplicateNameError);
  });

  it('supports hierarchy reparenting and soft delete', async () => {
    const parent = await repo.create({ userId: 'user-1', projectId: 'proj-1', name: 'Parent' });
    const child = await repo.create({
      userId: 'user-1',
      projectId: 'proj-1',
      name: 'Child',
      parentFolderId: parent.id,
    });

    expect(child.parentFolderId).toBe(parent.id);

    // Reparent child to root
    const moved = await repo.update(child.id, { parentFolderId: null });
    expect(moved.parentFolderId).toBeNull();
    expect(moved.localRevision).toBe(2);

    // Soft delete
    await repo.delete(child.id);
    const list = await repo.listByProject('user-1', 'proj-1');
    expect(list.some((f) => f.id === child.id)).toBe(false);
  });
});
