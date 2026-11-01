import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { useDocuments } from '@/hooks/useDocuments';
import { useSystemDesigns } from '@/hooks/useSystemDesigns';
import { useWorkspaceFolders } from '@/hooks/useWorkspaceFolders';
import { deleteArtixDB, getUserArtixDB } from '@/lib/local/db';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { SystemDesignRepository } from '@/lib/repositories/systemDesignRepository';
import { WorkspaceFolderRepository } from '@/lib/repositories/folderRepository';
import ProjectWorkspace from '@/pages/ProjectWorkspace';

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/components/Editor/Editor', () => ({
  Editor: ({ document }: { document: { id: string; title: string; content: string } }) => (
    <div data-testid="offline-editor-mounted">
      <span>{document.title}</span>
      <span>{document.content}</span>
    </div>
  ),
}));

vi.mock('@/components/SystemArchitect/SystemArchitect', () => ({
  SystemArchitect: ({ design }: { design: { id: string; name: string } }) => (
    <div data-testid="offline-architect-mounted">{design.name}</div>
  ),
}));

const authState = {
  user: { id: 'user-of01', email: 'offline@artix.test' } as { id: string; email: string } | null,
  loading: false,
};

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: authState.user,
    session: authState.user ? { user: authState.user } : null,
    loading: authState.loading,
    sessionError: null,
  }),
}));

const runtimeMockState = {
  isReady: true,
  db: null as ReturnType<typeof getUserArtixDB> | null,
};

vi.mock('@/contexts/UserSyncRuntimeContext', () => ({
  useUserSyncRuntime: () =>
    runtimeMockState.db
      ? {
          runtime: null,
          db: runtimeMockState.db,
          documentRepo: null,
          folderRepo: null,
          systemDesignRepo: null,
          outboxRepo: null,
          syncEngine: null,
          tabCoordinator: null,
          realtimeSync: null,
          isReady: runtimeMockState.isReady,
          runtimeStatus: null,
          isDegraded: false,
          runtimeError: null,
        }
      : null,
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    projects: [
      {
        id: 'proj-1',
        user_id: 'user-of01',
        name: 'Offline Project',
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      },
    ],
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useUsageLimits', () => ({
  useUsageLimits: () => ({
    projects: { used: 1, limit: 3, canCreate: true },
    documents: { used: 1, limit: 10, canCreate: true },
    systemDesigns: { used: 1, limit: 3, canCreate: true },
    aiGenerations: { used: 0, limit: 5, canCreate: true },
    isLoading: false,
  }),
}));

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

describe('OF-01 / TASK-24: Offline networkMode for local Dexie hooks & cold-start URL guard', () => {
  const userId = 'user-of01';
  const projectId = 'proj-1';
  let originalOnLineDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    await deleteArtixDB();
    authState.user = { id: userId, email: 'offline@artix.test' };
    authState.loading = false;
    runtimeMockState.isReady = true;
    runtimeMockState.db = getUserArtixDB(userId);

    originalOnLineDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => false,
    });
    onlineManager.setOnline(false);
  });

  afterEach(async () => {
    onlineManager.setOnline(true);
    if (originalOnLineDescriptor) {
      Object.defineProperty(window.navigator, 'onLine', originalOnLineDescriptor);
    } else {
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        get: () => true,
      });
    }
    runtimeMockState.db = null;
    await deleteArtixDB();
  });

  it('reads documents, system designs, and workspace folders from Dexie immediately while offline', async () => {
    const db = getUserArtixDB(userId);
    const docRepo = new DocumentRepository(db);
    const designRepo = new SystemDesignRepository(db);
    const folderRepo = new WorkspaceFolderRepository(db);

    await folderRepo.create({ id: 'folder-1', userId, projectId, name: 'Specs' });
    await docRepo.create({
      id: 'doc-1',
      userId,
      projectId,
      folderId: 'folder-1',
      title: 'Offline Spec',
      content: '# Offline Content',
    });
    await designRepo.create({
      id: 'design-1',
      userId,
      projectId,
      folderId: 'folder-1',
      name: 'Offline Architecture',
      boardState: { nodes: [], edges: [] },
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({
        docs: useDocuments(projectId),
        designs: useSystemDesigns(projectId),
        folders: useWorkspaceFolders(projectId),
      }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.docs.documents).toHaveLength(1);
      expect(result.current.designs.designs).toHaveLength(1);
      expect(result.current.folders.folders).toHaveLength(1);
    });

    expect(result.current.docs.documents[0].title).toBe('Offline Spec');
    expect(result.current.designs.designs[0].name).toBe('Offline Architecture');
    expect(result.current.folders.folders[0].name).toBe('Specs');
  });

  it('executes create, update, and delete mutations against Dexie without pausing while offline', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({
        docs: useDocuments(projectId),
        designs: useSystemDesigns(projectId),
        folders: useWorkspaceFolders(projectId),
      }),
      { wrapper },
    );

    let createdDocId = '';
    await act(async () => {
      const folder = await Promise.race([
        result.current.folders.createFolder({ name: 'Offline Folder', projectId }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('createFolder paused while offline')), 500),
        ),
      ]);
      expect(folder.name).toBe('Offline Folder');

      const doc = await Promise.race([
        result.current.docs.createDocument({
          projectId,
          title: 'Created Offline',
          folderId: folder.id,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('createDocument paused while offline')), 500),
        ),
      ]);
      createdDocId = doc.id;

      await Promise.race([
        result.current.docs.updateDocument({
          id: doc.id,
          content: 'Updated while offline',
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('updateDocument paused while offline')), 500),
        ),
      ]);

      const design = await Promise.race([
        result.current.designs.createDesign({ name: 'Created Design Offline', projectId }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('createDesign paused while offline')), 500),
        ),
      ]);
      expect(design.name).toBe('Created Design Offline');
    });

    const db = getUserArtixDB(userId);
    const storedDoc = await db.documents.get(createdDocId);
    expect(storedDoc?.content).toBe('Updated while offline');
  });

  it('preserves ?doc= deep link offline and during cold-start auth/runtime initialization without false "Document not found"', async () => {
    const db = getUserArtixDB(userId);
    const docRepo = new DocumentRepository(db);
    await docRepo.create({
      id: 'doc-deep',
      userId,
      projectId,
      title: 'Deep Linked Offline Doc',
      content: 'Persisted locally',
    });

    // Simulate cold-start phase where auth is initially loading
    authState.user = null;
    authState.loading = true;
    runtimeMockState.isReady = false;

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/projects/${projectId}?doc=doc-deep`]}>
          <Routes>
            <Route
              path="/projects/:id"
              element={
                <>
                  <ProjectWorkspace />
                  <LocationDisplay />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Must NOT toast "Document not found" or strip ?doc=doc-deep while auth/runtime is initializing
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByTestId('location-search').textContent).toBe('?doc=doc-deep');

    // Now auth resolves and runtime becomes ready while STILL OFFLINE
    act(() => {
      authState.user = { id: userId, email: 'offline@artix.test' };
      authState.loading = false;
      runtimeMockState.isReady = true;
    });
    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/projects/${projectId}?doc=doc-deep`]}>
          <Routes>
            <Route
              path="/projects/:id"
              element={
                <>
                  <ProjectWorkspace />
                  <LocationDisplay />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('offline-editor-mounted')).toHaveTextContent('Deep Linked Offline Doc');
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByTestId('location-search').textContent).toBe('?doc=doc-deep');
  });
});
