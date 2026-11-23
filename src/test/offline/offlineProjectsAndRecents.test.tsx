import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { useProjects } from '@/hooks/useProjects';
import { useRecentActivity } from '@/hooks/useRecentActivity';
import { deleteArtixDB, getUserArtixDB } from '@/lib/local/db';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { SystemDesignRepository } from '@/lib/repositories/systemDesignRepository';
import ProjectWorkspace from '@/pages/ProjectWorkspace';

const cloudState = vi.hoisted(() => ({
  online: true,
  projects: [] as Array<{
    id: string;
    user_id: string;
    name: string;
    created_at: string;
    updated_at: string;
  }>,
  documents: [] as Array<{
    id: string;
    user_id: string;
    project_id: string | null;
    title: string;
    updated_at: string;
  }>,
  designs: [] as Array<{
    id: string;
    user_id: string;
    project_id: string;
    name: string;
    updated_at: string;
  }>,
}));

function buildPostgrestChain(table: string) {
  const resolveRows = async () => {
    if (!cloudState.online) {
      return {
        data: null,
        error: { message: 'TypeError: Failed to fetch', code: '' },
      };
    }
    if (table === 'projects') {
      return { data: [...cloudState.projects], error: null };
    }
    if (table === 'documents') {
      return { data: [...cloudState.documents], error: null };
    }
    if (table === 'system_designs') {
      return { data: [...cloudState.designs], error: null };
    }
    return { data: [], error: null };
  };

  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'not', 'order', 'limit', 'insert', 'update', 'delete', 'single'];
  for (const method of methods) {
    chain[method] = () => chain;
  }
  chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    resolveRows().then(onFulfilled, onRejected);
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => buildPostgrestChain(table),
  },
}));

const authState = {
  user: { id: 'user-of04', email: 'offline@artix.test' },
  loading: false,
  isOfflineSession: false,
};

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: authState.user,
    session: { user: authState.user },
    loading: authState.loading,
    sessionError: null,
    isOfflineSession: authState.isOfflineSession,
    reauthRequired: false,
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
          projectRepo: null,
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

vi.mock('@/hooks/useUsageLimits', () => ({
  useUsageLimits: () => ({
    projects: { used: 2, limit: 3, canCreate: true },
    documents: { used: 2, limit: 10, canCreate: true },
    systemDesigns: { used: 1, limit: 3, canCreate: true },
    aiGenerations: { used: 0, limit: 5, canCreate: true },
    isLoading: false,
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

function RouteProbe() {
  const location = useLocation();
  return <div data-testid="current-path">{location.pathname}</div>;
}

describe('OF-04 / TASK-26: Local Dexie Read-Through Cache for projects & Local useRecentActivity', () => {
  const userId = 'user-of04';
  let originalOnLineDescriptor: PropertyDescriptor | undefined;

  function setBrowserOnline(online: boolean) {
    cloudState.online = online;
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => online,
    });
    onlineManager.setOnline(online);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    await deleteArtixDB();
    originalOnLineDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
    setBrowserOnline(true);
    authState.isOfflineSession = false;
    runtimeMockState.isReady = true;
    runtimeMockState.db = getUserArtixDB(userId);

    cloudState.projects = [
      {
        id: 'proj-alpha',
        user_id: userId,
        name: 'Alpha Architecture',
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-10T10:00:00.000Z',
      },
      {
        id: 'proj-beta',
        user_id: userId,
        name: 'Beta Platform',
        created_at: '2026-10-02T00:00:00.000Z',
        updated_at: '2026-10-09T10:00:00.000Z',
      },
    ];
    cloudState.documents = [
      {
        id: 'doc-1',
        user_id: userId,
        project_id: 'proj-alpha',
        title: 'Initial Spec',
        updated_at: '2026-10-10T09:00:00.000Z',
      },
    ];
    cloudState.designs = [
      {
        id: 'des-1',
        user_id: userId,
        project_id: 'proj-alpha',
        name: 'Topology v1',
        updated_at: '2026-10-10T09:30:00.000Z',
      },
    ];
  });

  afterEach(async () => {
    setBrowserOnline(true);
    if (originalOnLineDescriptor) {
      Object.defineProperty(window.navigator, 'onLine', originalOnLineDescriptor);
    }
    runtimeMockState.db = null;
    await deleteArtixDB();
  });

  it('caches projects online (pruning remotely deleted projects), serves accurate local counts & recents on cold offline reload, and resolves /projects/:id', async () => {
    const db = getUserArtixDB(userId);
    const docRepo = new DocumentRepository(db);
    const designRepo = new SystemDesignRepository(db);

    await docRepo.create({
      id: 'doc-1',
      userId,
      projectId: 'proj-alpha',
      title: 'Initial Spec',
      content: '# v1',
    });
    await designRepo.create({
      id: 'des-1',
      userId,
      projectId: 'proj-alpha',
      name: 'Topology v1',
      boardState: { nodes: [], edges: [] },
    });

    // 1. Online warm load populates db.projects
    const onlineQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onlineWrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={onlineQc}>{children}</QueryClientProvider>
    );
    const { result: onlineHooks, unmount: unmountOnline } = renderHook(
      () => useProjects(),
      { wrapper: onlineWrapper },
    );

    await waitFor(() => {
      expect(onlineHooks.current.projects).toHaveLength(2);
    });
    unmountOnline();

    // Simulate remote deletion of Beta while online & another online sync pass pruning it
    cloudState.projects = [cloudState.projects[0]];
    const pruneQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const pruneWrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={pruneQc}>{children}</QueryClientProvider>
    );
    const { result: prunedHooks, unmount: unmountPrune } = renderHook(
      () => useProjects(),
      { wrapper: pruneWrapper },
    );
    await waitFor(() => {
      expect(prunedHooks.current.projects).toHaveLength(1);
    });
    unmountPrune();

    // 2. Go completely OFFLINE, edit doc-1 and create doc-2 locally in Dexie
    setBrowserOnline(false);
    authState.isOfflineSession = true;

    await new Promise((r) => setTimeout(r, 10));
    await docRepo.update('doc-1', { title: 'Edited Spec Offline', content: '# v2 offline' });
    await new Promise((r) => setTimeout(r, 10));
    await docRepo.create({
      id: 'doc-2',
      userId,
      projectId: 'proj-alpha',
      title: 'Brand New Offline Doc',
      content: '# created offline',
    });

    // 3. Cold reload simulation: brand-new QueryClient while offline
    const coldOfflineQc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const coldWrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={coldOfflineQc}>{children}</QueryClientProvider>
    );

    const { result: offlineResult } = renderHook(
      () => ({
        projectsHook: useProjects(),
        recentsHook: useRecentActivity(5),
      }),
      { wrapper: coldWrapper },
    );

    await waitFor(() => {
      expect(offlineResult.current.projectsHook.isLoading).toBe(false);
      expect(offlineResult.current.projectsHook.projects).toHaveLength(1);
      expect(offlineResult.current.recentsHook.isSuccess).toBe(true);
    });

    const alpha = offlineResult.current.projectsHook.projects[0];
    expect(alpha.id).toBe('proj-alpha');
    expect(alpha.name).toBe('Alpha Architecture');
    expect(alpha.document_count).toBe(2); // doc-1 + offline doc-2
    expect(alpha.design_count).toBe(1);

    const recents = offlineResult.current.recentsHook.data ?? [];
    expect(recents).toHaveLength(3);
    expect(recents[0].title).toBe('Brand New Offline Doc');
    expect(recents[1].title).toBe('Edited Spec Offline');
    expect(recents[2].title).toBe('Topology v1');

    // 4. Mount /projects/proj-alpha offline: must render project.name without redirecting to /dashboard
    render(
      <QueryClientProvider client={coldOfflineQc}>
        <MemoryRouter initialEntries={['/projects/proj-alpha']}>
          <Routes>
            <Route
              path="/projects/:id"
              element={
                <>
                  <ProjectWorkspace />
                  <RouteProbe />
                </>
              }
            />
            <Route path="/dashboard" element={<div data-testid="redirected-dashboard" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Alpha Architecture', level: 1 })).toBeInTheDocument();
    });
    expect(screen.getByTestId('current-path').textContent).toBe('/projects/proj-alpha');
    expect(screen.queryByTestId('redirected-dashboard')).not.toBeInTheDocument();
  });

  it('supports offline project create, rename, and delete via local Dexie + Outbox without hanging', async () => {
    setBrowserOnline(false);

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useProjects(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const created = await Promise.race([
      result.current.createProject('Offline Project'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('createProject hung paused')), 500),
      ),
    ]);
    expect(created.name).toBe('Offline Project');

    const updated = await result.current.updateProject({
      id: created.id,
      name: 'Renamed Offline',
    });
    expect(updated.name).toBe('Renamed Offline');

    await result.current.deleteProject(created.id);
    await waitFor(() => {
      expect(result.current.projects).toHaveLength(0);
    });
  });
});
