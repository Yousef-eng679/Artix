import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useWorkspaceFolders } from '@/hooks/useWorkspaceFolders';
import { deleteArtixDB } from '@/lib/local/db';
import { WorkspaceFolderRepository } from '@/lib/repositories/folderRepository';

const mockUser = { id: 'user-offline-3', email: 'offline3@artix.dev' };

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}));

// Mock Supabase to simulate offline state
vi.mock('@/integrations/supabase/client', () => {
  const offlineError = { message: 'Network error (offline)', code: 'PGRST000' };
  const mockBuilder: any = {
    select: vi.fn(() => mockBuilder),
    eq: vi.fn(() => mockBuilder),
    order: vi.fn(() => Promise.resolve({ data: null, error: offlineError })),
    insert: vi.fn(() => mockBuilder),
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

describe('Offline-First useWorkspaceFolders Hook Integration', () => {
  let queryClient: QueryClient;
  let folderRepo: WorkspaceFolderRepository;
  const projectId = 'proj-offline-gamma';

  beforeEach(async () => {
    await deleteArtixDB();
    folderRepo = new WorkspaceFolderRepository();
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

  it('creates and renames folders offline and persists in IndexedDB', async () => {
    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });

    let created: any;
    await act(async () => {
      created = await result.current.createFolder({
        name: 'Backend Services',
        projectId,
      });
    });

    expect(created.name).toBe('Backend Services');
    expect(created.id).toBeDefined();

    // Verify stored locally
    const local = await folderRepo.getById(created.id);
    expect(local).toBeDefined();
    expect(local?.name).toBe('Backend Services');

    // Rename offline
    await act(async () => {
      await result.current.renameFolder({
        id: created.id,
        name: 'Microservices',
      });
    });

    const renamed = await folderRepo.getById(created.id);
    expect(renamed?.name).toBe('Microservices');
  });

  it('validates duplicate folder names locally offline', async () => {
    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });

    await act(async () => {
      await result.current.createFolder({
        name: 'Specs',
        projectId,
      });
    });

    // Attempting to create duplicate should throw
    await act(async () => {
      await expect(
        result.current.createFolder({
          name: 'specs',
          projectId,
        })
      ).rejects.toThrow('already exists in this project');
    });
  });
});
