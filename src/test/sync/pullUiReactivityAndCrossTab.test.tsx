import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArtixDB } from '@/lib/local/db';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { SystemDesignRepository } from '@/lib/repositories/systemDesignRepository';
import { WorkspaceFolderRepository } from '@/lib/repositories/folderRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { PullEngine } from '@/lib/sync/pullEngine';
import { TabCoordinator } from '@/lib/sync/tabCoordinator';
import { useDocuments } from '@/hooks/useDocuments';
import { useSystemDesigns } from '@/hooks/useSystemDesigns';
import { useWorkspaceFolders } from '@/hooks/useWorkspaceFolders';

const TEST_USER = { id: 'user-task-21', email: 'user21@example.test' };

const TestRuntimeContext = React.createContext<any>(null);

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: TEST_USER,
    session: { user: TEST_USER },
    loading: false,
  }),
}));

vi.mock('@/contexts/UserSyncRuntimeContext', () => ({
  useUserSyncRuntime: () => React.useContext(TestRuntimeContext),
}));

// Deterministic in-memory BroadcastChannel hub so two TabCoordinator instances communicate synchronously in jsdom
class MockBroadcastChannel {
  static channels = new Map<string, Set<MockBroadcastChannel>>();
  name: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  constructor(name: string) {
    this.name = name;
    if (!MockBroadcastChannel.channels.has(name)) {
      MockBroadcastChannel.channels.set(name, new Set());
    }
    MockBroadcastChannel.channels.get(name)!.add(this);
  }

  postMessage(data: unknown) {
    const peers = MockBroadcastChannel.channels.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      if (peer !== this && peer.onmessage) {
        peer.onmessage(new MessageEvent('message', { data }));
      }
    }
  }

  close() {
    MockBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

function LiveWorkspaceProbe({ projectId }: { projectId: string }) {
  const { documents } = useDocuments(projectId);
  const { designs } = useSystemDesigns(projectId);
  const { folders } = useWorkspaceFolders(projectId);

  return (
    <div>
      <ul data-testid="probe-docs">
        {documents.map((d) => (
          <li key={d.id}>{d.title}</li>
        ))}
      </ul>
      <ul data-testid="probe-designs">
        {designs.map((d) => (
          <li key={d.id}>{d.name}</li>
        ))}
      </ul>
      <ul data-testid="probe-folders">
        {folders.map((f) => (
          <li key={f.id}>{f.name}</li>
        ))}
      </ul>
    </div>
  );
}

describe('OF-11 / TASK-21: Live UI Reactivity on Pull & Real Cross-Tab localRevision', () => {
  const originalBroadcastChannel = globalThis.BroadcastChannel;
  let db: ArtixDB;
  let coordinators: TabCoordinator[] = [];

  beforeEach(async () => {
    MockBroadcastChannel.channels.clear();
    globalThis.BroadcastChannel = MockBroadcastChannel as unknown as typeof BroadcastChannel;
    coordinators = [];

    db = new ArtixDB(`artix_task21_${crypto.randomUUID()}`);
    await db.open();
  });

  afterEach(async () => {
    cleanup();
    for (const c of coordinators) {
      c.destroy();
    }
    db.close();
    await db.delete();
    MockBroadcastChannel.channels.clear();
    globalThis.BroadcastChannel = originalBroadcastChannel;
  });

  function createRuntimeBundle(channelName: string) {
    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);
    const documentRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);
    const systemDesignRepo = new SystemDesignRepository(db, outboxRepo, syncMetadataRepo);
    const folderRepo = new WorkspaceFolderRepository(db, outboxRepo, syncMetadataRepo);
    const tabCoordinator = new TabCoordinator(channelName, 'scope21');
    coordinators.push(tabCoordinator);

    return {
      isReady: true,
      db,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
      documentRepo,
      systemDesignRepo,
      folderRepo,
      tabCoordinator,
      runtime: {},
    };
  }

  it('1. automatically refreshes live leader-tab UI hooks when PullEngine applies remote creates and updates', async () => {
    const bundle = createRuntimeBundle('chan_task21_1');

    let remoteBatches: any[][] = [
      [
        {
          sequence: 1,
          user_id: TEST_USER.id,
          entity_type: 'workspace_folder',
          entity_id: 'f-1',
          operation: 'create',
          entity_version: 1,
          payload: {
            id: 'f-1',
            user_id: TEST_USER.id,
            project_id: 'proj-1',
            name: 'Backend Specs',
            parent_folder_id: null,
            created_at: '2026-03-01T00:00:00Z',
            updated_at: '2026-03-01T00:00:00Z',
          },
          changed_at: '2026-03-01T00:00:00Z',
        },
        {
          sequence: 2,
          user_id: TEST_USER.id,
          entity_type: 'document',
          entity_id: 'd-1',
          operation: 'create',
          entity_version: 1,
          payload: {
            id: 'd-1',
            user_id: TEST_USER.id,
            project_id: 'proj-1',
            folder_id: 'f-1',
            title: 'API Contract',
            content: '# v1',
            format: 'markdown',
            created_at: '2026-03-01T00:00:00Z',
            updated_at: '2026-03-01T00:00:00Z',
          },
          changed_at: '2026-03-01T00:00:00Z',
        },
        {
          sequence: 3,
          user_id: TEST_USER.id,
          entity_type: 'system_design',
          entity_id: 'sd-1',
          operation: 'create',
          entity_version: 1,
          payload: {
            id: 'sd-1',
            user_id: TEST_USER.id,
            project_id: 'proj-1',
            folder_id: 'f-1',
            name: 'Service Mesh',
            board_state: { nodes: [], edges: [] },
            created_at: '2026-03-01T00:00:00Z',
            updated_at: '2026-03-01T00:00:00Z',
          },
          changed_at: '2026-03-01T00:00:00Z',
        },
      ],
    ];

    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            gt: (_col: string, cursor: number) => ({
              order: () => ({
                limit: async () => {
                  const rows = (remoteBatches.shift() || []).filter((r) => r.sequence > cursor);
                  return { data: rows, error: null };
                },
              }),
            }),
          }),
        }),
      }),
    };

    const pullEngine = new PullEngine({
      supabaseClient: mockSupabase,
      db,
      documentRepo: bundle.documentRepo,
      folderRepo: bundle.folderRepo,
      systemDesignRepo: bundle.systemDesignRepo,
      conflictRepo: bundle.conflictRepo,
      syncMetadataRepo: bundle.syncMetadataRepo,
      tabCoordinator: bundle.tabCoordinator,
    } as any);

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <TestRuntimeContext.Provider value={bundle}>
        <QueryClientProvider client={qc}>
          <LiveWorkspaceProbe projectId="proj-1" />
        </QueryClientProvider>
      </TestRuntimeContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('probe-docs').children).toHaveLength(0);
    });

    await act(async () => {
      await pullEngine.pullAll(TEST_USER.id);
    });

    await waitFor(
      () => {
        expect(screen.getByText('Backend Specs')).toBeInTheDocument();
        expect(screen.getByText('API Contract')).toBeInTheDocument();
        expect(screen.getByText('Service Mesh')).toBeInTheDocument();
      },
      { timeout: 1000 },
    );

    remoteBatches = [
      [
        {
          sequence: 4,
          user_id: TEST_USER.id,
          entity_type: 'workspace_folder',
          entity_id: 'f-1',
          operation: 'update',
          entity_version: 2,
          payload: {
            id: 'f-1',
            user_id: TEST_USER.id,
            project_id: 'proj-1',
            name: 'Platform Specs',
            parent_folder_id: null,
            created_at: '2026-03-01T00:00:00Z',
            updated_at: '2026-03-01T00:05:00Z',
          },
          changed_at: '2026-03-01T00:05:00Z',
        },
        {
          sequence: 5,
          user_id: TEST_USER.id,
          entity_type: 'document',
          entity_id: 'd-1',
          operation: 'update',
          entity_version: 2,
          payload: {
            id: 'd-1',
            user_id: TEST_USER.id,
            project_id: 'proj-1',
            folder_id: 'f-1',
            title: 'API Contract v2',
            content: '# v2',
            format: 'markdown',
            created_at: '2026-03-01T00:00:00Z',
            updated_at: '2026-03-01T00:05:00Z',
          },
          changed_at: '2026-03-01T00:05:00Z',
        },
      ],
    ];

    await act(async () => {
      await pullEngine.pullAll(TEST_USER.id);
    });

    await waitFor(
      () => {
        expect(screen.getByText('Platform Specs')).toBeInTheDocument();
        expect(screen.getByText('API Contract v2')).toBeInTheDocument();
      },
      { timeout: 1000 },
    );

    const updatedFolder = await bundle.folderRepo.getById('f-1');
    expect(updatedFolder?.localRevision).toBe(2);
  });

  it('2. broadcasts pulled remote changes to standby tabs so peer tabs update without reload', async () => {
    const channelName = 'chan_task21_2';
    const leaderBundle = createRuntimeBundle(channelName);
    const standbyBundle = createRuntimeBundle(channelName);

    const standbyQc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <TestRuntimeContext.Provider value={standbyBundle}>
        <QueryClientProvider client={standbyQc}>
          <LiveWorkspaceProbe projectId="proj-1" />
        </QueryClientProvider>
      </TestRuntimeContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('probe-docs').children).toHaveLength(0);
    });

    let emitted = false;
    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            gt: () => ({
              order: () => ({
                limit: async () => {
                  if (emitted) return { data: [], error: null };
                  emitted = true;
                  return {
                    data: [
                      {
                        sequence: 10,
                        user_id: TEST_USER.id,
                        entity_type: 'document',
                        entity_id: 'doc-peer-pull',
                        operation: 'create',
                        entity_version: 1,
                        payload: {
                          id: 'doc-peer-pull',
                          user_id: TEST_USER.id,
                          project_id: 'proj-1',
                          folder_id: null,
                          title: 'Pulled By Leader Tab',
                          content: 'hello',
                          format: 'markdown',
                          created_at: '2026-03-01T00:00:00Z',
                          updated_at: '2026-03-01T00:00:00Z',
                        },
                        changed_at: '2026-03-01T00:00:00Z',
                      },
                    ],
                    error: null,
                  };
                },
              }),
            }),
          }),
        }),
      }),
    };

    const leaderPullEngine = new PullEngine({
      supabaseClient: mockSupabase,
      db,
      documentRepo: leaderBundle.documentRepo,
      folderRepo: leaderBundle.folderRepo,
      systemDesignRepo: leaderBundle.systemDesignRepo,
      conflictRepo: leaderBundle.conflictRepo,
      syncMetadataRepo: leaderBundle.syncMetadataRepo,
      tabCoordinator: leaderBundle.tabCoordinator,
    } as any);

    await act(async () => {
      await leaderPullEngine.pullAll(TEST_USER.id);
    });

    await waitFor(
      () => {
        expect(screen.getByText('Pulled By Leader Tab')).toBeInTheDocument();
      },
      { timeout: 1000 },
    );
  });

  it('3. broadcasts real monotonic localRevision on rapid folder renames and deletes so Tab B never drops the 2nd mutation within 3000ms', async () => {
    const channelName = 'chan_task21_3';
    const tabABundle = createRuntimeBundle(channelName);
    const tabBBundle = createRuntimeBundle(channelName);

    let tabAActions: {
      createFolder: ReturnType<typeof useWorkspaceFolders>['createFolder'];
      renameFolder: ReturnType<typeof useWorkspaceFolders>['renameFolder'];
      deleteFolder: ReturnType<typeof useWorkspaceFolders>['deleteFolder'];
      createDocument: ReturnType<typeof useDocuments>['createDocument'];
      updateDocument: ReturnType<typeof useDocuments>['updateDocument'];
      deleteDocument: ReturnType<typeof useDocuments>['deleteDocument'];
    } | null = null;

    function TabADriver() {
      const folders = useWorkspaceFolders('proj-1');
      const docs = useDocuments('proj-1');
      tabAActions = {
        createFolder: folders.createFolder,
        renameFolder: folders.renameFolder,
        deleteFolder: folders.deleteFolder,
        createDocument: docs.createDocument,
        updateDocument: docs.updateDocument,
        deleteDocument: docs.deleteDocument,
      };
      return null;
    }

    const tabAQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tabBQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const receivedTabBEvents: Array<{ entityType: string; operation: string; localRevision: number }> = [];
    tabBBundle.tabCoordinator.onCrossTabChange((ev) => {
      receivedTabBEvents.push({
        entityType: ev.entityType,
        operation: ev.operation,
        localRevision: ev.localRevision,
      });
    });

    render(
      <>
        <TestRuntimeContext.Provider value={tabABundle}>
          <QueryClientProvider client={tabAQc}>
            <TabADriver />
          </QueryClientProvider>
        </TestRuntimeContext.Provider>
        <TestRuntimeContext.Provider value={tabBBundle}>
          <QueryClientProvider client={tabBQc}>
            <LiveWorkspaceProbe projectId="proj-1" />
          </QueryClientProvider>
        </TestRuntimeContext.Provider>
      </>,
    );

    let createdFolderId = '';
    await act(async () => {
      const f = await tabAActions!.createFolder({ name: 'Drafts', projectId: 'proj-1' });
      createdFolderId = f.id;
    });
    await act(async () => {
      await tabAActions!.renameFolder({ id: createdFolderId, name: 'Specs' });
    });
    await act(async () => {
      await tabAActions!.renameFolder({ id: createdFolderId, name: 'Final Architecture Specs' });
    });

    await waitFor(
      () => {
        expect(screen.getByText('Final Architecture Specs')).toBeInTheDocument();
      },
      { timeout: 1000 },
    );

    const folderUpdateRevisions = receivedTabBEvents
      .filter((e) => e.entityType === 'workspace_folder' && e.operation === 'update')
      .map((e) => e.localRevision);
    expect(folderUpdateRevisions).toEqual([2, 3]);

    let docId = '';
    await act(async () => {
      const d = await tabAActions!.createDocument({ projectId: 'proj-1', title: 'Doc 1' });
      docId = d.id;
      await tabAActions!.updateDocument({ id: docId, content: 'edit 1' }); // rev 2
      await tabAActions!.updateDocument({ id: docId, content: 'edit 2' }); // rev 3
      await tabAActions!.deleteDocument(docId); // rev 4
    });

    const docDeleteEvent = receivedTabBEvents.find(
      (e) => e.entityType === 'document' && e.operation === 'delete',
    );
    expect(docDeleteEvent?.localRevision).toBe(4);
  });
});
