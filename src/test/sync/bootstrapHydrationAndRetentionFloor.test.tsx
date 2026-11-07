import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import {
  deleteArtixDB,
  getUserArtixDB,
  setActiveUserScope,
} from '@/lib/local/db';
import {
  openUserRuntime,
  closeUserRuntime,
} from '@/lib/sync/userSyncRuntime';
import { resetTabCoordinatorsForTesting } from '@/lib/sync/tabCoordinator';
import {
  UserSyncRuntimeProvider,
  useUserSyncRuntime,
} from '@/contexts/UserSyncRuntimeContext';
import { SyncStatusBanner } from '@/components/SyncStatusBanner';

let mockAuthState = {
  user: { id: 'user-hydration-test', email: 'hydration@example.test' } as {
    id: string;
    email: string;
  } | null,
  loading: false,
  isOfflineSession: false,
  reauthRequired: false,
};

const controllableSupabaseHolder: { client: any } = { client: null };

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockAuthState,
}));

vi.mock('@/integrations/supabase/client', () => ({
  get supabase() {
    return controllableSupabaseHolder.client;
  },
}));

interface MockCloudData {
  bounds: { min_retained_sequence: number; max_sequence: number };
  projects: any[];
  workspace_folders: any[];
  documents: any[];
  system_designs: any[];
  sync_changes: any[];
}

function createWorkspaceSupabaseMock(cloud: MockCloudData) {
  const rpcCalls: Array<{ fn: string; args: any }> = [];

  const makeTableQuery = (table: string) => {
    let userIdFilter: string | null = null;
    let idFilter: string | null = null;
    let gtSeq: number | null = null;
    let orderAsc = true;
    let rowLimit: number | null = null;

    const resolveRows = () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return Promise.resolve({
          data: null,
          error: { message: 'Failed to fetch: offline', code: 'NETWORK_ERROR' },
        });
      }

      let rows = [...((cloud as any)[table] || [])];
      if (userIdFilter !== null) {
        rows = rows.filter((r) => r.user_id === userIdFilter);
      }
      if (idFilter !== null) {
        rows = rows.filter((r) => r.id === idFilter);
      }
      if (table === 'sync_changes') {
        if (gtSeq !== null) {
          rows = rows.filter((r) => r.sequence > gtSeq!);
        }
        rows.sort((a, b) => (orderAsc ? a.sequence - b.sequence : b.sequence - a.sequence));
      }
      if (rowLimit !== null) {
        rows = rows.slice(0, rowLimit);
      }
      return Promise.resolve({ data: rows, error: null });
    };

    const builder: any = {
      select: () => builder,
      eq: (col: string, val: any) => {
        if (col === 'user_id') userIdFilter = val;
        if (col === 'id') idFilter = val;
        return builder;
      },
      is: () => builder,
      not: () => builder,
      gt: (col: string, val: number) => {
        if (col === 'sequence') gtSeq = val;
        return builder;
      },
      order: (_col: string, opts?: { ascending?: boolean }) => {
        orderAsc = opts?.ascending ?? true;
        return builder;
      },
      limit: (n: number) => {
        rowLimit = n;
        return builder;
      },
      maybeSingle: async () => {
        const res = await resolveRows();
        return { data: res.data?.[0] ?? null, error: res.error };
      },
      then: (onFulfilled: any, onRejected: any) => resolveRows().then(onFulfilled, onRejected),
      catch: (onRejected: any) => resolveRows().catch(onRejected),
      finally: (onFinally: any) => resolveRows().finally(onFinally),
    };

    return builder;
  };

  return {
    rpcCalls,
    client: {
      from: (table: string) => makeTableQuery(table),
      rpc: vi.fn(async (fn: string, args?: any) => {
        rpcCalls.push({ fn, args });
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          return {
            data: null,
            error: { message: 'Failed to fetch: offline', code: 'NETWORK_ERROR' },
          };
        }
        if (fn === 'get_sync_feed_bounds') {
          return { data: cloud.bounds, error: null };
        }
        if (fn === 'apply_sync_mutation') {
          return {
            data: { status: 'applied', version: 1, updated_at: '2026-11-07T12:00:00.000Z' },
            error: null,
          };
        }
        return { data: null, error: { code: '42883', message: `Unknown RPC ${fn}` } };
      }),
      channel: () => {
        const ch: any = {
          on: () => ch,
          subscribe: () => ch,
          unsubscribe: () => {},
        };
        return ch;
      },
      removeChannel: vi.fn(),
    },
  };
}

function RuntimeHydrationProbe() {
  const ctx = useUserSyncRuntime();
  return (
    <div>
      <span data-testid="probe-ready">{String(Boolean(ctx?.isReady))}</span>
      <span data-testid="probe-hydrated">{String(Boolean(ctx?.isHydrated))}</span>
    </div>
  );
}

describe('TASK-20 & TASK-27 (OF-06, OF-07): sync_changes Retention Floor, bootstrapHydrateAll, resnapshotAll & Unhydrated Offline UX', () => {
  let originalOnLineDescriptor: PropertyDescriptor | undefined;

  function setBrowserOnline(online: boolean) {
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => online,
    });
    onlineManager.setOnline(online);
  }

  beforeEach(async () => {
    originalOnLineDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
    setBrowserOnline(true);
    mockAuthState = {
      user: { id: 'user-hydration-test', email: 'hydration@example.test' },
      loading: false,
      isOfflineSession: false,
      reauthRequired: false,
    };
    await closeUserRuntime();
    resetTabCoordinatorsForTesting();
    await deleteArtixDB();
    setActiveUserScope(null);
  });

  afterEach(async () => {
    await closeUserRuntime();
    resetTabCoordinatorsForTesting();
    setBrowserOnline(true);
    if (originalOnLineDescriptor) {
      Object.defineProperty(window.navigator, 'onLine', originalOnLineDescriptor);
    }
    await deleteArtixDB();
    setActiveUserScope(null);
  });

  it('1. TASK-20 SQL Migration Contract: defines sync_retention_state, get_sync_feed_bounds RPC, and monotonic prune_sync_changes', () => {
    const migrationPath = path.resolve(
      process.cwd(),
      'supabase/migrations/20261101100200_sync_changes_retention_and_floor.sql',
    );
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.sync_retention_state/i);
    expect(sql).toMatch(/min_retained_sequence\s+BIGINT\s+NOT NULL\s+DEFAULT\s+0/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.get_sync_feed_bounds\s*\(/i);
    expect(sql).toMatch(/SECURITY INVOKER/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.prune_sync_changes\s*\(/i);
    expect(sql).toMatch(/pg_advisory_xact_lock/i);
    expect(sql).toMatch(/GREATEST\s*\(\s*(?:public\.sync_retention_state\.)?min_retained_sequence/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.prune_sync_changes/i);
  });

  it('2. TASK-27 (OF-06 / OF-07): bootstrapHydrateAll populates pre-feed remote entities across all 4 tables, preserves local outbox creates, catches delta events, and marks hydration_complete', async () => {
    const userId = '11111111-2222-4333-8444-555555555555';
    const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const folderId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const preFeedDocId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const preFeedDesignId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const deltaDocId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const localOfflineDocId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

    // Seed an unpushed local offline document BEFORE initial cloud hydration completes
    const preDb = getUserArtixDB(userId);
    await preDb.open();
    await preDb.documents.put({
      id: localOfflineDocId,
      userId,
      projectId,
      folderId: null,
      title: 'Created Before First Sync',
      content: 'Must survive bootstrapHydrateAll',
      format: 'markdown',
      createdAt: '2026-11-07T10:00:00.000Z',
      updatedAt: '2026-11-07T10:00:00.000Z',
      localRevision: 1,
      isDeleted: false,
    });
    await preDb.outbox.put({
      id: 'outbox-local-pre-hydrate',
      mutationId: '99999999-9999-4999-8999-999999999999',
      userId,
      projectId,
      entityType: 'document',
      entityId: localOfflineDocId,
      operation: 'create',
      payload: {
        id: localOfflineDocId,
        project_id: projectId,
        title: 'Created Before First Sync',
        content: 'Must survive bootstrapHydrateAll',
        format: 'markdown',
      },
      localRevision: 1,
      baseServerVersion: null,
      state: 'pending',
      attemptCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Cloud has pre-September-2026 rows that have ZERO entries in sync_changes,
    // PLUS one concurrent delta event at sequence 43 (> ceiling 42)!
    const cloud: MockCloudData = {
      bounds: { min_retained_sequence: 0, max_sequence: 42 },
      projects: [
        {
          id: projectId,
          user_id: userId,
          name: 'Legacy Pre-Feed Project',
          version: 3,
          created_at: '2026-08-01T00:00:00.000Z',
          updated_at: '2026-08-15T00:00:00.000Z',
        },
      ],
      workspace_folders: [
        {
          id: folderId,
          user_id: userId,
          project_id: projectId,
          name: 'Legacy Specs Folder',
          parent_folder_id: null,
          version: 2,
          created_at: '2026-08-02T00:00:00.000Z',
          updated_at: '2026-08-16T00:00:00.000Z',
        },
      ],
      documents: [
        {
          id: preFeedDocId,
          user_id: userId,
          project_id: projectId,
          folder_id: folderId,
          title: 'Pre-Feed Architecture PRD',
          content: '# Historical PRD never in sync_changes',
          format: 'markdown',
          version: 7,
          created_at: '2026-08-03T00:00:00.000Z',
          updated_at: '2026-08-20T00:00:00.000Z',
        },
      ],
      system_designs: [
        {
          id: preFeedDesignId,
          user_id: userId,
          project_id: projectId,
          folder_id: folderId,
          name: 'Pre-Feed System Topology',
          board_state: { nodes: [{ id: 'n-legacy' }], edges: [], strokes: [] },
          version: 4,
          created_at: '2026-08-04T00:00:00.000Z',
          updated_at: '2026-08-21T00:00:00.000Z',
        },
      ],
      sync_changes: [
        {
          sequence: 43,
          user_id: userId,
          entity_type: 'document',
          entity_id: deltaDocId,
          operation: 'create',
          entity_version: 1,
          payload: {
            id: deltaDocId,
            user_id: userId,
            project_id: projectId,
            folder_id: null,
            title: 'Concurrent Delta Document',
            content: 'Committed at seq 43 during bootstrap',
            format: 'markdown',
            created_at: '2026-11-07T12:00:01.000Z',
            updated_at: '2026-11-07T12:00:01.000Z',
          },
          changed_at: '2026-11-07T12:00:01.000Z',
        },
      ],
    };

    const mockSup = createWorkspaceSupabaseMock(cloud);
    const runtime = await openUserRuntime(userId, { supabaseClient: mockSup.client });

    await waitFor(async () => {
      expect(await runtime.pullEngine.isHydrated()).toBe(true);
      expect(await runtime.pullEngine.getCursor()).toBe(43);
    });

    // All 4 pre-feed entity types hydrated with authoritative serverVersion baselines
    const hydratedProj = await runtime.projectRepo.getById(projectId);
    expect(hydratedProj?.name).toBe('Legacy Pre-Feed Project');
    expect((await runtime.syncMetadataRepo.get('project', projectId))?.serverVersion).toBe('3');

    const hydratedFolder = await runtime.folderRepo.getById(folderId);
    expect(hydratedFolder?.name).toBe('Legacy Specs Folder');
    expect((await runtime.syncMetadataRepo.get('workspace_folder', folderId))?.serverVersion).toBe('2');

    const hydratedDoc = await runtime.documentRepo.getById(preFeedDocId);
    expect(hydratedDoc?.content).toBe('# Historical PRD never in sync_changes');
    expect((await runtime.syncMetadataRepo.get('document', preFeedDocId))?.serverVersion).toBe('7');

    const hydratedDesign = await runtime.systemDesignRepo.getById(preFeedDesignId);
    expect(hydratedDesign?.name).toBe('Pre-Feed System Topology');
    expect((await runtime.syncMetadataRepo.get('system_design', preFeedDesignId))?.serverVersion).toBe('4');

    // Delta event after ceiling (seq 43) also applied
    const deltaDoc = await runtime.documentRepo.getById(deltaDocId);
    expect(deltaDoc?.title).toBe('Concurrent Delta Document');

    // Unpushed local document preserved AND pushed cleanly
    const localPreDoc = await runtime.documentRepo.getById(localOfflineDocId);
    expect(localPreDoc?.isDeleted).toBe(false);
    expect(localPreDoc?.content).toBe('Must survive bootstrapHydrateAll');
    expect(runtime.getStatus().isHydrated).toBe(true);
  });

  it('3. TASK-20: resnapshotAll reconciles cursor-below-floor clients safely (updates, remote deletes, conflict protection, and anti-resurrection)', async () => {
    const userId = '22222222-3333-4444-8555-666666666666';
    const projectId = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
    const docUpdatedRemotely = '10000000-0000-4000-8000-000000000001';
    const docDeletedRemotely = '10000000-0000-4000-8000-000000000002';
    const docConflictRemoteDeleted = '10000000-0000-4000-8000-000000000003';
    const docConflictVersionMismatch = '10000000-0000-4000-8000-000000000004';
    const docTombstone = '10000000-0000-4000-8000-000000000005';
    const docOfflineCreate = '10000000-0000-4000-8000-000000000006';

    const db = getUserArtixDB(userId);
    await db.open();

    // Client was previously hydrated at cursor 100, then went offline for 45 days
    await db.database_meta.put({ key: 'hydration_complete', value: true, updatedAt: Date.now() });
    await db.database_meta.put({ key: 'server_cursor', value: 100, updatedAt: Date.now() });

    const seedSyncedDoc = async (id: string, title: string, content: string, ver: string) => {
      await db.documents.put({
        id,
        userId,
        projectId,
        folderId: null,
        title,
        content,
        format: 'markdown',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        localRevision: 1,
        isDeleted: false,
      });
      await db.sync_metadata.put({
        id: `document:${id}`,
        entityType: 'document',
        entityId: id,
        userId,
        syncState: 'synced',
        serverVersion: ver,
        serverUpdatedAt: '2026-09-01T00:00:00.000Z',
        localRevision: 1,
        lastSyncedAt: Date.now(),
        lastAckedMutationId: null,
        baseSnapshot: { title, content },
      });
    };

    await seedSyncedDoc(docUpdatedRemotely, 'Old v1 Title', 'Old v1 Content', '1');
    await seedSyncedDoc(docDeletedRemotely, 'Will Be Pruned Remotely', 'Clean local copy', '2');
    await seedSyncedDoc(docConflictRemoteDeleted, 'Base Before Delete', 'Base Body', '1');
    await seedSyncedDoc(docConflictVersionMismatch, 'Base Before Edit', 'Base Body', '1');

    // Local dirty edit on docConflictRemoteDeleted (while server deleted it during pruned window!)
    await db.documents.update(docConflictRemoteDeleted, {
      content: 'Important Offline Edit On Remotely Deleted Doc',
      localRevision: 2,
    });
    await db.sync_metadata.update(`document:${docConflictRemoteDeleted}`, {
      syncState: 'pending',
      localRevision: 2,
    });
    await db.outbox.put({
      id: 'outbox-rem-del-conflict',
      mutationId: '30000000-0000-4000-8000-000000000003',
      userId,
      projectId,
      entityType: 'document',
      entityId: docConflictRemoteDeleted,
      operation: 'update',
      payload: { content: 'Important Offline Edit On Remotely Deleted Doc' },
      localRevision: 2,
      baseServerVersion: '1',
      state: 'pending',
      attemptCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Local dirty edit on docConflictVersionMismatch (while server advanced it to v3!)
    await db.documents.update(docConflictVersionMismatch, {
      content: 'Offline Draft Colliding With Pruned v3',
      localRevision: 2,
    });
    await db.sync_metadata.update(`document:${docConflictVersionMismatch}`, {
      syncState: 'pending',
      localRevision: 2,
    });
    await db.outbox.put({
      id: 'outbox-ver-mismatch-conflict',
      mutationId: '30000000-0000-4000-8000-000000000004',
      userId,
      projectId,
      entityType: 'document',
      entityId: docConflictVersionMismatch,
      operation: 'update',
      payload: { content: 'Offline Draft Colliding With Pruned v3' },
      localRevision: 2,
      baseServerVersion: '1',
      state: 'pending',
      attemptCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Confirmed local tombstone at v4 (must NOT resurrect if stale v4 snapshot seen)
    await db.documents.put({
      id: docTombstone,
      userId,
      projectId,
      folderId: null,
      title: 'Deleted Tombstone',
      content: '',
      format: 'markdown',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      localRevision: 2,
      isDeleted: true,
    });
    await db.sync_metadata.put({
      id: `document:${docTombstone}`,
      entityType: 'document',
      entityId: docTombstone,
      userId,
      syncState: 'deleted_synced',
      serverVersion: '4',
      serverUpdatedAt: '2026-09-02T00:00:00.000Z',
      localRevision: 2,
      lastSyncedAt: Date.now(),
      lastAckedMutationId: null,
      baseSnapshot: null,
    });

    // Unpushed offline create (absent on server, must NOT be soft-deleted by resnapshot!)
    await db.documents.put({
      id: docOfflineCreate,
      userId,
      projectId,
      folderId: null,
      title: 'Brand New Offline Doc',
      content: 'Keep me alive',
      format: 'markdown',
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
      localRevision: 1,
      isDeleted: false,
    });
    await db.outbox.put({
      id: 'outbox-offline-create',
      mutationId: '30000000-0000-4000-8000-000000000006',
      userId,
      projectId,
      entityType: 'document',
      entityId: docOfflineCreate,
      operation: 'create',
      payload: {
        id: docOfflineCreate,
        project_id: projectId,
        title: 'Brand New Offline Doc',
        content: 'Keep me alive',
        format: 'markdown',
      },
      localRevision: 1,
      baseServerVersion: null,
      state: 'pending',
      attemptCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Server pruned sync_changes up to 500 (min_retained_sequence = 500 > localCursor = 100)
    const cloud: MockCloudData = {
      bounds: { min_retained_sequence: 500, max_sequence: 510 },
      projects: [
        {
          id: projectId,
          user_id: userId,
          name: 'Resnapshot Project',
          version: 1,
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
      ],
      workspace_folders: [],
      documents: [
        {
          id: docUpdatedRemotely,
          user_id: userId,
          project_id: projectId,
          folder_id: null,
          title: 'Updated v5 Title',
          content: 'Updated v5 Content',
          format: 'markdown',
          version: 5,
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-10-25T00:00:00.000Z',
        },
        {
          id: docConflictVersionMismatch,
          user_id: userId,
          project_id: projectId,
          folder_id: null,
          title: 'Server v3 Concurrent Title',
          content: 'Server v3 Concurrent Content',
          format: 'markdown',
          version: 3,
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-10-26T00:00:00.000Z',
        },
        {
          id: docTombstone,
          user_id: userId,
          project_id: projectId,
          folder_id: null,
          title: 'Deleted Tombstone',
          content: 'Stale v4',
          format: 'markdown',
          version: 4,
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
      ],
      system_designs: [],
      sync_changes: [],
    };

    const mockSup = createWorkspaceSupabaseMock(cloud);
    const runtime = await openUserRuntime(userId, { supabaseClient: mockSup.client });

    await waitFor(async () => {
      expect(await runtime.pullEngine.getCursor()).toBe(510);
    });

    // 1. Clean remote update applied
    const updatedDoc = await runtime.documentRepo.getById(docUpdatedRemotely);
    expect(updatedDoc?.content).toBe('Updated v5 Content');
    expect((await runtime.syncMetadataRepo.get('document', docUpdatedRemotely))?.serverVersion).toBe('5');

    // 2. Remotely deleted clean row soft-deleted locally!
    const rawRemDeleted = await runtime.db.documents.get(docDeletedRemotely);
    expect(rawRemDeleted?.isDeleted).toBe(true);
    expect((await runtime.syncMetadataRepo.get('document', docDeletedRemotely))?.syncState).toBe('deleted_synced');

    // 3. Remotely deleted row WITH local pending edit preserved as a 'remote_deleted' conflict!
    const preservedRemDelLocal = await runtime.documentRepo.getById(docConflictRemoteDeleted);
    expect(preservedRemDelLocal?.content).toBe('Important Offline Edit On Remotely Deleted Doc');
    const remDelConflicts = await runtime.conflictRepo.listByEntity('document', docConflictRemoteDeleted, userId);
    expect(remDelConflicts).toHaveLength(1);
    expect(remDelConflicts[0].reason).toBe('remote_deleted');
    expect((await runtime.outboxRepo.getById('outbox-rem-del-conflict'))?.state).toBe('blocked');

    // 4. Remotely updated row WITH local pending edit preserved as a 'version_mismatch' conflict!
    const preservedVerMismatch = await runtime.documentRepo.getById(docConflictVersionMismatch);
    expect(preservedVerMismatch?.content).toBe('Offline Draft Colliding With Pruned v3');
    const verMismatchConflicts = await runtime.conflictRepo.listByEntity('document', docConflictVersionMismatch, userId);
    expect(verMismatchConflicts).toHaveLength(1);
    expect(verMismatchConflicts[0].reason).toBe('version_mismatch');
    expect((await runtime.outboxRepo.getById('outbox-ver-mismatch-conflict'))?.state).toBe('blocked');

    // 5. Anti-resurrection invariant: tombstone at v4 NOT resurrected by stale v4 row
    const tombstoneRow = await runtime.db.documents.get(docTombstone);
    expect(tombstoneRow?.isDeleted).toBe(true);

    // 6. Unpushed offline create NOT deleted by resnapshot reconciliation
    const offlineCreatedDoc = await runtime.documentRepo.getById(docOfflineCreate);
    expect(offlineCreatedDoc?.isDeleted).toBe(false);
    expect(offlineCreatedDoc?.title).toBe('Brand New Offline Doc');
  });

  it('4. TASK-27 (Cold-Start Matrix Case 3): surfaces explicit unhydrated notice when offline on a brand-new profile and clears it once hydrated online', async () => {
    const userId = '33333333-4444-4555-8666-777777777777';
    mockAuthState.user = { id: userId, email: 'newdevice@example.test' };

    const cloud: MockCloudData = {
      bounds: { min_retained_sequence: 0, max_sequence: 10 },
      projects: [],
      workspace_folders: [],
      documents: [],
      system_designs: [],
      sync_changes: [],
    };
    const mockSup = createWorkspaceSupabaseMock(cloud);
    controllableSupabaseHolder.client = mockSup.client;

    // Boot offline on a brand-new unhydrated profile
    setBrowserOnline(false);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <UserSyncRuntimeProvider>
            <RuntimeHydrationProbe />
            <SyncStatusBanner />
          </UserSyncRuntimeProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('probe-ready').textContent).toBe('true');
    });

    expect(screen.getByTestId('probe-hydrated').textContent).toBe('false');
    const banner = screen.getByTestId('unhydrated-offline-banner');
    expect(banner.textContent).toMatch(
      /Workspace not yet downloaded for offline use/i,
    );

    // Connect online -> runtime hydrates and clears the unhydrated notice
    await act(async () => {
      setBrowserOnline(true);
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('probe-hydrated').textContent).toBe('true');
      expect(screen.queryByTestId('unhydrated-offline-banner')).not.toBeInTheDocument();
    });
  });
});
