import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getUserDbName,
  getUserArtixDB,
  closeUserArtixDB,
  closeAllArtixDBs,
  deleteArtixDB,
  migrateLegacyArtixDB,
  getArtixDB,
} from '@/lib/local/db';

describe('Phase 2: User-Scoped Local Repository (ArtixDB_v2_<hash>)', () => {
  beforeEach(async () => {
    await closeAllArtixDBs();
    await deleteArtixDB('ArtixDB');
  });

  afterEach(async () => {
    await closeAllArtixDBs();
    await deleteArtixDB('ArtixDB');
  });

  describe('Deterministic Hashing & DB Naming', () => {
    it('generates a stable deterministic name for a user ID', () => {
      const name1 = getUserDbName('user-abc-123');
      const name2 = getUserDbName('user-abc-123');
      expect(name1).toBe(name2);
      expect(name1).toMatch(/^ArtixDB_v2_[0-9a-f]{8}$/);
    });

    it('generates distinct database names for different users', () => {
      const nameUserA = getUserDbName('user-alice');
      const nameUserB = getUserDbName('user-bob');
      expect(nameUserA).not.toBe(nameUserB);
    });

    it('falls back to ArtixDB_v2_anonymous for undefined or null user ID', () => {
      expect(getUserDbName(undefined)).toBe('ArtixDB_v2_anonymous');
      expect(getUserDbName('')).toBe('ArtixDB_v2_anonymous');
    });
  });

  describe('Physical Multi-Tenancy Isolation', () => {
    it('physically isolates storage between different authenticated users', async () => {
      const dbAlice = getUserArtixDB('user-alice');
      const dbBob = getUserArtixDB('user-bob');

      expect(dbAlice.name).not.toBe(dbBob.name);

      // Add a document directly to Alice's database
      await dbAlice.documents.add({
        id: 'doc-alice-secret',
        userId: 'user-alice',
        projectId: 'proj-1',
        folderId: null,
        title: 'Alice Secrets',
        content: 'Top Secret Plans',
        format: 'markdown',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        localRevision: 1,
        isDeleted: false,
      });

      // Bob's database must have zero documents, even if querying without userId filter
      const bobDocs = await dbBob.documents.toArray();
      expect(bobDocs).toHaveLength(0);

      const aliceDocs = await dbAlice.documents.toArray();
      expect(aliceDocs).toHaveLength(1);
      expect(aliceDocs[0].id).toBe('doc-alice-secret');

      await closeUserArtixDB('user-alice');
      await closeUserArtixDB('user-bob');
    });
  });

  describe('Lifecycle Management', () => {
    it('caches database instances and properly evicts them on close', async () => {
      const instance1 = getUserArtixDB('user-lifecycle');
      const instance2 = getUserArtixDB('user-lifecycle');
      expect(instance1).toBe(instance2);

      await closeUserArtixDB('user-lifecycle');

      // Next call creates a fresh opened instance
      const instance3 = getUserArtixDB('user-lifecycle');
      expect(instance3).not.toBe(instance1);

      await closeUserArtixDB('user-lifecycle');
    });

    it('closes all database instances cleanly with closeAllArtixDBs', async () => {
      const db1 = getUserArtixDB('user-1');
      const db2 = getUserArtixDB('user-2');
      await db1.open();
      await db2.open();
      expect(db1.isOpen()).toBe(true);
      expect(db2.isOpen()).toBe(true);

      await closeAllArtixDBs();
      expect(db1.isOpen()).toBe(false);
      expect(db2.isOpen()).toBe(false);
    });
  });

  describe('Legacy ArtixDB Migration', () => {
    it('migrates existing records from unpartitioned ArtixDB to user-scoped database idempotently', async () => {
      const legacyDb = getArtixDB('ArtixDB');

      // Populate legacy DB with records from two different users
      await legacyDb.documents.bulkAdd([
        {
          id: 'doc-user-1',
          userId: 'user-migration-1',
          projectId: 'proj-1',
          folderId: null,
          title: 'Legacy Doc 1',
          content: 'Hello World',
          format: 'markdown',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          localRevision: 1,
          isDeleted: false,
        },
        {
          id: 'doc-user-2',
          userId: 'user-migration-2',
          projectId: 'proj-2',
          folderId: null,
          title: 'Legacy Doc 2',
          content: 'Different User',
          format: 'markdown',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          localRevision: 1,
          isDeleted: false,
        },
      ]);

      await legacyDb.workspace_folders.add({
        id: 'folder-user-1',
        userId: 'user-migration-1',
        projectId: 'proj-1',
        parentFolderId: null,
        name: 'Legacy Folder',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        localRevision: 1,
        isDeleted: false,
      });

      const user1Db = getUserArtixDB('user-migration-1');

      // Run migration
      await migrateLegacyArtixDB(user1Db, 'user-migration-1');

      // Verify User 1's records are migrated
      const user1Docs = await user1Db.documents.toArray();
      expect(user1Docs).toHaveLength(1);
      expect(user1Docs[0].id).toBe('doc-user-1');

      const user1Folders = await user1Db.workspace_folders.toArray();
      expect(user1Folders).toHaveLength(1);
      expect(user1Folders[0].id).toBe('folder-user-1');

      // Verify User 2's records were NOT copied to User 1's DB
      expect(user1Docs.some((d) => d.id === 'doc-user-2')).toBe(false);

      // Re-running migration is idempotent
      await migrateLegacyArtixDB(user1Db, 'user-migration-1');
      const user1DocsSecondRun = await user1Db.documents.toArray();
      expect(user1DocsSecondRun).toHaveLength(1);

      await closeUserArtixDB('user-migration-1');
    });
  });
});
