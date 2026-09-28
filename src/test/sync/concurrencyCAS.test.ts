import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { SyncEngine } from '@/lib/sync/syncEngine';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { DocumentPushAdapter, WorkspaceFolderPushAdapter, SystemDesignPushAdapter } from '@/lib/sync/adapters';
import { ArtixDB } from '@/lib/local/db';
import { OutboxEntry } from '@/lib/local/types';

describe('Phase 5: Server Concurrency Protocol & Compare-and-Swap (CAS)', () => {
  let db: ArtixDB;
  let outboxRepo: OutboxRepository;
  let syncMetadataRepo: SyncMetadataRepository;
  let conflictRepo: ConflictRepository;

  beforeEach(async () => {
    db = new ArtixDB(`TestDB_Phase5_${Date.now()}_${Math.random()}`);
    await db.open();
    outboxRepo = new OutboxRepository(db);
    syncMetadataRepo = new SyncMetadataRepository(db);
    conflictRepo = new ConflictRepository(db);
  });

  afterEach(async () => {
    await db.delete();
  });

  describe('Push Adapters CAS Verification', () => {
    it('DocumentPushAdapter passes version guard on update and succeeds when version matches', async () => {
      const adapter = new DocumentPushAdapter();

      let capturedVersion: number | null = null;
      const mockSupabase = {
        from: (table: string) => {
          expect(table).toBe('documents');
          return {
            update: (payload: any) => ({
              eq: (field: string, val: any) => {
                if (field === 'id') {
                  return {
                    eq: (f2: string, v2: any) => {
                      if (f2 === 'version') capturedVersion = v2;
                      return {
                        select: () => ({
                          maybeSingle: () => Promise.resolve({
                            data: { version: 3, updated_at: '2026-09-28T12:00:00Z' },
                            error: null,
                          }),
                        }),
                      };
                    },
                  };
                }
                return {};
              },
            }),
          };
        },
      };

      const entry: OutboxEntry = {
        id: 'out-doc-1',
        userId: 'u1',
        projectId: 'p1',
        entityType: 'document',
        entityId: 'doc-1',
        operation: 'update',
        payload: { title: 'Updated Title' },
        localRevision: 2,
        baseServerVersion: '2',
        state: 'pending',
        attemptCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const result = await adapter.push(entry, mockSupabase);
      expect(capturedVersion).toBe(2);
      expect(result?.version).toBe('3');
      expect(result?.updated_at).toBe('2026-09-28T12:00:00Z');
    });

    it('DocumentPushAdapter throws 409 CONFLICT when server version does not match', async () => {
      const adapter = new DocumentPushAdapter();

      const mockSupabase = {
        from: () => ({
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }),
        }),
      };

      const entry: OutboxEntry = {
        id: 'out-doc-conflict',
        userId: 'u1',
        projectId: 'p1',
        entityType: 'document',
        entityId: 'doc-1',
        operation: 'update',
        payload: { title: 'Conflicting Title' },
        localRevision: 2,
        baseServerVersion: '2',
        state: 'pending',
        attemptCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await expect(adapter.push(entry, mockSupabase)).rejects.toMatchObject({
        status: 409,
        code: 'CONFLICT',
      });
    });

    it('WorkspaceFolderPushAdapter throws 409 CONFLICT on version mismatch', async () => {
      const adapter = new WorkspaceFolderPushAdapter();

      const mockSupabase = {
        from: () => ({
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }),
        }),
      };

      const entry: OutboxEntry = {
        id: 'out-folder-conflict',
        userId: 'u1',
        projectId: 'p1',
        entityType: 'workspace_folder',
        entityId: 'folder-1',
        operation: 'update',
        payload: { name: 'Conflicting Folder Name' },
        localRevision: 2,
        baseServerVersion: '4',
        state: 'pending',
        attemptCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await expect(adapter.push(entry, mockSupabase)).rejects.toMatchObject({
        status: 409,
        code: 'CONFLICT',
      });
    });

    it('SystemDesignPushAdapter throws 409 CONFLICT on version mismatch', async () => {
      const adapter = new SystemDesignPushAdapter();

      const mockSupabase = {
        from: () => ({
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }),
        }),
      };

      const entry: OutboxEntry = {
        id: 'out-design-conflict',
        userId: 'u1',
        projectId: 'p1',
        entityType: 'system_design',
        entityId: 'design-1',
        operation: 'update',
        payload: { name: 'Conflicting Architecture' },
        localRevision: 2,
        baseServerVersion: '1',
        state: 'pending',
        attemptCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await expect(adapter.push(entry, mockSupabase)).rejects.toMatchObject({
        status: 409,
        code: 'CONFLICT',
      });
    });
  });

  describe('SyncEngine 3-Way Conflict Recording & Blocked Outbox State', () => {
    it('records 3-way conflict, marks sync state as conflict, and blocks outbox entry without infinite retries', async () => {
      // 1. Setup existing base snapshot in sync_metadata
      await syncMetadataRepo.upsert({
        entityType: 'document',
        entityId: 'doc-conflict-test',
        userId: 'user-cas',
        serverVersion: '1',
        serverUpdatedAt: '2026-09-28T00:00:00Z',
        localRevision: 2,
        syncState: 'pending',
        baseSnapshot: {
          title: 'Base Title',
          content: 'Base Content',
        },
      });

      // 2. Setup outbox entry with local modifications based on version '1'
      const entry: OutboxEntry = {
        id: 'outbox-cas-conflict',
        userId: 'user-cas',
        projectId: 'proj-1',
        entityType: 'document',
        entityId: 'doc-conflict-test',
        operation: 'update',
        payload: {
          title: 'Local Client Modification',
          content: 'Local Client Body',
        },
        localRevision: 2,
        baseServerVersion: '1',
        state: 'pending',
        attemptCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await db.outbox.add(entry);

      // 3. Mock remote Supabase returning 409 on update, and returning server concurrent row on select
      const remoteServerRow = {
        id: 'doc-conflict-test',
        version: 2, // Remote has moved to version 2
        title: 'Remote Device Concurrent Modification',
        content: 'Remote Device Concurrent Body',
        updated_at: '2026-09-28T10:00:00Z',
      };

      const mockSupabase = {
        from: (table: string) => ({
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }),
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: remoteServerRow, error: null }),
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

      // 4. Trigger sync
      await syncEngine.triggerSync('user-cas');

      // 5. Verify Conflict was recorded in ConflictRepository
      const conflicts = await conflictRepo.listByEntity('document', 'doc-conflict-test', 'user-cas');
      expect(conflicts.length).toBe(1);
      const conflict = conflicts[0];
      expect(conflict.entityId).toBe('doc-conflict-test');
      expect(conflict.basePayload).toEqual({
        title: 'Base Title',
        content: 'Base Content',
      });
      expect(conflict.localPayload).toEqual({
        title: 'Local Client Modification',
        content: 'Local Client Body',
      });
      expect(conflict.remotePayload).toEqual(remoteServerRow);

      // 6. Verify sync_metadata state is 'conflict'
      const meta = await syncMetadataRepo.get('document', 'doc-conflict-test');
      expect(meta?.syncState).toBe('conflict');

      // 7. Verify outbox entry is marked 'blocked' (non-retryable, no lease, nextRetryAt null)
      const outboxEntry = await outboxRepo.getById('outbox-cas-conflict');
      expect(outboxEntry?.state).toBe('blocked');
      expect(outboxEntry?.leaseOwner).toBeNull();
      expect(outboxEntry?.nextRetryAt).toBeNull();
      expect(outboxEntry?.lastError?.code).toBe('CONFLICT');

      // 8. Verify getPending with readyOnly does NOT pick up the blocked conflict entry
      const pendingReady = await outboxRepo.getPending(10, 'user-cas', { readyOnly: true });
      expect(pendingReady.length).toBe(0);
    });

    it('advances serverVersion and completes outbox entry when CAS update succeeds', async () => {
      await syncMetadataRepo.upsert({
        entityType: 'document',
        entityId: 'doc-success',
        userId: 'user-cas',
        serverVersion: '3',
        serverUpdatedAt: '2026-09-28T00:00:00Z',
        localRevision: 4,
        syncState: 'pending',
      });

      const entry: OutboxEntry = {
        id: 'outbox-doc-success',
        userId: 'user-cas',
        projectId: 'proj-1',
        entityType: 'document',
        entityId: 'doc-success',
        operation: 'update',
        payload: { title: 'Successful CAS Update' },
        localRevision: 4,
        baseServerVersion: '3',
        state: 'pending',
        attemptCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await db.outbox.add(entry);

      const mockSupabase = {
        from: () => ({
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: () => Promise.resolve({
                    data: { version: 4, updated_at: '2026-09-28T12:30:00Z' },
                    error: null,
                  }),
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

      await syncEngine.triggerSync('user-cas');

      // Outbox entry completed and deleted
      const remainingOutbox = await outboxRepo.getById('outbox-doc-success');
      expect(remainingOutbox).toBeUndefined();

      // Sync metadata marked as synced with new server version 4
      const meta = await syncMetadataRepo.get('document', 'doc-success');
      expect(meta?.syncState).toBe('synced');
      expect(meta?.serverVersion).toBe('4');
      expect(meta?.serverUpdatedAt).toBe('2026-09-28T12:30:00Z');
    });
  });
});
