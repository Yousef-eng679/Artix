import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ArtixDB, deleteArtixDB } from '@/lib/local/db';
import * as LocalErrors from '@/lib/local/errors';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { SystemDesignRepository } from '@/lib/repositories/systemDesignRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { resetTabCoordinatorsForTesting, getTabCoordinator } from '@/lib/sync/tabCoordinator';
import { useDocuments } from '@/hooks/useDocuments';
import { useSystemDesigns, BoardState } from '@/hooks/useSystemDesigns';
import { Editor } from '@/components/Editor/Editor';
import { SystemArchitect } from '@/components/SystemArchitect/SystemArchitect';

const TEST_USER = { id: 'user-stale-buf-1', email: 'user@example.test' };

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: TEST_USER,
    session: { user: TEST_USER },
    loading: false,
    isOfflineSession: false,
    reauthRequired: false,
  }),
}));

vi.mock('@/components/Editor/monacoSetup', () => ({}));

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      data-testid="monaco-textarea"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

vi.mock('@/components/SystemArchitect/DrawingCanvas', () => ({
  DrawingCanvas: () => null,
}));

vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    ReactFlow: ({
      nodes,
      children,
    }: {
      nodes: Array<{ id: string; data: { label: string } }>;
      children?: React.ReactNode;
    }) => (
      <div data-testid="mock-reactflow">
        {nodes.map((n) => (
          <div key={n.id} data-testid={`flow-node-${n.id}`}>
            {n.data?.label}
          </div>
        ))}
        {children}
      </div>
    ),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Panel: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  };
});

vi.mock('@/components/AI/PRDGeneratorDialog', () => ({ PRDGeneratorDialog: () => null }));
vi.mock('@/components/AI/VibeCodingDialog', () => ({ VibeCodingDialog: () => null }));
vi.mock('@/components/AI/AgenticWorkflowDialog', () => ({ AgenticWorkflowDialog: () => null }));
vi.mock('@/components/AI/ArchitectureGeneratorDialog', () => ({
  ArchitectureGeneratorDialog: () => null,
}));

let mockDb: ArtixDB;
let mockOutboxRepo: OutboxRepository;
let mockSyncMetaRepo: SyncMetadataRepository;
let mockDocRepo: DocumentRepository;
let mockDesignRepo: SystemDesignRepository;

vi.mock('@/contexts/UserSyncRuntimeContext', () => ({
  useUserSyncRuntime: () => ({
    runtime: null,
    isReady: true,
    status: null,
    db: mockDb,
    outboxRepo: mockOutboxRepo,
    syncMetadataRepo: mockSyncMetaRepo,
    documentRepo: mockDocRepo,
    systemDesignRepo: mockDesignRepo,
    tabCoordinator: getTabCoordinator(TEST_USER.id),
  }),
}));

function LiveDocumentEditorHarness({ projectId, docId }: { projectId: string; docId: string }) {
  const { documents, updateDocument, createDocument } = useDocuments(projectId);
  const doc = documents.find((d) => d.id === docId);
  if (!doc) return <div data-testid="loading-doc">Loading...</div>;
  return (
    <Editor
      key={doc.id}
      document={doc}
      onSave={async (updates) => {
        return await updateDocument({ ...updates, id: doc.id });
      }}
      onSaveAsCopy={async ({ title, content, format }) => {
        const created = await createDocument({ projectId, title });
        await updateDocument({ id: created.id, content, format });
      }}
      onBack={() => {}}
      projectId={projectId}
    />
  );
}

function LiveArchitectHarness({ projectId, designId }: { projectId: string; designId: string }) {
  const { designs, updateDesign } = useSystemDesigns(projectId);
  const design = designs.find((d) => d.id === designId);
  if (!design) return <div data-testid="loading-design">Loading...</div>;
  return (
    <SystemArchitect
      key={design.id}
      design={design}
      onSave={async (boardState: BoardState, options?: { expectedLocalRevision?: number }) => {
        return await updateDesign({
          id: design.id,
          board_state: boardState,
          ...(options?.expectedLocalRevision !== undefined
            ? { expectedLocalRevision: options.expectedLocalRevision }
            : {}),
        } as any);
      }}
      onBack={() => {}}
    />
  );
}

describe('OF-11 / TASK-16: Stale Editor & SystemArchitect Buffer Protection', () => {
  const dbName = 'ArtixDB_test_stale_buffer';
  let queryClient: QueryClient;

  beforeEach(async () => {
    localStorage.clear();
    resetTabCoordinatorsForTesting();
    await deleteArtixDB(dbName);
    mockDb = new ArtixDB(dbName);
    await mockDb.open();
    mockSyncMetaRepo = new SyncMetadataRepository(mockDb);
    mockOutboxRepo = new OutboxRepository(mockDb);
    mockDocRepo = new DocumentRepository(mockDb, mockOutboxRepo, mockSyncMetaRepo);
    mockDesignRepo = new SystemDesignRepository(mockDb, mockOutboxRepo, mockSyncMetaRepo);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(async () => {
    cleanup();
    queryClient.clear();
    if (mockDb?.isOpen()) mockDb.close();
    await deleteArtixDB(dbName);
    resetTabCoordinatorsForTesting();
    localStorage.clear();
  });

  it('throws StaleBufferError at repository layer when expectedLocalRevision lags behind pulled remote snapshot', async () => {
    const StaleBufferErrorCtor = (LocalErrors as Record<string, any>).StaleBufferError;
    expect(StaleBufferErrorCtor).toBeDefined();

    const initial = await mockDocRepo.applyRemoteSnapshot({
      id: 'doc-1',
      userId: TEST_USER.id,
      projectId: 'proj-1',
      title: 'Spec',
      content: 'Version 1',
      format: 'markdown',
      serverVersion: 1,
      updatedAt: '2026-10-01T10:00:00.000Z',
    });
    expect(initial.localRevision).toBe(1);

    const pulled = await mockDocRepo.applyRemoteSnapshot({
      id: 'doc-1',
      userId: TEST_USER.id,
      projectId: 'proj-1',
      title: 'Spec',
      content: 'Remote Version 2',
      format: 'markdown',
      serverVersion: 2,
      updatedAt: '2026-10-01T10:05:00.000Z',
    });
    expect(pulled.localRevision).toBeGreaterThan(initial.localRevision);

    await expect(
      (mockDocRepo as any).update(
        'doc-1',
        { content: 'Stale Local Overwrite' },
        { expectedLocalRevision: initial.localRevision },
      ),
    ).rejects.toBeInstanceOf(StaleBufferErrorCtor);

    const stored = await mockDocRepo.getById('doc-1');
    expect(stored?.content).toBe('Remote Version 2');
    const pending = await mockOutboxRepo.getPending(undefined, TEST_USER.id);
    expect(pending).toHaveLength(0);
  });

  it('auto-updates open Editor when buffer is CLEAN and a newer remote snapshot is pulled', async () => {
    await mockDocRepo.applyRemoteSnapshot({
      id: 'doc-clean',
      userId: TEST_USER.id,
      projectId: 'proj-1',
      title: 'Clean Doc',
      content: 'Initial v1 text',
      format: 'markdown',
      serverVersion: 1,
      updatedAt: '2026-10-01T10:00:00.000Z',
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LiveDocumentEditorHarness projectId="proj-1" docId="doc-clean" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const textarea = (await screen.findByTestId('monaco-textarea')) as HTMLTextAreaElement;
    expect(textarea.value).toBe('Initial v1 text');

    await act(async () => {
      await mockDocRepo.applyRemoteSnapshot({
        id: 'doc-clean',
        userId: TEST_USER.id,
        projectId: 'proj-1',
        title: 'Clean Doc Updated',
        content: 'Pulled v2 remote text',
        format: 'markdown',
        serverVersion: 2,
        updatedAt: '2026-10-01T10:02:00.000Z',
      });
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
    });

    await waitFor(() => {
      expect((screen.getByTestId('monaco-textarea') as HTMLTextAreaElement).value).toBe(
        'Pulled v2 remote text',
      );
    });
    expect(screen.queryByTestId('stale-buffer-banner')).not.toBeInTheDocument();
  });

  it('blocks silent overwrite in Editor when buffer is DIRTY and offers Load Remote / Keep Mine / Save Copy', async () => {
    await mockDocRepo.applyRemoteSnapshot({
      id: 'doc-dirty',
      userId: TEST_USER.id,
      projectId: 'proj-1',
      title: 'Shared Spec',
      content: 'Base v1',
      format: 'markdown',
      serverVersion: 1,
      updatedAt: '2026-10-01T10:00:00.000Z',
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LiveDocumentEditorHarness projectId="proj-1" docId="doc-dirty" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const textarea = (await screen.findByTestId('monaco-textarea')) as HTMLTextAreaElement;
    expect(textarea.value).toBe('Base v1');

    // User types locally (dirty buffer before 1500ms debounce fires)
    fireEvent.change(textarea, { target: { value: 'My unsaved local draft' } });

    // Remote v2 arrives in IndexedDB before debounce completes
    await act(async () => {
      await mockDocRepo.applyRemoteSnapshot({
        id: 'doc-dirty',
        userId: TEST_USER.id,
        projectId: 'proj-1',
        title: 'Shared Spec',
        content: 'Authoritative remote v2',
        format: 'markdown',
        serverVersion: 2,
        updatedAt: '2026-10-01T10:03:00.000Z',
      });
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
    });

    // Banner must appear, local draft remains visible, and remote v2 in Dexie is NOT overwritten!
    const banner = await screen.findByTestId('stale-buffer-banner');
    expect(banner).toBeInTheDocument();
    expect((screen.getByTestId('monaco-textarea') as HTMLTextAreaElement).value).toBe(
      'My unsaved local draft',
    );

    // Wait past the 1500ms autosave delay to prove paused autosave never overwrites v2
    await new Promise((r) => setTimeout(r, 1700));
    const storedAfterWait = await mockDocRepo.getById('doc-dirty');
    expect(storedAfterWait?.content).toBe('Authoritative remote v2');
    expect(await mockOutboxRepo.getPending(undefined, TEST_USER.id)).toHaveLength(0);

    // Clicking "Load remote (discard mine)" adopts remote v2 and clears banner
    fireEvent.click(screen.getByRole('button', { name: /load remote/i }));
    await waitFor(() => {
      expect((screen.getByTestId('monaco-textarea') as HTMLTextAreaElement).value).toBe(
        'Authoritative remote v2',
      );
    });
    expect(screen.queryByTestId('stale-buffer-banner')).not.toBeInTheDocument();
  });

  it('auto-updates open SystemArchitect when board buffer is CLEAN and remote snapshot arrives', async () => {
    await mockDesignRepo.applyRemoteSnapshot({
      id: 'des-clean',
      userId: TEST_USER.id,
      projectId: 'proj-1',
      name: 'System v1',
      boardState: {
        nodes: [{ id: 'n1', type: 'database', position: { x: 10, y: 10 }, data: { label: 'Postgres v1' } }],
        edges: [],
      },
      serverVersion: 1,
      updatedAt: '2026-10-01T10:00:00.000Z',
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LiveArchitectHarness projectId="proj-1" designId="des-clean" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('flow-node-n1')).toHaveTextContent('Postgres v1');

    await act(async () => {
      await mockDesignRepo.applyRemoteSnapshot({
        id: 'des-clean',
        userId: TEST_USER.id,
        projectId: 'proj-1',
        name: 'System v2',
        boardState: {
          nodes: [
            { id: 'n1', type: 'database', position: { x: 10, y: 10 }, data: { label: 'Postgres v2' } },
            { id: 'n2', type: 'server', position: { x: 200, y: 10 }, data: { label: 'API Gateway' } },
          ],
          edges: [],
        },
        serverVersion: 2,
        updatedAt: '2026-10-01T10:04:00.000Z',
      });
      await queryClient.invalidateQueries({ queryKey: ['system_designs'] });
    });

    await waitFor(() => {
      expect(screen.getByTestId('flow-node-n1')).toHaveTextContent('Postgres v2');
      expect(screen.getByTestId('flow-node-n2')).toHaveTextContent('API Gateway');
    });
    expect(screen.queryByTestId('stale-buffer-banner')).not.toBeInTheDocument();
  });

  it('blocks silent overwrite in SystemArchitect when board buffer is DIRTY and surfaces conflict banner', async () => {
    await mockDesignRepo.applyRemoteSnapshot({
      id: 'des-dirty',
      userId: TEST_USER.id,
      projectId: 'proj-1',
      name: 'Dirty Board',
      boardState: {
        nodes: [{ id: 'n1', type: 'database', position: { x: 0, y: 0 }, data: { label: 'Base DB' } }],
        edges: [],
      },
      serverVersion: 1,
      updatedAt: '2026-10-01T10:00:00.000Z',
    });

    // Seed a crash-recovered uncommitted local draft so the canvas opens in a DIRTY state
    localStorage.setItem(
      'artix.draft.design-des-dirty',
      JSON.stringify({
        nodes: [
          { id: 'n1', type: 'database', position: { x: 0, y: 0 }, data: { label: 'Base DB' } },
          { id: 'n-local', type: 'server', position: { x: 80, y: 80 }, data: { label: 'Local Dirty Node' } },
        ],
        edges: [],
      }),
    );

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <LiveArchitectHarness projectId="proj-1" designId="des-dirty" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('flow-node-n-local')).toHaveTextContent('Local Dirty Node');

    // Before the 1000ms canvas debounce fires, remote v2 arrives!
    await act(async () => {
      await mockDesignRepo.applyRemoteSnapshot({
        id: 'des-dirty',
        userId: TEST_USER.id,
        projectId: 'proj-1',
        name: 'Dirty Board',
        boardState: {
          nodes: [{ id: 'n-remote', type: 'cloud', position: { x: 50, y: 50 }, data: { label: 'Remote Cloud v2' } }],
          edges: [],
        },
        serverVersion: 2,
        updatedAt: '2026-10-01T10:05:00.000Z',
      });
      await queryClient.invalidateQueries({ queryKey: ['system_designs'] });
    });

    const banner = await screen.findByTestId('stale-buffer-banner');
    expect(banner).toBeInTheDocument();

    // Wait past the 1000ms canvas debounce to prove remote v2 was NOT overwritten
    await new Promise((r) => setTimeout(r, 1200));
    const storedDesign = await mockDesignRepo.getById('des-dirty');
    expect(storedDesign?.boardState.nodes.map((n) => n.id)).toEqual(['n-remote']);
    expect(await mockOutboxRepo.getPending(undefined, TEST_USER.id)).toHaveLength(0);
  });
});
