import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ArtixDB } from '@/lib/local/db';
import { SyncEngine } from '@/lib/sync/syncEngine';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { WorkspaceFolderRepository } from '@/lib/repositories/folderRepository';
import { SystemDesignRepository } from '@/lib/repositories/systemDesignRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { PullEngine } from '@/lib/sync/pullEngine';
import {
  openUserRuntime,
  closeUserRuntime,
  getActiveUserRuntime,
} from '@/lib/sync/userSyncRuntime';

describe('Phase 9: End-to-End Offline Lifecycle & Network Simulation Matrix', () => {
  beforeEach(async () => {
    await closeUserRuntime();
  });

  afterEach(async () => {
    await closeUserRuntime();
  });

  describe('Scenario 1: Multi-Entity Offline Authoring & Topological Reconnection Sync', () => {
    it('creates hierarchy completely offline, then drains to cloud in correct dependency order', async () => {
      const db = new ArtixDB(`TestDB_Matrix1_${Date.now()}`);
      await db.open();

      const folderRepo = new WorkspaceFolderRepository(db);
      const docRepo = new DocumentRepository(db);
      const designRepo = new SystemDesignRepository(db);
      const outboxRepo = new OutboxRepository(db);
      const syncMetadataRepo = new SyncMetadataRepository(db);
      const conflictRepo = new ConflictRepository(db);

      const userId = 'user-matrix-1';
      const projectId = 'proj-matrix-1';

      // 1. Author hierarchy offline
      const folder = await folderRepo.create({
        userId,
        projectId,
        name: 'Backend Architecture',
      });
      expect(folder.id).toBeDefined();

      const doc = await docRepo.create({
        userId,
        projectId,
        folderId: folder.id,
        title: 'API Spec',
        content: '# API Endpoints',
      });
      expect(doc.id).toBeDefined();

      const design = await designRepo.create({
        userId,
        projectId,
        name: 'Service Graph',
      });
      expect(design.id).toBeDefined();

      // Update doc content offline
      await docRepo.update(doc.id, { content: '# API Endpoints v1.1' });

      // Invariant: all 4 operations are persistent locally in IndexedDB
      expect(await folderRepo.getById(folder.id)).toBeDefined();
      expect(await docRepo.getById(doc.id)).toBeDefined();
      expect(await designRepo.getById(design.id)).toBeDefined();
      expect((await docRepo.getById(doc.id))?.content).toBe('# API Endpoints v1.1');

      // Verify outbox has pending mutations (compacted: 1 folder + 1 doc + 1 design = 3)
      const pendingCount = await outboxRepo.countPending(userId);
      expect(pendingCount).toBe(3);

      // 2. Simulate reconnection: mock cloud Supabase backend tracking insertion order
      const pushedOperations: string[] = [];

      const mockSupabase = {
        from: (table: string) => ({
          upsert: (payload: any) => {
            pushedOperations.push(`${table}:create:${payload.id}`);
            return {
              select: () => ({
                single: () => Promise.resolve({
                  data: { version: 1, updated_at: '2026-09-28T12:00:00Z' },
                  error: null,
                }),
              }),
            };
          },
          update: (payload: any) => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: () => {
                    pushedOperations.push(`${table}:update`);
                    return Promise.resolve({
                      data: { version: 2, updated_at: '2026-09-28T12:05:00Z' },
                      error: null,
                    });
                  },
                }),
              }),
            }),
          }),
        }),
      };

      const syncEngine = new SyncEngine({
        supabaseClient: mockSupabase,
        outboxRepo,
        syncMetadataRepo,
        conflictRepo,
      });

      // 3. Trigger synchronization
      await syncEngine.triggerSync(userId);

      // 4. Verify topological order invariant: Folder MUST be pushed before child Document
      const folderPushIndex = pushedOperations.findIndex((op) => op === `workspace_folders:create:${folder.id}`);
      const docPushIndex = pushedOperations.findIndex((op) => op === `documents:create:${doc.id}`);

      expect(folderPushIndex).toBeGreaterThanOrEqual(0);
      expect(docPushIndex).toBeGreaterThanOrEqual(0);
      expect(folderPushIndex).toBeLessThan(docPushIndex);

      // 5. Verify outbox completely drained
      expect(await outboxRepo.countPending(userId)).toBe(0);

      // 6. Verify sync_metadata state is synced
      const docMeta = await syncMetadataRepo.get('document', doc.id);
      expect(docMeta?.syncState).toBe('synced');
      expect(docMeta?.serverVersion).toBe('1');

      const folderMeta = await syncMetadataRepo.get('workspace_folder', folder.id);
      expect(folderMeta?.syncState).toBe('synced');

      syncEngine.destroy();
      await db.delete();
    });
  });

  describe('Scenario 2: Network Timeout Mid-Drain and Recovery', () => {
    it('handles transport timeout during batch, preserves remaining queue, and converges on retry', async () => {
      const db = new ArtixDB(`TestDB_Matrix2_${Date.now()}`);
      await db.open();

      const docRepo = new DocumentRepository(db);
      const outboxRepo = new OutboxRepository(db);
      const syncMetadataRepo = new SyncMetadataRepository(db);
      const conflictRepo = new ConflictRepository(db);
      const userId = 'user-timeout-sim';

      // Create two documents offline
      const doc1 = await docRepo.create({ userId, title: 'Doc 1' });
      const doc2 = await docRepo.create({ userId, title: 'Doc 2' });

      expect(await outboxRepo.countPending(userId)).toBe(2);

      // First doc succeeds, second doc times out
      let doc1Pushed = false;
      const mockSupabase = {
        from: (table: string) => ({
          upsert: (payload: any) => {
            if (payload.id === doc1.id) {
              doc1Pushed = true;
              return {
                select: () => ({
                  single: () => Promise.resolve({
                    data: { version: 1, updated_at: '2026-09-28T12:00:00Z' },
                    error: null,
                  }),
                }),
              };
            } else {
              const timeoutErr: any = new Error('Network transport request timed out');
              timeoutErr.name = 'TimeoutError';
              timeoutErr.code = 'ETIMEDOUT';
              return {
                select: () => ({
                  single: () => Promise.reject(timeoutErr),
                }),
              };
            }
          },
        }),
      };

      const syncEngine = new SyncEngine({
        supabaseClient: mockSupabase,
        outboxRepo,
        syncMetadataRepo,
        conflictRepo,
      });

      // Trigger first sync -> doc1 pushed, doc2 times out
      await syncEngine.triggerSync(userId);

      expect(doc1Pushed).toBe(true);

      // Verify doc1 is synced and removed from outbox
      const doc1Meta = await syncMetadataRepo.get('document', doc1.id);
      expect(doc1Meta?.syncState).toBe('synced');

      // Verify doc2 is marked failed with backoff and lease released
      const outboxDoc2 = await outboxRepo.getById(
        (await outboxRepo.getPending(10, userId, { readyOnly: false }))[0]?.id
      );
      expect(outboxDoc2).toBeDefined();
      expect(outboxDoc2?.leaseOwner).toBeNull();
      expect(outboxDoc2?.lastError?.code).toBe('ETIMEDOUT');

      // Simulate recovery: network connection stabilizes
      const mockStableSupabase = {
        from: () => ({
          upsert: () => ({
            select: () => ({
              single: () => Promise.resolve({
                data: { version: 1, updated_at: '2026-09-28T12:10:00Z' },
                error: null,
              }),
            }),
          }),
        }),
      };

      const stableSyncEngine = new SyncEngine({
        supabaseClient: mockStableSupabase,
        outboxRepo,
        syncMetadataRepo,
        conflictRepo,
      });

      // Force retry ready by advancing clock or clearing backoff
      await db.outbox.update(outboxDoc2!.id, { nextRetryAt: Date.now() - 1000 });

      await stableSyncEngine.triggerSync(userId);

      // Outbox now fully drained
      expect(await outboxRepo.countPending(userId)).toBe(0);
      const doc2Meta = await syncMetadataRepo.get('document', doc2.id);
      expect(doc2Meta?.syncState).toBe('synced');

      syncEngine.destroy();
      stableSyncEngine.destroy();
      await db.delete();
    });
  });

  describe('Scenario 3: User Session Isolation & Cleanup', () => {
    it('guarantees complete database and repository isolation across user login/logout', async () => {
      const userAlice = 'user-alice-matrix';
      const userBob = 'user-bob-matrix';

      const dbAlice = new ArtixDB(`TestDB_AliceMatrix_${Date.now()}`);
      const dbBob = new ArtixDB(`TestDB_BobMatrix_${Date.now()}`);
      await dbAlice.open();
      await dbBob.open();

      // 1. Alice logs in and authors content
      const runtimeAlice = await openUserRuntime(userAlice, { db: dbAlice });
      expect(getActiveUserRuntime()?.userId).toBe(userAlice);

      const aliceDoc = await runtimeAlice.documentRepo.create({
        userId: userAlice,
        title: "Alice's Secret Strategy",
        content: 'Confidential',
      });
      expect(aliceDoc.id).toBeDefined();

      // 2. Alice logs out
      await closeUserRuntime(userAlice);
      expect(getActiveUserRuntime()).toBeUndefined();

      // 3. Bob logs in
      const runtimeBob = await openUserRuntime(userBob, { db: dbBob });
      expect(getActiveUserRuntime()?.userId).toBe(userBob);

      // Verify Bob sees 0 documents (no data leakage)
      const bobDocs = await runtimeBob.documentRepo.listAllByUser(userBob);
      expect(bobDocs.length).toBe(0);

      // Bob creates his own document
      await runtimeBob.documentRepo.create({
        userId: userBob,
        title: "Bob's Public Notes",
      });

      // 4. Bob logs out
      await closeUserRuntime(userBob);

      // 5. Alice logs back in
      const resumeAlice = await openUserRuntime(userAlice, { db: dbAlice });
      const aliceDocs = await resumeAlice.documentRepo.listAllByUser(userAlice);
      expect(aliceDocs.length).toBe(1);
      expect(aliceDocs[0].title).toBe("Alice's Secret Strategy");

      await closeUserRuntime(userAlice);
      await dbAlice.delete();
      await dbBob.delete();
    });
  });
});
