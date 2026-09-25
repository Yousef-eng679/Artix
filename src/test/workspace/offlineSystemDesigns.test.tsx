import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSystemDesigns } from '@/hooks/useSystemDesigns';
import { deleteArtixDB } from '@/lib/local/db';
import { SystemDesignRepository } from '@/lib/repositories/systemDesignRepository';

const mockUser = { id: 'user-offline-2', email: 'offline2@artix.dev' };

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

describe('Offline-First useSystemDesigns Hook Integration', () => {
  let queryClient: QueryClient;
  let designRepo: SystemDesignRepository;
  const projectId = 'proj-offline-beta';

  beforeEach(async () => {
    await deleteArtixDB();
    designRepo = new SystemDesignRepository();
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

  it('creates and updates complex canvas boardState offline', async () => {
    const { result } = renderHook(() => useSystemDesigns(projectId), { wrapper });

    let created: any;
    await act(async () => {
      created = await result.current.createDesign({
        name: 'Offline Infrastructure',
        projectId,
      });
    });

    expect(created).toBeDefined();
    expect(created.name).toBe('Offline Infrastructure');

    // Update with canvas nodes and edges
    const newBoard = {
      nodes: [
        { id: 'n1', type: 'k8s', position: { x: 50, y: 50 }, data: { label: 'Cluster' } },
      ],
      edges: [],
    };

    await act(async () => {
      await result.current.updateDesign({
        id: created.id,
        board_state: newBoard,
      });
    });

    // Check IndexedDB persistence
    const local = await designRepo.getById(created.id);
    expect(local).toBeDefined();
    expect(local?.boardState.nodes).toHaveLength(1);
    expect(local?.boardState.nodes[0].data.label).toBe('Cluster');
    expect(local?.localRevision).toBe(2);
  });
});
