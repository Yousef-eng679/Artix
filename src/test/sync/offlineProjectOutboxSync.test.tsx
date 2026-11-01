import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { ArtixDB, deleteArtixDB, getUserArtixDB } from '@/lib/local/db';
import { OutboxEntry } from '@/lib/local/types';
import { MissingCasBaselineError } from '@/lib/local/errors';
import { ProjectRepository } from '@/lib/repositories/projectRepository';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { WorkspaceFolderRepository } from '@/lib/repositories/folderRepository';
import { SystemDesignRepository } from '@/lib/repositories/systemDesignRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { orderOutboxByDependency } from '@/lib/sync/dependencyOrder';
import { getPushAdapter } from '@/lib/sync/adapters';
import { PullEngine } from '@/lib/sync/pullEngine';
import { SyncEngine } from '@/lib/sync/syncEngine';
import { TabCoordinator } from '@/lib/sync/tabCoordinator';
import { useProjects } from '@/hooks/useProjects';

const supabaseMockState = vi.hoisted(() => ({
  online: false,
  rpcCalls: [] as Array<{ fn: string; params: Record<string, any> }>,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: async () => ({
            data: null,
            error: { message: 'TypeError: Failed to fetch', code: '' },
          }),
        }),
      }),
    }),
    rpc: vi.fn(async (fn: string, params: Record<string, any>) => {
      supabaseMockState.rpcCalls.push({ fn, params });
      return {
        data: { status: 'applied', version: 1, updated_at: '2026-11-01T12:00:00.000Z' },
        error: null,
      };
    }),
  },
}));

const authMockState = {
  user: { id: 'user-proj-sync', email: 'architect@artix.local' },
  isOfflineSession: true,
};

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: authMockState.user,
    session: { user: authMockState.user },
    loading: false,
    sessionError: null,
    isOfflineSession: authMockState.isOfflineSession,
    reauthRequired: false,
  }),
}));

const runtimeMockState = {
  db: null as ArtixDB | null,
};

vi.mock('@/contexts/UserSyncRuntimeContext', () => ({
  useUserSyncRuntime: () =>
    runtimeMockState.db
      ? {
          runtime: null,
          db: runtimeMockState.db,
          projectRepo: null,
          documentRepo: null,
          folderRepo: null,
          systemDesignRepo: null,
          outboxRepo: null,
          syncEngine: null,
          tabCoordinator: null,
          realtimeSync: null,
          isReady: true,
          runtimeStatus: null,
          isDegraded: false,
          runtimeError: null,
        }
      : null,
}));

describe('TASK-26B (OF-04 Option B): Full Outbox-Synced Projects Entity', () => {
  const userId = 'user-proj-sync';
  let db: ArtixDB;
  let originalOnLineDescriptor: PropertyDescriptor | undefined;

  function setBrowserOnline(online: boolean) {
    supabaseMockState.online = online;
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => online,
    });
    onlineManager.setOnline(online);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    supabaseMockState.rpcCalls = [];
    await deleteArtixDB();
    originalOnLineDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
    setBrowserOnline(false);
    authMockState.isOfflineSession = true;
    db = getUserArtixDB(userId);
    runtimeMockState.db = db;
  });

  afterEach(async () => {
    setBrowserOnline(true);
    if (originalOnLineDescriptor) {
      Object.defineProperty(window.navigator, 'onLine', originalOnLineDescriptor);
    }
    runtimeMockState.db = null;
    await deleteArtixDB();
  });

  it('1. ProjectRepository supports atomic offline create/rename/delete, cascades local child soft-deletes, and cancels unpushed offline project trees', async () => {
    const outboxRepo = new OutboxRepository(db);
    const projectRepo = new ProjectRepository(db, outboxRepo);
    const folderRepo = new WorkspaceFolderRepository(db, outboxRepo);
    const docRepo = new DocumentRepository(db, outboxRepo);
    const designRepo = new SystemDesignRepository(db, outboxRepo);

    const project = await projectRepo.create({
      id: '11111111-1111-4111-8111-111111111111',
      userId,
      name: 'Offline Control Plane',
    });

    expect(project.localRevision).toBe(1);
    expect(project.isDeleted).toBe(false);

    const renamed = await projectRepo.rename(project.id, 'Offline Control Plane v2');
    expect(renamed.name).toBe('Offline Control Plane v2');
    expect(renamed.localRevision).toBe(2);

    // Create child folder, document, and system design inside the offline project
    const folder = await folderRepo.create({
      userId,
      projectId: project.id,
      name: 'Specs',
    });
    const doc = await docRepo.create({
      userId,
      projectId: project.id,
      folderId: folder.id,
      title: 'RFC 001',
      content: '# Offline RFC',
    });
    const design = await designRepo.create({
      userId,
      projectId: project.id,
      folderId: folder.id,
      name: 'Topology',
      boardState: { nodes: [], edges: [] },
    });

    expect(await outboxRepo.countPending(userId)).toBe(4);

    // Deleting the unpushed project offline cancels the project create AND purges child outbox entries + soft-deletes children
    await projectRepo.delete(project.id);

    expect(await projectRepo.listByUser(userId)).toHaveLength(0);
    expect(await folderRepo.listByProject(userId, project.id)).toHaveLength(0);
    expect(await docRepo.listByProject(userId, project.id)).toHaveLength(0);
    expect(await designRepo.listByProject(userId, project.id)).toHaveLength(0);
    expect(await outboxRepo.countPending(userId)).toBe(0);
  });

  it('2. orderOutboxByDependency guarantees project create precedes folder/document/design creates and child deletes precede project delete', () => {
    const projectId = '22222222-2222-4222-8222-222222222222';
    const folderId = '33333333-3333-4333-8333-333333333333';

    const docCreate: OutboxEntry = {
      id: 'e-doc',
      mutationId: 'm-doc',
      entityType: 'document' as any,
      entityId: 'doc-1',
      userId,
      projectId,
      operation: 'create',
      baseServerVersion: null,
      localRevision: 1,
      payload: { title: 'Doc', folderId },
      state: 'pending',
      attemptCount: 0,
      createdAt: 100, // Even with earlier timestamp, must wait for project + folder!
      updatedAt: 100,
    };

    const folderCreate: OutboxEntry = {
      id: 'e-folder',
      mutationId: 'm-folder',
      entityType: 'workspace_folder',
      entityId: folderId,
      userId,
      projectId,
      operation: 'create',
      baseServerVersion: null,
      localRevision: 1,
      payload: { name: 'Folder' },
      state: 'pending',
      attemptCount: 0,
      createdAt: 200,
      updatedAt: 200,
    };

    const designCreate: OutboxEntry = {
      id: 'e-design',
      mutationId: 'm-design',
      entityType: 'system_design',
      entityId: 'des-1',
      userId,
      projectId,
      operation: 'create',
      baseServerVersion: null,
      localRevision: 1,
      payload: { name: 'Design', folderId },
      state: 'pending',
      attemptCount: 0,
      createdAt: 150,
      updatedAt: 150,
    };

    const projectCreate: OutboxEntry = {
      id: 'e-proj',
      mutationId: 'm-proj',
      entityType: 'project' as any,
      entityId: projectId,
      userId,
      projectId,
      operation: 'create',
      baseServerVersion: null,
      localRevision: 1,
      payload: { name: 'New Project' },
      state: 'pending',
      attemptCount: 0,
      createdAt: 300,
      updatedAt: 300,
    };

    const orderedCreates = orderOutboxByDependency([
      docCreate,
      designCreate,
      folderCreate,
      projectCreate,
    ]);

    expect(orderedCreates.map((e) => e.id)).toEqual([
      'e-proj',
      'e-folder',
      'e-doc',
      'e-design',
    ]);

    // Delete order: child deletes precede project delete
    const projectDelete: OutboxEntry = {
      ...projectCreate,
      id: 'del-proj',
      operation: 'delete',
      baseServerVersion: '2',
      createdAt: 100,
    };
    const docDelete: OutboxEntry = {
      ...docCreate,
      id: 'del-doc',
      operation: 'delete',
      baseServerVersion: '1',
      createdAt: 200,
    };
    const orderedDeletes = orderOutboxByDependency([projectDelete, docDelete]);
    expect(orderedDeletes.map((e) => e.id)).toEqual(['del-doc', 'del-proj']);
  });

  it('3. ProjectPushAdapter + SyncEngine push offline project + child entities in dependency order via apply_sync_mutation and enforce CAS', async () => {
    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);
    const projectRepo = new ProjectRepository(db, outboxRepo, syncMetadataRepo);
    const docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);

    const projectAdapter = getPushAdapter('project' as any);
    await expect(
      projectAdapter.push(
        {
          id: 'bad-upd',
          mutationId: 'm-bad',
          entityType: 'project' as any,
          entityId: 'proj-bad',
          userId,
          projectId: 'proj-bad',
          operation: 'update',
          baseServerVersion: null,
          localRevision: 2,
          payload: { name: 'Bad' },
          state: 'in_flight',
          attemptCount: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        { rpc: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(MissingCasBaselineError);

    const project = await projectRepo.create({
      id: '44444444-4444-4444-8444-444444444444',
      userId,
      name: 'Offline Created Project',
    });
    const doc = await docRepo.create({
      id: '55555555-5555-4555-8555-555555555555',
      userId,
      projectId: project.id,
      title: 'Child Doc',
      content: 'Hello',
    });

    const rpcCalls: Array<{ entityType: string; operation: string; baseVersion: number | null }> = [];
    const mockSupabase = {
      from: (table: string) => {
        if (table === 'sync_changes') {
          return {
            select: () => ({
              eq: () => ({
                gt: () => ({
                  order: () => ({
                    limit: async () => ({ data: [], error: null }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      },
      rpc: vi.fn(async (_fn: string, params: Record<string, any>) => {
        rpcCalls.push({
          entityType: params.p_entity_type,
          operation: params.p_operation,
          baseVersion: params.p_base_version,
        });
        return {
          data: { status: 'applied', version: 1, updated_at: '2026-11-01T12:00:00.000Z' },
          error: null,
        };
      }),
    };

    setBrowserOnline(true);
    const coordinator = new TabCoordinator({ channelName: `coord-proj-${Date.now()}` });
    vi.spyOn(coordinator, 'isLeaderTab').mockReturnValue(true);

    const pullEngine = new PullEngine({ supabaseClient: mockSupabase, db, projectRepo, tabCoordinator: coordinator } as any);
    const syncEngine = new SyncEngine({
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
      pullEngine,
      tabCoordinator: coordinator,
    });

    await syncEngine.triggerSync(userId);

    expect(rpcCalls).toEqual([
      { entityType: 'project', operation: 'create', baseVersion: null },
      { entityType: 'document', operation: 'create', baseVersion: null },
    ]);

    const projMeta = await syncMetadataRepo.get('project' as any, project.id);
    expect(projMeta?.syncState).toBe('synced');
    expect(projMeta?.serverVersion).toBe('1');
    expect(doc.projectId).toBe(project.id);

    // Rename synced project -> pushes with p_base_version = 1
    await projectRepo.rename(project.id, 'Renamed Online');
    await syncEngine.triggerSync(userId);

    expect(rpcCalls[2]).toEqual({
      entityType: 'project',
      operation: 'update',
      baseVersion: 1,
    });

    syncEngine.destroy();
    coordinator.destroy();
  });

  it('4. PullEngine applies remote project create/update/delete events and cascades local soft-delete on remote project deletion', async () => {
    const projectId = '66666666-6666-4666-8666-666666666666';
    const projectRepo = new ProjectRepository(db);
    const docRepo = new DocumentRepository(db);

    let feedEvents: any[] = [
      {
        sequence: 1,
        user_id: userId,
        entity_type: 'project',
        entity_id: projectId,
        operation: 'create',
        entity_version: 1,
        payload: {
          id: projectId,
          user_id: userId,
          name: 'Remote Architecture',
          created_at: '2026-11-01T10:00:00.000Z',
          updated_at: '2026-11-01T10:00:00.000Z',
        },
        changed_at: '2026-11-01T10:00:00.000Z',
      },
      {
        sequence: 2,
        user_id: userId,
        entity_type: 'project',
        entity_id: projectId,
        operation: 'update',
        entity_version: 2,
        payload: {
          id: projectId,
          user_id: userId,
          name: 'Remote Architecture v2',
          created_at: '2026-11-01T10:00:00.000Z',
          updated_at: '2026-11-01T10:05:00.000Z',
        },
        changed_at: '2026-11-01T10:05:00.000Z',
      },
    ];

    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            gt: (_col: string, cursor: number) => ({
              order: () => ({
                limit: async () => ({
                  data: feedEvents.filter((e) => e.sequence > cursor),
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }),
    };

    const coordinator = new TabCoordinator({ channelName: `pull-proj-${Date.now()}` });
    const receivedEvents: string[] = [];
    coordinator.onCrossTabChange((ev) => receivedEvents.push(`${ev.entityType}:${ev.operation}`));

    const pullEngine = new PullEngine({
      supabaseClient: mockSupabase,
      db,
      projectRepo,
      documentRepo: docRepo,
      tabCoordinator: coordinator,
    } as any);

    await pullEngine.pullAll(userId);

    const liveProject = await projectRepo.getById(projectId);
    expect(liveProject?.name).toBe('Remote Architecture v2');
    expect(receivedEvents).toEqual(['project:create', 'project:update']);

    // Add a synced child document inside the project, then pull remote project delete
    await docRepo.applyRemoteSnapshot({
      id: 'doc-in-remote-proj',
      userId,
      projectId,
      title: 'Synced Doc',
      content: 'Body',
      serverVersion: '1',
    });

    feedEvents = [
      ...feedEvents,
      {
        sequence: 3,
        user_id: userId,
        entity_type: 'project',
        entity_id: projectId,
        operation: 'delete',
        entity_version: 2,
        payload: null,
        changed_at: '2026-11-01T10:10:00.000Z',
      },
    ];

    await pullEngine.pullAll(userId);

    expect(await projectRepo.getById(projectId)).toBeNull();
    expect(await docRepo.listByProject(userId, projectId)).toHaveLength(0);

    coordinator.destroy();
  });

  it('5. useProjects executes createProject, updateProject, and deleteProject completely offline and persists across cold offline reloads', async () => {
    setBrowserOnline(false);
    authMockState.isOfflineSession = true;

    const qc1 = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper1 = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc1}>{children}</QueryClientProvider>
    );

    const { result, unmount } = renderHook(() => useProjects(), { wrapper: wrapper1 });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let createdId = '';
    await act(async () => {
      const created = await result.current.createProject('Offline SaaS Core');
      createdId = created.id;
    });

    await waitFor(() => {
      expect(result.current.projects).toHaveLength(1);
      expect(result.current.projects[0].name).toBe('Offline SaaS Core');
    });

    await act(async () => {
      await result.current.updateProject({ id: createdId, name: 'Offline SaaS Core Renamed' });
    });

    await waitFor(() => {
      expect(result.current.projects[0].name).toBe('Offline SaaS Core Renamed');
    });

    unmount();

    // Cold offline reload with a brand-new QueryClient
    const qc2 = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper2 = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc2}>{children}</QueryClientProvider>
    );
    const { result: reloaded } = renderHook(() => useProjects(), { wrapper: wrapper2 });

    await waitFor(() => {
      expect(reloaded.current.projects).toHaveLength(1);
      expect(reloaded.current.projects[0].name).toBe('Offline SaaS Core Renamed');
    });

    await act(async () => {
      await reloaded.current.deleteProject(createdId);
    });

    await waitFor(() => {
      expect(reloaded.current.projects).toHaveLength(0);
    });
  });
});
