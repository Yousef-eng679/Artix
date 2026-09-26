import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getArtixDB, deleteArtixDB, ArtixDB } from '../../lib/local/db';
import { OutboxRepository } from '../../lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '../../lib/repositories/syncMetadataRepository';
import { SyncEngine } from '../../lib/sync/syncEngine';

describe('SyncEngine', () => {
  const TEST_DB_NAME = 'ArtixDB_test_sync_engine';
  let db: ArtixDB;
  let outboxRepo: OutboxRepository;
  let syncMetadataRepo: SyncMetadataRepository;

  beforeEach(async () => {
    await deleteArtixDB(TEST_DB_NAME);
    db = getArtixDB(TEST_DB_NAME);
    outboxRepo = new OutboxRepository(db);
    syncMetadataRepo = new SyncMetadataRepository(db);
  });

  afterEach(async () => {
    await deleteArtixDB(TEST_DB_NAME);
  });

  it('calculates exponential backoff delay correctly', () => {
    const engine = new SyncEngine({ outboxRepo, syncMetadataRepo });
    expect(engine.getBackoffDelay(1)).toBe(1000); // 1s
    expect(engine.getBackoffDelay(2)).toBe(2000); // 2s
    expect(engine.getBackoffDelay(3)).toBe(4000); // 4s
    expect(engine.getBackoffDelay(4)).toBe(8000); // 8s
    expect(engine.getBackoffDelay(5)).toBe(16000); // 16s
    expect(engine.getBackoffDelay(6)).toBe(30000); // capped at 30s
    engine.destroy();
  });

  it('drains pending outbox mutations to Supabase and marks them completed', async () => {
    // 1. Enqueue a pending mutation
    await outboxRepo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-sync-1',
      operation: 'create',
      payload: { title: 'Synced Doc', content: 'Synced Content', format: 'markdown' },
      localRevision: 1,
    });

    expect(await outboxRepo.countPending('user-1')).toBe(1);

    // 2. Mock Supabase client
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        upsert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { updated_at: '2026-09-26T12:00:00Z' },
              error: null,
            }),
          }),
        }),
      }),
    };

    const engine = new SyncEngine({
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
    });

    await engine.triggerSync('user-1');

    // Outbox should be drained (0 pending)
    expect(await outboxRepo.countPending('user-1')).toBe(0);

    // Sync metadata should be marked synced
    const meta = await syncMetadataRepo.get('document', 'doc-sync-1');
    expect(meta?.syncState).toBe('synced');
    expect(meta?.serverUpdatedAt).toBe('2026-09-26T12:00:00Z');

    // Engine should report idle and non-null lastSyncedAt
    const status = engine.getStatus();
    expect(status.state).toBe('idle');
    expect(status.lastSyncedAt).not.toBeNull();

    engine.destroy();
  });

  it('pushes update operation for document to Supabase update endpoint', async () => {
    await outboxRepo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-sync-upd',
      operation: 'update',
      payload: { title: 'Updated Title', content: 'Updated Body' },
      localRevision: 2,
    });

    const mockUpdate = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { updated_at: '2026-09-26T12:30:00Z' },
            error: null,
          }),
        }),
      }),
    });

    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        update: mockUpdate,
      }),
    };

    const engine = new SyncEngine({
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
    });

    await engine.triggerSync('user-1');

    expect(mockSupabase.from).toHaveBeenCalledWith('documents');
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Updated Title',
        content: 'Updated Body',
      })
    );
    expect(await outboxRepo.countPending('user-1')).toBe(0);

    const meta = await syncMetadataRepo.get('document', 'doc-sync-upd');
    expect(meta?.syncState).toBe('synced');
    expect(meta?.serverUpdatedAt).toBe('2026-09-26T12:30:00Z');

    engine.destroy();
  });

  it('pushes delete operation for document to Supabase delete endpoint', async () => {
    await outboxRepo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-sync-del',
      operation: 'delete',
      payload: null,
      localRevision: 3,
    });

    const mockEq = vi.fn().mockResolvedValue({ error: null });
    const mockDelete = vi.fn().mockReturnValue({ eq: mockEq });

    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        delete: mockDelete,
      }),
    };

    const engine = new SyncEngine({
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
    });

    await engine.triggerSync('user-1');

    expect(mockSupabase.from).toHaveBeenCalledWith('documents');
    expect(mockDelete).toHaveBeenCalled();
    expect(mockEq).toHaveBeenCalledWith('id', 'doc-sync-del');
    expect(await outboxRepo.countPending('user-1')).toBe(0);

    engine.destroy();
  });

  it('delegates sync to leader tab when current tab is standby', async () => {
    const mockTabCoordinator = {
      isLeaderTab: vi.fn().mockReturnValue(false), // Standby tab
      requestLeaderSync: vi.fn(),
      onSyncRequest: vi.fn().mockReturnValue(() => {}),
    };

    const mockSupabase = {
      from: vi.fn(),
    };

    const engine = new SyncEngine({
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
      tabCoordinator: mockTabCoordinator as any,
    });

    await engine.triggerSync('user-1');

    expect(mockTabCoordinator.isLeaderTab).toHaveBeenCalled();
    expect(mockTabCoordinator.requestLeaderSync).toHaveBeenCalled();
    expect(mockSupabase.from).not.toHaveBeenCalled();

    engine.destroy();
  });

  it('computes accurate pending count via getStatusWithPending', async () => {
    await outboxRepo.enqueue({
      userId: 'user-pending-test',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-p-1',
      operation: 'create',
      payload: { title: 'Doc P1' },
      localRevision: 1,
    });
    await outboxRepo.enqueue({
      userId: 'user-pending-test',
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-p-2',
      operation: 'create',
      payload: { title: 'Doc P2' },
      localRevision: 1,
    });

    const engine = new SyncEngine({
      outboxRepo,
      syncMetadataRepo,
    });

    const status = await engine.getStatusWithPending('user-pending-test');
    expect(status.pendingCount).toBe(2);

    engine.destroy();
  });

  it('handles transient network error during push and marks entry failed for retry', async () => {
    await outboxRepo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'system_design',
      entityId: 'design-err-1',
      operation: 'create',
      payload: { name: 'Failing Design' },
      localRevision: 1,
    });

    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        upsert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockRejectedValue(new Error('Network fetch failed')),
          }),
        }),
      }),
    };

    const engine = new SyncEngine({
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
      maxRetries: 3,
    });

    await engine.triggerSync('user-1');

    // Entry should still exist, attemptCount incremented to 1
    const pending = await outboxRepo.getPending(undefined, 'user-1');
    expect(pending).toHaveLength(1);
    expect(pending[0].attemptCount).toBe(1);
    expect(pending[0].lastError?.code).toBe('NETWORK_ERROR');

    // Engine state should be error
    expect(engine.getStatus().state).toBe('error');

    engine.destroy();
  });

  it('notifies subscribers of status changes during sync cycle', async () => {
    await outboxRepo.enqueue({
      userId: 'user-1',
      projectId: 'proj-1',
      entityType: 'workspace_folder',
      entityId: 'folder-sync-1',
      operation: 'create',
      payload: { name: 'Folder 1' },
      localRevision: 1,
    });

    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        upsert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { updated_at: '2026-09-26T12:00:00Z' },
              error: null,
            }),
          }),
        }),
      }),
    };

    const engine = new SyncEngine({
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
    });

    const statusUpdates: string[] = [];
    const unsubscribe = engine.subscribe((s) => {
      statusUpdates.push(s.state);
    });

    await engine.triggerSync('user-1');
    unsubscribe();

    // Sequence should go through syncing -> idle
    expect(statusUpdates).toContain('syncing');
    expect(statusUpdates).toContain('idle');

    engine.destroy();
  });
});
