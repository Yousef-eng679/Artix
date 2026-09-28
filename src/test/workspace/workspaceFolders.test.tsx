import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useWorkspaceFolders } from '@/hooks/useWorkspaceFolders';
import { supabase } from '@/integrations/supabase/client';
import { deleteArtixDB, getUserArtixDB } from '@/lib/local/db';
import { WorkspaceFolderRepository } from '@/lib/repositories/folderRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';

const mockUser = { id: 'user-alpha', email: 'user@artix.dev' };
let currentUser: typeof mockUser | null = mockUser;

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: currentUser, loading: false }),
}));

vi.mock('@/integrations/supabase/client', () => {
  const offlineError = { message: 'Network request failed (offline)', code: 'PGRST000' };
  const mockBuilder: any = {
    select: vi.fn(() => mockBuilder),
    eq: vi.fn(() => mockBuilder),
    order: vi.fn(() => Promise.resolve({ data: null, error: offlineError })),
    insert: vi.fn(() => Promise.resolve({ data: null, error: offlineError })),
    update: vi.fn(() => mockBuilder),
    delete: vi.fn(() => mockBuilder),
    single: vi.fn(() => Promise.resolve({ data: null, error: offlineError })),
  };

  return {
    supabase: {
      from: vi.fn(() => mockBuilder),
    },
  };
});

describe('useWorkspaceFolders Hook', () => {
  let queryClient: QueryClient;
  let folderRepo: WorkspaceFolderRepository;
  let outboxRepo: OutboxRepository;
  const projectId = 'proj-123';

  beforeEach(async () => {
    await deleteArtixDB();
    const userDb = getUserArtixDB(mockUser.id);
    outboxRepo = new OutboxRepository(userDb);
    folderRepo = new WorkspaceFolderRepository(userDb, outboxRepo);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 0,
        },
      },
    });
    currentUser = mockUser;
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await deleteArtixDB();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('returns empty array when user is unauthenticated or projectId is missing', async () => {
    currentUser = null;
    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });
    expect(result.current.folders).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('queries and returns folders sorted by name', async () => {
    // Pre-populate folders in local repository
    await folderRepo.create({
      id: 'f1',
      projectId,
      userId: 'user-alpha',
      name: 'Authentication',
    }, { skipOutbox: true });

    await folderRepo.create({
      id: 'f2',
      projectId,
      userId: 'user-alpha',
      name: 'Billing',
    }, { skipOutbox: true });

    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });

    await waitFor(() => {
      expect(result.current.folders).toHaveLength(2);
    });

    expect(result.current.folders[0].id).toBe('f1');
    expect(result.current.folders[0].name).toBe('Authentication');
    expect(result.current.folders[1].id).toBe('f2');
    expect(result.current.folders[1].name).toBe('Billing');
  });

  it('creates a new folder via createFolder mutation', async () => {
    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });

    let created: any;
    await act(async () => {
      created = await result.current.createFolder({ name: 'Deployment', projectId });
    });

    expect(created.name).toBe('Deployment');
    expect(created.projectId).toBe(projectId);

    // Verify stored in IndexedDB
    const local = await folderRepo.getById(created.id);
    expect(local).toBeDefined();
    expect(local?.name).toBe('Deployment');

    // Verify enqueued in Outbox
    const pending = await outboxRepo.getPending(10, 'user-alpha');
    expect(pending.some((e) => e.entityId === created.id && e.operation === 'create')).toBe(true);
  });

  it('renames a folder via renameFolder mutation', async () => {
    const existing = await folderRepo.create({
      id: 'f-1',
      projectId,
      userId: 'user-alpha',
      name: 'Original Area',
    }, { skipOutbox: true });

    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });

    await act(async () => {
      await result.current.renameFolder({ id: existing.id, name: 'Renamed Area' });
    });

    const local = await folderRepo.getById(existing.id);
    expect(local?.name).toBe('Renamed Area');

    const pending = await outboxRepo.getPending(10, 'user-alpha');
    expect(pending.some((e) => e.entityId === existing.id && e.operation === 'update')).toBe(true);
  });

  it('deletes a folder via deleteFolder mutation and invalidates related caches', async () => {
    const existing = await folderRepo.create({
      id: 'f-1',
      projectId,
      userId: 'user-alpha',
      name: 'To Delete',
    }, { skipOutbox: true });

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });

    await act(async () => {
      await result.current.deleteFolder(existing.id);
    });

    // Verified deleted locally
    const local = await folderRepo.getById(existing.id);
    expect(local).toBeNull();

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['workspace_folders', projectId] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['documents'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['system_designs', projectId] });
  });

  it('throws a descriptive error when createFolder encounters a duplicate name', async () => {
    await folderRepo.create({
      projectId,
      userId: 'user-alpha',
      name: 'Billing',
    }, { skipOutbox: true });

    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });

    await expect(
      result.current.createFolder({ name: '  Billing  ', projectId })
    ).rejects.toThrow('A folder named "Billing" already exists in this project');
  });

  it('throws a descriptive error when renameFolder encounters a duplicate name', async () => {
    await folderRepo.create({
      id: 'f-existing',
      projectId,
      userId: 'user-alpha',
      name: 'ExistingFolder',
    }, { skipOutbox: true });

    const folderToRename = await folderRepo.create({
      id: 'f-1',
      projectId,
      userId: 'user-alpha',
      name: 'OriginalFolder',
    }, { skipOutbox: true });

    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });

    await expect(
      result.current.renameFolder({ id: folderToRename.id, name: '  ExistingFolder  ' })
    ).rejects.toThrow('A folder named "ExistingFolder" already exists in this project');
  });
});
