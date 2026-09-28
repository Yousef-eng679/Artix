import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ConflictResolver } from '@/lib/sync/conflictResolver';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { ArtixDB } from '@/lib/local/db';
import { OutboxEntry, LocalDocument, LocalSystemDesign } from '@/lib/local/types';

describe('Phase 7: Conflict System & Resolution Workflows', () => {
  let db: ArtixDB;
  let conflictRepo: ConflictRepository;

  beforeEach(async () => {
    db = new ArtixDB(`TestDB_ConflictSystem_${Date.now()}_${Math.random()}`);
    await db.open();
    conflictRepo = new ConflictRepository(db);
  });

  afterEach(async () => {
    await db.delete();
  });

  describe('ConflictResolver Utilities', () => {
    it('normalizes folder names with canonical Unicode (NFKC) and trims whitespace', () => {
      expect(ConflictResolver.normalizeFolderName('   Project Specs   ')).toBe('Project Specs');
      // Full-width characters to standard ASCII
      expect(ConflictResolver.normalizeFolderName('Ｆｏｌｄｅｒ')).toBe('Folder');
      expect(ConflictResolver.normalizeFolderName('')).toBe('Untitled Folder');
      expect(ConflictResolver.normalizeFolderName('    ')).toBe('Untitled Folder');
    });

    it('generates non-colliding folder conflict copy names', () => {
      const name1 = ConflictResolver.resolveFolderConflictName('Architecture');
      expect(name1).toBe('Architecture (Conflict Copy)');

      const name2 = ConflictResolver.resolveFolderConflictName('Architecture', ['Architecture (Conflict Copy)']);
      expect(name2).toBe('Architecture (Conflict Copy 2)');

      const name3 = ConflictResolver.resolveFolderConflictName('Architecture', [
        'Architecture (Conflict Copy)',
        'Architecture (Conflict Copy 2)',
      ]);
      expect(name3).toBe('Architecture (Conflict Copy 3)');
    });

    it('generates timestamped conflict copy name for system design', () => {
      const res = ConflictResolver.resolveSystemDesignConflict('Auth Flow', { nodes: [] }, { nodes: [] });
      expect(res.conflictCopyName).toContain('Auth Flow (Conflict Copy -');
    });
  });

  describe('ConflictRepository Resolution Workflows', () => {
    it("strategy 'keep_local': unblocks outbox entry with updated remote baseServerVersion", async () => {
      // 1. Seed document
      const doc: LocalDocument = {
        id: 'doc-kl',
        userId: 'u-conf',
        projectId: 'p1',
        folderId: null,
        title: 'Local Modified Title',
        content: 'Local text',
        format: 'markdown',
        createdAt: '2026-09-28T00:00:00Z',
        updatedAt: '2026-09-28T01:00:00Z',
        localRevision: 2,
        isDeleted: false,
      };
      await db.documents.add(doc);

      // 2. Seed blocked outbox entry
      const outbox: OutboxEntry = {
        id: 'outbox-kl',
        userId: 'u-conf',
        projectId: 'p1',
        entityType: 'document',
        entityId: 'doc-kl',
        operation: 'update',
        payload: { title: 'Local Modified Title' },
        localRevision: 2,
        baseServerVersion: '1',
        state: 'blocked',
        attemptCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await db.outbox.add(outbox);

      // 3. Seed conflict record
      const conflict = await conflictRepo.recordConflict({
        entityType: 'document',
        entityId: 'doc-kl',
        userId: 'u-conf',
        basePayload: { version: 1, title: 'Original' },
        localPayload: { title: 'Local Modified Title' },
        remotePayload: { version: 2, title: 'Remote Concurrent Title' },
      });

      // 4. Resolve conflict choosing keep_local
      const result = await conflictRepo.resolveConflict({
        conflictId: conflict.id,
        strategy: 'keep_local',
      });

      expect(result.strategy).toBe('keep_local');
      expect(result.resolvedAt).toBeDefined();

      // Verify conflict marked resolved
      const updatedConflict = await conflictRepo.getById(conflict.id);
      expect(updatedConflict?.resolvedAt).toBeGreaterThan(0);

      // Verify document still has local title
      const currentDoc = await db.documents.get('doc-kl');
      expect(currentDoc?.title).toBe('Local Modified Title');

      // Verify outbox entry is unblocked ('pending') and baseServerVersion advanced to remote '2'
      const updatedOutbox = await db.outbox.get('outbox-kl');
      expect(updatedOutbox?.state).toBe('pending');
      expect(updatedOutbox?.baseServerVersion).toBe('2');
      expect(updatedOutbox?.attemptCount).toBe(0);
    });

    it("strategy 'keep_remote': adopts remote payload, discards outbox entry, marks synced", async () => {
      const doc: LocalDocument = {
        id: 'doc-kr',
        userId: 'u-conf',
        projectId: 'p1',
        folderId: null,
        title: 'Local Stale Title',
        content: 'Local text',
        format: 'markdown',
        createdAt: '2026-09-28T00:00:00Z',
        updatedAt: '2026-09-28T01:00:00Z',
        localRevision: 2,
        isDeleted: false,
      };
      await db.documents.add(doc);

      const outbox: OutboxEntry = {
        id: 'outbox-kr',
        userId: 'u-conf',
        projectId: 'p1',
        entityType: 'document',
        entityId: 'doc-kr',
        operation: 'update',
        payload: { title: 'Local Stale Title' },
        localRevision: 2,
        baseServerVersion: '1',
        state: 'blocked',
        attemptCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await db.outbox.add(outbox);

      const conflict = await conflictRepo.recordConflict({
        entityType: 'document',
        entityId: 'doc-kr',
        userId: 'u-conf',
        basePayload: { version: 1, title: 'Original' },
        localPayload: { title: 'Local Stale Title' },
        remotePayload: {
          id: 'doc-kr',
          user_id: 'u-conf',
          project_id: 'p1',
          version: 2,
          title: 'Remote Authoritative Title',
          content: 'Remote Text Body',
          updated_at: '2026-09-28T02:00:00Z',
        },
      });

      await conflictRepo.resolveConflict({
        conflictId: conflict.id,
        strategy: 'keep_remote',
      });

      // Verify local document adopted remote values
      const currentDoc = await db.documents.get('doc-kr');
      expect(currentDoc?.title).toBe('Remote Authoritative Title');
      expect(currentDoc?.content).toBe('Remote Text Body');

      // Verify outbox entry removed
      const remainingOutbox = await db.outbox.get('outbox-kr');
      expect(remainingOutbox).toBeUndefined();

      // Verify sync_metadata is marked synced with remote version 2
      const meta = await db.sync_metadata.get('document:doc-kr');
      expect(meta?.syncState).toBe('synced');
      expect(meta?.serverVersion).toBe('2');
    });

    it("strategy 'merge_document': sets merged text, queues update outbox with remote base version", async () => {
      const doc: LocalDocument = {
        id: 'doc-md',
        userId: 'u-conf',
        projectId: 'p1',
        folderId: null,
        title: 'Document Under Merge',
        content: 'Original Content',
        format: 'markdown',
        createdAt: '2026-09-28T00:00:00Z',
        updatedAt: '2026-09-28T01:00:00Z',
        localRevision: 2,
        isDeleted: false,
      };
      await db.documents.add(doc);

      const outbox: OutboxEntry = {
        id: 'outbox-md',
        userId: 'u-conf',
        projectId: 'p1',
        entityType: 'document',
        entityId: 'doc-md',
        operation: 'update',
        payload: { content: 'Local Content' },
        localRevision: 2,
        baseServerVersion: '1',
        state: 'blocked',
        attemptCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await db.outbox.add(outbox);

      const conflict = await conflictRepo.recordConflict({
        entityType: 'document',
        entityId: 'doc-md',
        userId: 'u-conf',
        basePayload: { version: 1, content: 'Original Content' },
        localPayload: { content: 'Local Content' },
        remotePayload: { version: 2, content: 'Remote Content' },
      });

      const mergedContent = 'Combined Merged Line 1\nCombined Merged Line 2';

      await conflictRepo.resolveConflict({
        conflictId: conflict.id,
        strategy: 'merge_document',
        mergedContent,
      });

      // Verify document content updated to merged text
      const currentDoc = await db.documents.get('doc-md');
      expect(currentDoc?.content).toBe(mergedContent);

      // Verify outbox entry is pending with merged content and baseServerVersion '2'
      const updatedOutbox = await db.outbox.get('outbox-md');
      expect(updatedOutbox?.state).toBe('pending');
      expect(updatedOutbox?.baseServerVersion).toBe('2');
      expect((updatedOutbox?.payload as any)?.content).toBe(mergedContent);
    });

    it("strategy 'create_copy': forks new entity with local changes, reverts original to remote", async () => {
      const design: LocalSystemDesign = {
        id: 'des-orig',
        userId: 'u-conf',
        projectId: 'p1',
        folderId: null,
        name: 'Core System',
        boardState: { nodes: [{ id: 'local-node' } as any], edges: [], strokes: [] },
        createdAt: '2026-09-28T00:00:00Z',
        updatedAt: '2026-09-28T01:00:00Z',
        localRevision: 2,
        isDeleted: false,
      };
      await db.system_designs.add(design);

      const outbox: OutboxEntry = {
        id: 'outbox-des-orig',
        userId: 'u-conf',
        projectId: 'p1',
        entityType: 'system_design',
        entityId: 'des-orig',
        operation: 'update',
        payload: { name: 'Core System (Local Edit)' },
        localRevision: 2,
        baseServerVersion: '1',
        state: 'blocked',
        attemptCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await db.outbox.add(outbox);

      const conflict = await conflictRepo.recordConflict({
        entityType: 'system_design',
        entityId: 'des-orig',
        userId: 'u-conf',
        basePayload: { version: 1, name: 'Core System' },
        localPayload: { name: 'Core System (Local Edit)' },
        remotePayload: {
          id: 'des-orig',
          user_id: 'u-conf',
          project_id: 'p1',
          version: 2,
          name: 'Core System (Cloud Version)',
          board_state: { nodes: [{ id: 'remote-node' }], edges: [], strokes: [] },
        },
      });

      const res = await conflictRepo.resolveConflict({
        conflictId: conflict.id,
        strategy: 'create_copy',
        copyTitle: 'Core System (My Fork)',
      });

      expect(res.copyEntityId).toBeDefined();

      // 1. Verify original entity reverted to remote and marked synced
      const originalDesign = await db.system_designs.get('des-orig');
      expect(originalDesign?.name).toBe('Core System (Cloud Version)');
      const origOutbox = await db.outbox.get('outbox-des-orig');
      expect(origOutbox).toBeUndefined();

      // 2. Verify new copy entity created in system_designs
      const copyDesign = await db.system_designs.get(res.copyEntityId!);
      expect(copyDesign).toBeDefined();
      expect(copyDesign?.name).toBe('Core System (My Fork)');
      expect(copyDesign?.boardState.nodes[0]?.id).toBe('local-node');

      // 3. Verify new copy enqueued in outbox for synchronization to cloud
      const copyOutbox = await db.outbox
        .where('[userId+entityType+entityId]')
        .equals(['u-conf', 'system_design', res.copyEntityId!])
        .first();
      expect(copyOutbox).toBeDefined();
      expect(copyOutbox?.operation).toBe('create');
      expect(copyOutbox?.state).toBe('pending');
    });
  });
});
