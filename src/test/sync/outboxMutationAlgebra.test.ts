import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ArtixDB } from '@/lib/local/db';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { orderOutboxByDependency } from '@/lib/sync/dependencyOrder';
import { OutboxEntry } from '@/lib/local/types';

describe('Phase C9: Outbox Mutation Algebra & Dependency Correctness', () => {
  let db: ArtixDB;
  let outboxRepo: OutboxRepository;

  const userId = 'user-algebra-c9';
  const projectId = 'proj-algebra-c9';

  beforeEach(async () => {
    db = new ArtixDB(`TestDB_Algebra_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
    await db.open();
    outboxRepo = new OutboxRepository(db);
  });

  afterEach(async () => {
    await db.delete();
  });

  describe('Outbox Compaction State Transition Algebra', () => {
    it('Case 1: create + update -> stays create with merged payload and bumped revision', async () => {
      const entry1 = await outboxRepo.enqueue({
        userId,
        projectId,
        entityType: 'document',
        entityId: 'doc-alg-1',
        operation: 'create',
        payload: { title: 'Draft v1', content: 'Initial Content' },
        localRevision: 1,
      });

      expect(entry1?.operation).toBe('create');
      expect((entry1?.payload as any).title).toBe('Draft v1');

      // User performs update while create is still pending
      const compacted = await outboxRepo.enqueue({
        userId,
        projectId,
        entityType: 'document',
        entityId: 'doc-alg-1',
        operation: 'update',
        payload: { title: 'Draft v1 Renamed' },
        localRevision: 2,
      });

      expect(compacted?.operation).toBe('create');
      expect((compacted?.payload as any).title).toBe('Draft v1 Renamed');
      expect((compacted?.payload as any).content).toBe('Initial Content');
      expect(compacted?.localRevision).toBe(2);
      expect(compacted?.mutationId).toBe(entry1?.mutationId);

      const all = await db.outbox.toArray();
      expect(all.length).toBe(1);
    });

    it('Case 2: create + delete -> cancels out completely (entity born and died offline)', async () => {
      await outboxRepo.enqueue({
        userId,
        projectId,
        entityType: 'document',
        entityId: 'doc-alg-2',
        operation: 'create',
        payload: { title: 'Ephemeral Doc' },
        localRevision: 1,
      });

      expect((await db.outbox.toArray()).length).toBe(1);

      // User deletes offline before ever pushing to server
      const result = await outboxRepo.enqueue({
        userId,
        projectId,
        entityType: 'document',
        entityId: 'doc-alg-2',
        operation: 'delete',
        payload: null,
        localRevision: 2,
      });

      expect(result).toBeNull();
      // Invariant: Outbox is completely empty
      expect((await db.outbox.toArray()).length).toBe(0);
    });

    it('Case 3: update + update -> coalesces into single update with merged payload and CAS version', async () => {
      const entry1 = await outboxRepo.enqueue({
        userId,
        projectId,
        entityType: 'document',
        entityId: 'doc-alg-3',
        operation: 'update',
        payload: { title: 'Updated Title' },
        localRevision: 2,
        baseServerVersion: '5',
      });

      const compacted = await outboxRepo.enqueue({
        userId,
        projectId,
        entityType: 'document',
        entityId: 'doc-alg-3',
        operation: 'update',
        payload: { content: 'Updated Content' },
        localRevision: 3,
      });

      expect(compacted?.operation).toBe('update');
      expect((compacted?.payload as any).title).toBe('Updated Title');
      expect((compacted?.payload as any).content).toBe('Updated Content');
      expect(compacted?.baseServerVersion).toBe('5');
      expect(compacted?.localRevision).toBe(3);
      expect(compacted?.mutationId).toBe(entry1?.mutationId);

      expect((await db.outbox.toArray()).length).toBe(1);
    });

    it('Case 4: update + delete -> converts operation to delete and preserves CAS baseline', async () => {
      const entry1 = await outboxRepo.enqueue({
        userId,
        projectId,
        entityType: 'document',
        entityId: 'doc-alg-4',
        operation: 'update',
        payload: { title: 'Updated Before Delete' },
        localRevision: 2,
        baseServerVersion: '7',
      });

      const compacted = await outboxRepo.enqueue({
        userId,
        projectId,
        entityType: 'document',
        entityId: 'doc-alg-4',
        operation: 'delete',
        payload: null,
        localRevision: 3,
      });

      expect(compacted?.operation).toBe('delete');
      expect(compacted?.baseServerVersion).toBe('7');
      expect(compacted?.localRevision).toBe(3);
      expect(compacted?.mutationId).toBe(entry1?.mutationId);

      expect((await db.outbox.toArray()).length).toBe(1);
    });

    it('Case 5: delete + delete -> idempotent no-op without creating duplicate entries', async () => {
      const entry1 = await outboxRepo.enqueue({
        userId,
        projectId,
        entityType: 'document',
        entityId: 'doc-alg-5',
        operation: 'delete',
        payload: null,
        localRevision: 2,
        baseServerVersion: '3',
      });

      const compacted = await outboxRepo.enqueue({
        userId,
        projectId,
        entityType: 'document',
        entityId: 'doc-alg-5',
        operation: 'delete',
        payload: null,
        localRevision: 3,
      });

      expect(compacted?.operation).toBe('delete');
      expect(compacted?.id).toBe(entry1?.id);
      expect((await db.outbox.toArray()).length).toBe(1);
    });

    it('Case 6: delete + update -> explicit restore/un-delete replaces delete with update', async () => {
      const entry1 = await outboxRepo.enqueue({
        userId,
        projectId,
        entityType: 'document',
        entityId: 'doc-alg-6',
        operation: 'delete',
        payload: null,
        localRevision: 2,
        baseServerVersion: '4',
      });

      // User restores / edits the document locally before the delete pushed
      const compacted = await outboxRepo.enqueue({
        userId,
        projectId,
        entityType: 'document',
        entityId: 'doc-alg-6',
        operation: 'update',
        payload: { title: 'Restored Title', content: 'Restored Content' },
        localRevision: 3,
      });

      expect(compacted?.operation).toBe('update');
      expect((compacted?.payload as any).title).toBe('Restored Title');
      expect(compacted?.baseServerVersion).toBe('4'); // Preserves CAS base
      expect(compacted?.localRevision).toBe(3);
      expect(compacted?.mutationId).toBe(entry1?.mutationId);

      expect((await db.outbox.toArray()).length).toBe(1);
    });
  });

  describe('Topological Dependency Ordering & Cascade Invariants', () => {
    it('enforces creation order: Parent Folder -> Child Folder -> Document & Design', () => {
      const docCreate: OutboxEntry = {
        id: 'outbox-doc',
        mutationId: 'mut-1',
        userId,
        projectId,
        entityType: 'document',
        entityId: 'doc-child',
        operation: 'create',
        baseServerVersion: null,
        localRevision: 1,
        payload: { title: 'Child Doc', folderId: 'subfolder-id' },
        state: 'pending',
        attemptCount: 0,
        createdAt: 300,
        updatedAt: 300,
      };

      const designCreate: OutboxEntry = {
        id: 'outbox-design',
        mutationId: 'mut-2',
        userId,
        projectId,
        entityType: 'system_design',
        entityId: 'design-child',
        operation: 'create',
        baseServerVersion: null,
        localRevision: 1,
        payload: { name: 'Child Design', folderId: 'subfolder-id' },
        state: 'pending',
        attemptCount: 0,
        createdAt: 250,
        updatedAt: 250,
      };

      const subfolderCreate: OutboxEntry = {
        id: 'outbox-subfolder',
        mutationId: 'mut-3',
        userId,
        projectId,
        entityType: 'workspace_folder',
        entityId: 'subfolder-id',
        operation: 'create',
        baseServerVersion: null,
        localRevision: 1,
        payload: { name: 'Subfolder', parentFolderId: 'root-folder-id' },
        state: 'pending',
        attemptCount: 0,
        createdAt: 200,
        updatedAt: 200,
      };

      const rootFolderCreate: OutboxEntry = {
        id: 'outbox-root-folder',
        mutationId: 'mut-4',
        userId,
        projectId,
        entityType: 'workspace_folder',
        entityId: 'root-folder-id',
        operation: 'create',
        baseServerVersion: null,
        localRevision: 1,
        payload: { name: 'Root Folder' },
        state: 'pending',
        attemptCount: 0,
        createdAt: 100,
        updatedAt: 100,
      };

      // Pass in reverse/scrambled order
      const ordered = orderOutboxByDependency([docCreate, designCreate, subfolderCreate, rootFolderCreate]);

      // Invariants:
      // 1. Root folder MUST be first
      expect(ordered[0].id).toBe('outbox-root-folder');
      // 2. Subfolder MUST precede both child entities
      expect(ordered[1].id).toBe('outbox-subfolder');
      // 3. Child entities follow subfolder
      const childIds = [ordered[2].id, ordered[3].id];
      expect(childIds).toContain('outbox-doc');
      expect(childIds).toContain('outbox-design');
    });

    it('enforces deletion order: Child Document & Design -> Subfolder -> Root Folder', () => {
      const rootFolderDelete: OutboxEntry = {
        id: 'del-root-folder',
        mutationId: 'mut-del-1',
        userId,
        projectId,
        entityType: 'workspace_folder',
        entityId: 'root-folder-id',
        operation: 'delete',
        baseServerVersion: '1',
        localRevision: 2,
        payload: null,
        state: 'pending',
        attemptCount: 0,
        createdAt: 50,
        updatedAt: 50,
      };

      const subfolderDelete: OutboxEntry = {
        id: 'del-subfolder',
        mutationId: 'mut-del-2',
        userId,
        projectId,
        entityType: 'workspace_folder',
        entityId: 'subfolder-id',
        operation: 'delete',
        baseServerVersion: '1',
        localRevision: 2,
        payload: { parentFolderId: 'root-folder-id' },
        state: 'pending',
        attemptCount: 0,
        createdAt: 60,
        updatedAt: 60,
      };

      const docDelete: OutboxEntry = {
        id: 'del-doc',
        mutationId: 'mut-del-3',
        userId,
        projectId,
        entityType: 'document',
        entityId: 'doc-child',
        operation: 'delete',
        baseServerVersion: '2',
        localRevision: 3,
        payload: { folderId: 'subfolder-id' },
        state: 'pending',
        attemptCount: 0,
        createdAt: 70,
        updatedAt: 70,
      };

      // Pass in reverse order (root folder delete first)
      const ordered = orderOutboxByDependency([rootFolderDelete, subfolderDelete, docDelete]);

      // Invariants:
      // 1. Child document must be deleted BEFORE subfolder
      const docIndex = ordered.findIndex((e) => e.id === 'del-doc');
      const subfolderIndex = ordered.findIndex((e) => e.id === 'del-subfolder');
      const rootFolderIndex = ordered.findIndex((e) => e.id === 'del-root-folder');

      expect(docIndex).toBeLessThan(subfolderIndex);
      // 2. Subfolder must be deleted BEFORE root folder
      expect(subfolderIndex).toBeLessThan(rootFolderIndex);
    });
  });
});
