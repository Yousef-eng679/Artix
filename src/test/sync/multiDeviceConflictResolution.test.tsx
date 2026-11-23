import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ArtixDB, deleteArtixDB } from '@/lib/local/db';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { WorkspaceFolderRepository } from '@/lib/repositories/folderRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { PullEngine } from '@/lib/sync/pullEngine';
import { SyncEngine } from '@/lib/sync/syncEngine';
import { TabCoordinator } from '@/lib/sync/tabCoordinator';
import { UserSyncRuntimeContext } from '@/contexts/UserSyncRuntimeContext';
import { ConflictResolutionCenter } from '@/components/ConflictResolutionModal';

const userId = 'user-task-10';
const projectId = '10101010-1010-4010-8010-101010101010';
const DOC_ID = 'aaaaaaaa-1010-4aaa-8aaa-aaaaaaaaaaaa';
const FOLDER_ID = 'ffffffff-1010-4fff-8fff-ffffffffffff';

function makeCoordinator(): TabCoordinator {
  return {
    isLeaderTab: () => true,
    getTabId: () => 'tab-task-10',
    requestLeaderSync: vi.fn(),
    onLeadershipChange: () => () => {},
    onSyncRequest: () => () => {},
    onCrossTabChange: () => () => {},
  } as unknown as TabCoordinator;
}

describe('TASK-10 (S-03, Amendment D): Multi-Device Conflict Resolution', () => {
  let db: ArtixDB;
  let outboxRepo: OutboxRepository;
  let syncMetadataRepo: SyncMetadataRepository;
  let conflictRepo: ConflictRepository;
  let docRepo: DocumentRepository;

  beforeEach(() => {
    db = new ArtixDB(`ArtixDB_task10_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    outboxRepo = new OutboxRepository(db);
    syncMetadataRepo = new SyncMetadataRepository(db);
    conflictRepo = new ConflictRepository(db);
    docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);
  });

  afterEach(async () => {
    const name = db.name;
    db.close();
    await deleteArtixDB(name);
  });

  async function seedSyncedDocWithLocalEdit() {
    await docRepo.applyRemoteSnapshot({
      id: DOC_ID,
      userId,
      projectId,
      title: 'Shared Doc',
      content: 'v1',
      serverVersion: '1',
    });
    await docRepo.update(DOC_ID, { content: 'Local edit' });
  }

  function engineWithRpc(rpc: () => Promise<any>) {
    return new SyncEngine({
      supabaseClient: { from: () => ({}), rpc: vi.fn(rpc) },
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
      pullEngine: { pullAll: async () => ({ totalPulled: 0, finalCursor: 0 }) } as any,
      tabCoordinator: makeCoordinator(),
    });
  }

  it('1. push remote_deleted conflict records reason; keep_local re-creates entity with fresh create mutation', async () => {
    await seedSyncedDocWithLocalEdit();
    const [original] = await outboxRepo.listByEntity(userId, 'document', DOC_ID);

    let rpc: () => Promise<any> = async () => ({
      data: { status: 'conflict', reason: 'remote_deleted', current_version: null },
      error: null,
    });
    const engine = engineWithRpc(() => rpc());
    await engine.triggerSync(userId);

    const [conflict] = await conflictRepo.listUnresolved(userId);
    expect(conflict).toBeDefined();
    expect(conflict.reason).toBe('remote_deleted');

    await conflictRepo.resolveConflict({ conflictId: conflict.id, strategy: 'keep_local' });

    const entries = await outboxRepo.listByEntity(userId, 'document', DOC_ID);
    expect(entries).toHaveLength(1);
    const [recreate] = entries;
    expect(recreate.operation).toBe('create');
    expect(recreate.baseServerVersion).toBeNull();
    expect(recreate.state).toBe('pending');
    expect(recreate.dispatched).toBe(false);
    expect(recreate.mutationId).toBeTruthy();
    expect(recreate.mutationId).not.toBe(original.mutationId);
    expect((recreate.payload as any).content).toBe('Local edit');
    expect((recreate.payload as any).title).toBe('Shared Doc');

    const meta = await syncMetadataRepo.get('document', DOC_ID);
    expect(meta?.syncState).toBe('pending');
    expect(meta?.serverVersion).toBeNull();

    // Server accepts the re-create
    rpc = async () => ({
      data: { status: 'applied', version: 1, updated_at: '2026-11-02T10:00:00.000Z' },
      error: null,
    });
    await engine.triggerSync(userId);
    expect(await outboxRepo.listByEntity(userId, 'document', DOC_ID)).toHaveLength(0);
    expect((await syncMetadataRepo.get('document', DOC_ID))?.syncState).toBe('synced');
    engine.destroy();
  });

  it('2. remote_deleted keep_remote soft-deletes locally, discards outbox and marks deleted_synced', async () => {
    await seedSyncedDocWithLocalEdit();
    const engine = engineWithRpc(async () => ({
      data: { status: 'conflict', reason: 'remote_deleted', current_version: null },
      error: null,
    }));
    await engine.triggerSync(userId);
    engine.destroy();

    const [conflict] = await conflictRepo.listUnresolved(userId);
    await conflictRepo.resolveConflict({ conflictId: conflict.id, strategy: 'keep_remote' });

    const local = await db.documents.get(DOC_ID);
    expect(local?.isDeleted).toBe(true);
    expect(await outboxRepo.listByEntity(userId, 'document', DOC_ID)).toHaveLength(0);
    expect((await syncMetadataRepo.get('document', DOC_ID))?.syncState).toBe('deleted_synced');
    expect(await conflictRepo.listUnresolved(userId)).toHaveLength(0);
  });

  it('3. remote_deleted create_copy keeps local work in a new entity and soft-deletes the original', async () => {
    await seedSyncedDocWithLocalEdit();
    const engine = engineWithRpc(async () => ({
      data: { status: 'conflict', reason: 'remote_deleted', current_version: null },
      error: null,
    }));
    await engine.triggerSync(userId);
    engine.destroy();

    const [conflict] = await conflictRepo.listUnresolved(userId);
    const { copyEntityId } = await conflictRepo.resolveConflict({
      conflictId: conflict.id,
      strategy: 'create_copy',
    });

    expect(copyEntityId).toBeTruthy();
    const copy = await db.documents.get(copyEntityId!);
    expect(copy?.content).toBe('Local edit');
    expect(copy?.isDeleted).toBe(false);
    const [copyEntry] = await outboxRepo.listByEntity(userId, 'document', copyEntityId!);
    expect(copyEntry.operation).toBe('create');
    expect(copyEntry.mutationId).toBeTruthy();

    expect((await db.documents.get(DOC_ID))?.isDeleted).toBe(true);
    expect(await outboxRepo.listByEntity(userId, 'document', DOC_ID)).toHaveLength(0);
  });

  it('4. create_copy supports workspace_folder version conflicts', async () => {
    const folderRepo = new WorkspaceFolderRepository(db, outboxRepo, syncMetadataRepo);
    await folderRepo.applyRemoteSnapshot({
      id: FOLDER_ID,
      userId,
      projectId,
      name: 'Specs',
      serverVersion: '1',
    });
    await folderRepo.rename(FOLDER_ID, 'Specs (mine)');

    const engine = engineWithRpc(async () => ({
      data: {
        status: 'conflict',
        reason: 'version_mismatch',
        current_version: 2,
        current_row: { id: FOLDER_ID, name: 'Specs (theirs)', project_id: projectId, version: 2 },
      },
      error: null,
    }));
    await engine.triggerSync(userId);
    engine.destroy();

    const [conflict] = await conflictRepo.listUnresolved(userId);
    expect(conflict.entityType).toBe('workspace_folder');
    expect(conflict.reason).toBe('version_mismatch');

    const { copyEntityId } = await conflictRepo.resolveConflict({
      conflictId: conflict.id,
      strategy: 'create_copy',
    });
    expect(copyEntityId).toBeTruthy();

    const copy = await db.workspace_folders.get(copyEntityId!);
    expect(copy?.name).toMatch(/Specs \(mine\)/);
    expect(copy?.projectId).toBe(projectId);
    const [copyEntry] = await outboxRepo.listByEntity(userId, 'workspace_folder', copyEntityId!);
    expect(copyEntry.operation).toBe('create');
    expect(copyEntry.mutationId).toBeTruthy();

    const original = await db.workspace_folders.get(FOLDER_ID);
    expect(original?.name).toBe('Specs (theirs)');
    expect((await syncMetadataRepo.get('workspace_folder', FOLDER_ID))?.serverVersion).toBe('2');
  });

  it('5. PullEngine remote delete vs local pending edit records remote_deleted and tags blocked entry as CONFLICT', async () => {
    await seedSyncedDocWithLocalEdit();
    const changes = [
      {
        sequence: 5,
        user_id: userId,
        entity_type: 'document',
        entity_id: DOC_ID,
        operation: 'delete',
        entity_version: 2,
        mutation_id: null,
        payload: {},
        changed_at: '2026-11-02T10:05:00.000Z',
      },
    ];
    let served = false;
    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            gt: () => ({
              order: () => ({
                limit: async () => {
                  if (served) return { data: [], error: null };
                  served = true;
                  return { data: changes, error: null };
                },
              }),
            }),
          }),
        }),
      }),
    };
    const pull = new PullEngine({ supabaseClient: mockSupabase, db, conflictRepo, syncMetadataRepo });
    await pull.pullAll(userId);

    const [conflict] = await conflictRepo.listUnresolved(userId);
    expect(conflict.reason).toBe('remote_deleted');
    const [entry] = await outboxRepo.listByEntity(userId, 'document', DOC_ID);
    expect(entry.state).toBe('blocked');
    expect(entry.lastError?.code).toBe('CONFLICT');
  });

  it('6. Amendment D: conflict UI is driven by unresolved db.conflicts rows and resolves via Keep Server', async () => {
    await seedSyncedDocWithLocalEdit();
    await conflictRepo.recordConflict({
      entityType: 'document',
      entityId: DOC_ID,
      userId,
      basePayload: { title: 'Shared Doc', content: 'v1' },
      localPayload: { title: 'Shared Doc', content: 'Local edit' },
      remotePayload: { id: DOC_ID, title: 'Shared Doc', content: 'Remote v2', version: 2 },
      reason: 'version_mismatch',
      remoteVersion: '2',
    });
    // syncState deliberately NOT 'conflict' -> UI must still surface the conflict row
    await syncMetadataRepo.upsert({ entityType: 'document', entityId: DOC_ID, userId, syncState: 'pending' });

    const engine = engineWithRpc(async () => ({
      data: { status: 'applied', version: 3, updated_at: '2026-11-02T10:10:00.000Z' },
      error: null,
    }));

    render(
      <MemoryRouter>
        <UserSyncRuntimeContext.Provider
          value={{
            runtime: { userId, conflictRepo } as any,
            db,
            projectRepo: null,
            documentRepo: docRepo,
            folderRepo: null,
            systemDesignRepo: null,
            outboxRepo,
            syncEngine: engine,
            tabCoordinator: makeCoordinator(),
            realtimeSync: null,
            isReady: true,
            runtimeStatus: null,
            isDegraded: false,
            runtimeError: null,
          }}
        >
          <ConflictResolutionCenter />
        </UserSyncRuntimeContext.Provider>
      </MemoryRouter>,
    );

    const banner = await screen.findByTestId('conflict-banner');
    expect(banner.textContent).toMatch(/1/);
    fireEvent.click(screen.getByTestId('review-conflicts-btn'));

    expect(await screen.findByTestId('conflict-modal')).toBeTruthy();
    expect(screen.getByText(/Shared Doc/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('conflict-keep-remote-btn'));

    await waitFor(async () => {
      expect(await conflictRepo.listUnresolved(userId)).toHaveLength(0);
    });
    expect((await db.documents.get(DOC_ID))?.content).toBe('Remote v2');
    await waitFor(() => expect(screen.queryByTestId('conflict-banner')).toBeNull());
    engine.destroy();
  });
});
