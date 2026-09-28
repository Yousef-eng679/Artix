import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { PullEngine } from '@/lib/sync/pullEngine';
import { SyncEngine } from '@/lib/sync/syncEngine';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { WorkspaceFolderRepository } from '@/lib/repositories/folderRepository';
import { SystemDesignRepository } from '@/lib/repositories/systemDesignRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { ArtixDB } from '@/lib/local/db';
import { OutboxEntry } from '@/lib/local/types';

describe('Phase 6: Durable Pull / Change Feed & Cursor Tracking', () => {
  let db: ArtixDB;
  let documentRepo: DocumentRepository;
  let folderRepo: WorkspaceFolderRepository;
  let systemDesignRepo: SystemDesignRepository;
  let conflictRepo: ConflictRepository;
  let syncMetadataRepo: SyncMetadataRepository;
  let outboxRepo: OutboxRepository;

  beforeEach(async () => {
    db = new ArtixDB(`TestDB_PullEngine_${Date.now()}_${Math.random()}`);
    await db.open();
    documentRepo = new DocumentRepository(db);
    folderRepo = new WorkspaceFolderRepository(db);
    systemDesignRepo = new SystemDesignRepository(db);
    conflictRepo = new ConflictRepository(db);
    syncMetadataRepo = new SyncMetadataRepository(db);
    outboxRepo = new OutboxRepository(db);
  });

  afterEach(async () => {
    await db.delete();
  });

  describe('Cursor Management', () => {
    it('defaults cursor to 0 and persists advancements in database_meta', async () => {
      const pullEngine = new PullEngine({ db });
      expect(await pullEngine.getCursor()).toBe(0);

      await pullEngine.setCursor(42);
      expect(await pullEngine.getCursor()).toBe(42);

      const meta = await db.database_meta.get('server_cursor');
      expect(meta?.value).toBe(42);
    });
  });

  describe('pullBatch & pullAll', () => {
    it('returns empty result when there are no new changes after current cursor', async () => {
      const mockSupabase = {
        from: (table: string) => {
          expect(table).toBe('sync_changes');
          return {
            select: () => ({
              eq: () => ({
                gt: () => ({
                  order: () => ({
                    limit: () => Promise.resolve({ data: [], error: null }),
                  }),
                }),
              }),
            }),
          };
        },
      };

      const pullEngine = new PullEngine({ db, supabaseClient: mockSupabase });
      const result = await pullEngine.pullBatch('user-p6');

      expect(result.pulledCount).toBe(0);
      expect(result.newCursor).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('pulls remote document, folder, and design changes and applies snapshots locally', async () => {
      const remoteChanges = [
        {
          sequence: 101,
          user_id: 'user-p6',
          entity_type: 'workspace_folder',
          entity_id: 'folder-remote-1',
          operation: 'create',
          entity_version: 1,
          payload: {
            id: 'folder-remote-1',
            user_id: 'user-p6',
            project_id: 'proj-1',
            name: 'Remote Inbound Folder',
            parent_folder_id: null,
            created_at: '2026-09-28T10:00:00Z',
            updated_at: '2026-09-28T10:00:00Z',
          },
          changed_at: '2026-09-28T10:00:00Z',
        },
        {
          sequence: 102,
          user_id: 'user-p6',
          entity_type: 'document',
          entity_id: 'doc-remote-1',
          operation: 'create',
          entity_version: 1,
          payload: {
            id: 'doc-remote-1',
            user_id: 'user-p6',
            project_id: 'proj-1',
            folder_id: 'folder-remote-1',
            title: 'Remote Document Title',
            content: '# Remote Content',
            format: 'markdown',
            created_at: '2026-09-28T10:01:00Z',
            updated_at: '2026-09-28T10:01:00Z',
          },
          changed_at: '2026-09-28T10:01:00Z',
        },
        {
          sequence: 103,
          user_id: 'user-p6',
          entity_type: 'system_design',
          entity_id: 'design-remote-1',
          operation: 'create',
          entity_version: 1,
          payload: {
            id: 'design-remote-1',
            user_id: 'user-p6',
            project_id: 'proj-1',
            folder_id: null,
            name: 'Remote Design Architecture',
            board_state: { nodes: [{ id: 'n1' }], edges: [], strokes: [] },
            created_at: '2026-09-28T10:02:00Z',
            updated_at: '2026-09-28T10:02:00Z',
          },
          changed_at: '2026-09-28T10:02:00Z',
        },
      ];

      const mockSupabase = {
        from: (table: string) => {
          expect(table).toBe('sync_changes');
          return {
            select: () => ({
              eq: () => ({
                gt: () => ({
                  order: () => ({
                    limit: () => Promise.resolve({ data: remoteChanges, error: null }),
                  }),
                }),
              }),
            }),
          };
        },
      };

      const pullEngine = new PullEngine({
        db,
        supabaseClient: mockSupabase,
        documentRepo,
        folderRepo,
        systemDesignRepo,
        conflictRepo,
        syncMetadataRepo,
      });

      const result = await pullEngine.pullBatch('user-p6');

      expect(result.pulledCount).toBe(3);
      expect(result.newCursor).toBe(103);
      expect(await pullEngine.getCursor()).toBe(103);

      // Verify folder applied locally
      const localFolder = await folderRepo.getById('folder-remote-1');
      expect(localFolder).toBeDefined();
      expect(localFolder?.name).toBe('Remote Inbound Folder');

      // Verify document applied locally
      const localDoc = await documentRepo.getById('doc-remote-1');
      expect(localDoc).toBeDefined();
      expect(localDoc?.title).toBe('Remote Document Title');
      expect(localDoc?.content).toBe('# Remote Content');

      // Verify system design applied locally
      const localDesign = await systemDesignRepo.getById('design-remote-1');
      expect(localDesign).toBeDefined();
      expect(localDesign?.name).toBe('Remote Design Architecture');

      // Verify sync_metadata marked synced with version
      const docMeta = await syncMetadataRepo.get('document', 'doc-remote-1');
      expect(docMeta?.syncState).toBe('synced');
      expect(docMeta?.serverVersion).toBe('1');

      // Verify outbox has zero mutations created by remote pull (clean hydration)
      expect(await outboxRepo.countPending('user-p6')).toBe(0);
    });

    it('applies remote delete operations by soft-deleting local rows without enqueuing outbox mutation', async () => {
      // 1. Seed existing local document
      await documentRepo.applyRemoteSnapshot({
        id: 'doc-to-be-deleted',
        userId: 'user-p6',
        projectId: 'proj-1',
        title: 'Original Title',
        content: 'Original Content',
        serverVersion: '1',
      });

      const remoteChanges = [
        {
          sequence: 200,
          user_id: 'user-p6',
          entity_type: 'document',
          entity_id: 'doc-to-be-deleted',
          operation: 'delete',
          entity_version: 2,
          payload: null,
          changed_at: '2026-09-28T11:00:00Z',
        },
      ];

      const mockSupabase = {
        from: () => ({
          select: () => ({
            eq: () => ({
              gt: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: remoteChanges, error: null }),
                }),
              }),
            }),
          }),
        }),
      };

      const pullEngine = new PullEngine({
        db,
        supabaseClient: mockSupabase,
        documentRepo,
        folderRepo,
        systemDesignRepo,
        conflictRepo,
        syncMetadataRepo,
      });

      const result = await pullEngine.pullBatch('user-p6');
      expect(result.pulledCount).toBe(1);
      expect(result.newCursor).toBe(200);

      // Verify local document is soft-deleted
      const localDoc = await db.documents.get('doc-to-be-deleted');
      expect(localDoc?.isDeleted).toBe(true);

      // Verify 0 outbox entries (no outbound echo)
      expect(await outboxRepo.countPending('user-p6')).toBe(0);
    });

    it('captures 3-way conflict when remote change collides with pending local outbox edits, preserving local draft', async () => {
      // 1. Base snapshot in sync_metadata
      await syncMetadataRepo.upsert({
        entityType: 'document',
        entityId: 'doc-collision',
        userId: 'user-p6',
        serverVersion: '1',
        localRevision: 2,
        syncState: 'pending',
        baseSnapshot: { title: 'Base Title', content: 'Base Text' },
      });

      // 2. Local client made unpushed changes
      const localDoc = {
        id: 'doc-collision',
        userId: 'user-p6',
        projectId: 'proj-1',
        folderId: null,
        title: 'User Local Unpushed Draft',
        content: 'Important unsaved work',
        format: 'markdown' as const,
        createdAt: '2026-09-28T09:00:00Z',
        updatedAt: '2026-09-28T09:10:00Z',
        localRevision: 2,
        isDeleted: false,
      };
      await db.documents.put(localDoc);

      const outboxEntry: OutboxEntry = {
        id: 'outbox-coll',
        userId: 'user-p6',
        projectId: 'proj-1',
        entityType: 'document',
        entityId: 'doc-collision',
        operation: 'update',
        payload: { title: 'User Local Unpushed Draft', content: 'Important unsaved work' },
        localRevision: 2,
        baseServerVersion: '1',
        state: 'pending',
        attemptCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await db.outbox.add(outboxEntry);

      // 3. Remote change feed brings concurrent edit from another device
      const remoteChanges = [
        {
          sequence: 500,
          user_id: 'user-p6',
          entity_type: 'document',
          entity_id: 'doc-collision',
          operation: 'update',
          entity_version: 2,
          payload: {
            id: 'doc-collision',
            user_id: 'user-p6',
            project_id: 'proj-1',
            title: 'Remote Device Concurrent Edit',
            content: 'Remote Text',
            updated_at: '2026-09-28T09:15:00Z',
          },
          changed_at: '2026-09-28T09:15:00Z',
        },
      ];

      const mockSupabase = {
        from: () => ({
          select: () => ({
            eq: () => ({
              gt: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: remoteChanges, error: null }),
                }),
              }),
            }),
          }),
        }),
      };

      const pullEngine = new PullEngine({
        db,
        supabaseClient: mockSupabase,
        documentRepo,
        folderRepo,
        systemDesignRepo,
        conflictRepo,
        syncMetadataRepo,
      });

      const result = await pullEngine.pullBatch('user-p6');
      expect(result.pulledCount).toBe(1);
      expect(result.newCursor).toBe(500);

      // 4. Invariant: User's local unpushed draft MUST NOT be overwritten!
      const currentDoc = await documentRepo.getById('doc-collision');
      expect(currentDoc?.title).toBe('User Local Unpushed Draft');
      expect(currentDoc?.content).toBe('Important unsaved work');

      // 5. 3-way conflict record created
      const conflicts = await conflictRepo.listByEntity('document', 'doc-collision', 'user-p6');
      expect(conflicts.length).toBe(1);
      expect(conflicts[0].basePayload).toEqual({ title: 'Base Title', content: 'Base Text' });
      expect(conflicts[0].localPayload).toEqual({ title: 'User Local Unpushed Draft', content: 'Important unsaved work' });
      expect(conflicts[0].remotePayload).toEqual(remoteChanges[0].payload);

      // 6. Metadata marked as 'conflict'
      const meta = await syncMetadataRepo.get('document', 'doc-collision');
      expect(meta?.syncState).toBe('conflict');
    });
  });

  describe('SyncEngine Pull Integration', () => {
    it('SyncEngine.pullChanges triggers pullAll and returns total count', async () => {
      const mockPullEngine = {
        pullAll: vi.fn().mockResolvedValue({ totalPulled: 5, finalCursor: 150 }),
      };

      const syncEngine = new SyncEngine({
        pullEngine: mockPullEngine as any,
        outboxRepo,
        syncMetadataRepo,
      });

      const res = await syncEngine.pullChanges('user-p6');
      expect(res.totalPulled).toBe(5);
      expect(res.finalCursor).toBe(150);
      expect(mockPullEngine.pullAll).toHaveBeenCalledWith('user-p6');
    });
  });
});
