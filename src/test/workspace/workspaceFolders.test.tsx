import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useWorkspaceFolders } from '@/hooks/useWorkspaceFolders';
import { supabase } from '@/integrations/supabase/client';

const mockUser = { id: 'user-alpha', email: 'user@artix.dev' };
let currentUser: typeof mockUser | null = mockUser;

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: currentUser, loading: false }),
}));

describe('useWorkspaceFolders Hook', () => {
  let queryClient: QueryClient;
  const projectId = 'proj-123';

  beforeEach(() => {
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
    const mockDbFolders = [
      {
        id: 'f1',
        project_id: projectId,
        user_id: 'user-alpha',
        name: 'Authentication',
        created_at: '2026-09-01T00:00:00Z',
        updated_at: '2026-09-01T00:00:00Z',
      },
      {
        id: 'f2',
        project_id: projectId,
        user_id: 'user-alpha',
        name: 'Billing',
        created_at: '2026-09-02T00:00:00Z',
        updated_at: '2026-09-02T00:00:00Z',
      },
    ];

    vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
      if (table === 'workspace_folders') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: async () => ({ data: mockDbFolders, error: null }),
              }),
            }),
          }),
        } as any;
      }
      return {} as any;
    });

    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });

    await waitFor(() => {
      expect(result.current.folders).toHaveLength(2);
    });

    expect(result.current.folders[0]).toEqual({
      id: 'f1',
      projectId,
      name: 'Authentication',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    });
    expect(result.current.folders[1].name).toBe('Billing');
  });

  it('creates a new folder via createFolder mutation', async () => {
    const newDbFolder = {
      id: 'f-new',
      project_id: projectId,
      user_id: 'user-alpha',
      name: 'Deployment',
      created_at: '2026-09-03T00:00:00Z',
      updated_at: '2026-09-03T00:00:00Z',
    };

    const insertMock = vi.fn().mockReturnValue({
      select: () => ({
        single: async () => ({ data: newDbFolder, error: null }),
      }),
    });

    vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
      if (table === 'workspace_folders') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: async () => ({ data: [], error: null }),
              }),
            }),
          }),
          insert: insertMock,
        } as any;
      }
      return {} as any;
    });

    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });

    let created;
    await act(async () => {
      created = await result.current.createFolder({ name: 'Deployment', projectId });
    });

    expect(insertMock).toHaveBeenCalledWith({
      user_id: 'user-alpha',
      project_id: projectId,
      name: 'Deployment',
    });
    expect(created).toEqual({
      id: 'f-new',
      projectId,
      name: 'Deployment',
      createdAt: '2026-09-03T00:00:00Z',
      updatedAt: '2026-09-03T00:00:00Z',
    });
  });

  it('renames a folder via renameFolder mutation', async () => {
    const updateMock = vi.fn().mockReturnValue({
      eq: async () => ({ error: null }),
    });

    vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
      if (table === 'workspace_folders') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: async () => ({ data: [], error: null }),
              }),
            }),
          }),
          update: updateMock,
        } as any;
      }
      return {} as any;
    });

    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });

    await act(async () => {
      await result.current.renameFolder({ id: 'f-1', name: 'Renamed Area' });
    });

    expect(updateMock).toHaveBeenCalledWith({ name: 'Renamed Area' });
  });

  it('deletes a folder via deleteFolder mutation and invalidates related caches', async () => {
    const deleteMock = vi.fn().mockReturnValue({
      eq: async () => ({ error: null }),
    });

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
      if (table === 'workspace_folders') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: async () => ({ data: [], error: null }),
              }),
            }),
          }),
          delete: deleteMock,
        } as any;
      }
      return {} as any;
    });

    const { result } = renderHook(() => useWorkspaceFolders(projectId), { wrapper });

    await act(async () => {
      await result.current.deleteFolder('f-1');
    });

    expect(deleteMock).toHaveBeenCalled();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['workspace_folders', projectId] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['documents'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['system_designs', projectId] });
  });
});
