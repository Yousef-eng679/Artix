import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useWorkspaceFolders } from '@/hooks/useWorkspaceFolders';
import { deleteArtixDB, getUserArtixDB } from '@/lib/local/db';
import { WorkspaceFolderRepository } from '@/lib/repositories/folderRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';

const mockUser = { id: 'user-folder-offline', email: 'folder-offline@artix.dev' };

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}));

// Mock Supabase to simulate network hanging / rejection
vi.mock('@/integrations/supabase/client', () => {
  const offlineError = { message: 'Network request failed (offline)', code: 'PGRST000' };
  const mockBuilder: any = {
    select: vi.fn(() => mockBuilder),
    eq: vi.fn(() => mockBuilder),
    order: vi.fn(() => Promise.reject(offlineError)),
    insert: vi.fn(() => Promise.reject(offlineError)),
    update: vi.fn(() => mockBuilder),
    delete: vi.fn(() => mockBuilder),
    single: vi.fn(() => Promise.reject(offlineError)),
  };

  return {
    supabase: {
      from: vi.fn(() => mockBuilder),
    },
  };
});

describe('Phase 1: Pure Local-First useWorkspaceFolders Cutover', () => {
  let queryClient: QueryClient;
  let folderRepo: WorkspaceFolderRepository;
  let outboxRepo: OutboxRepository;
  const projectId = 'proj-cutover-test';

  beforeEach(async () => {
    await deleteArtixDB();
    const userDb = getUserArtixDB(mockUser.id);
    outboxRepo = new OutboxRepository(userDb);
    folderRepo = new WorkspaceFolderRepository(userDb, outboxRepo);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
      },
    });
  });

  afterEach(async () => {
    await deleteArtixDB();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('creates folder instantly in local IndexedDB without waiting for Supabase', async () => {
    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });

    const startTime = performance.now();
    let created: any;
    await act(async () => {
      created = await result.current.createFolder({
        name: 'Offline Alpha Folder',
        projectId,
      });
    });
    const duration = performance.now() - startTime;

    expect(created).toBeDefined();
    expect(created.name).toBe('Offline Alpha Folder');
    expect(created.id).toBeDefined();
    // Must complete locally with near-zero latency (< 250ms under heavy test concurrency)
    expect(duration).toBeLessThan(250);

    // Verify written to Dexie
    const local = await folderRepo.getById(created.id);
    expect(local).toBeDefined();
    expect(local?.name).toBe('Offline Alpha Folder');

    // Verify enqueued in Outbox
    const pendingOutbox = await outboxRepo.getPending(10, mockUser.id);
    expect(pendingOutbox.some((e) => e.entityId === created.id && e.operation === 'create')).toBe(true);
  });

  it('preserves offline folders in query results without remote dependency', async () => {
    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });

    let created: any;
    await act(async () => {
      created = await result.current.createFolder({
        name: 'Local Only Folder',
        projectId,
      });
    });

    // Invalidate queries to simulate tab switch or refetch
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['workspace_folders', projectId] });
    });

    expect(result.current.folders.some((f) => f.id === created.id)).toBe(true);
    expect(result.current.folders.find((f) => f.id === created.id)?.name).toBe('Local Only Folder');
  });

  it('renames folder locally and coalesces with pending create or queues update for synced folder', async () => {
    // 1. Pre-populate a folder that was already synced from cloud (skipOutbox: true)
    const syncedFolder = await folderRepo.create({
      id: 'folder-synced-123',
      name: 'Synced Original',
      projectId,
      userId: mockUser.id,
    }, { skipOutbox: true });

    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });

    await act(async () => {
      await result.current.renameFolder({
        id: syncedFolder.id,
        name: 'Synced Renamed Name',
      });
    });

    const local = await folderRepo.getById(syncedFolder.id);
    expect(local?.name).toBe('Synced Renamed Name');

    const pendingOutbox = await outboxRepo.getPending(10, mockUser.id);
    expect(pendingOutbox.some((e) => e.entityId === syncedFolder.id && e.operation === 'update')).toBe(true);
  });

  it('soft-deletes synced folder and queues outbox deletion mutation offline', async () => {
    // Pre-populate a folder that was already synced from cloud
    const syncedFolder = await folderRepo.create({
      id: 'folder-to-delete-123',
      name: 'Synced To Delete',
      projectId,
      userId: mockUser.id,
    }, { skipOutbox: true });

    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });

    await act(async () => {
      await result.current.deleteFolder(syncedFolder.id);
    });

    const local = await folderRepo.getById(syncedFolder.id);
    expect(local).toBeNull();

    const raw = await folderRepo.getByIdIncludeDeleted(syncedFolder.id);
    expect(raw?.isDeleted).toBe(true);

    const pendingOutbox = await outboxRepo.getPending(10, mockUser.id);
    expect(pendingOutbox.some((e) => e.entityId === syncedFolder.id && e.operation === 'delete')).toBe(true);
  });

  it('coalesces offline create + delete so born-and-died offline entities are cancelled from outbox', async () => {
    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });

    let created: any;
    await act(async () => {
      created = await result.current.createFolder({
        name: 'Ephemeral Offline Folder',
        projectId,
      });
    });

    // Verify it is initially pending create
    let pending = await outboxRepo.getPending(10, mockUser.id);
    expect(pending.some((e) => e.entityId === created.id && e.operation === 'create')).toBe(true);

    // Delete it before it ever reaches cloud
    await act(async () => {
      await result.current.deleteFolder(created.id);
    });

    // Coalescing cancels out create + delete completely
    pending = await outboxRepo.getPending(10, mockUser.id);
    expect(pending.some((e) => e.entityId === created.id)).toBe(false);
  });
});
