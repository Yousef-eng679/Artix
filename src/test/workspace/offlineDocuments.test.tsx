import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useDocuments } from '@/hooks/useDocuments';
import { deleteArtixDB } from '@/lib/local/db';
import { DocumentRepository } from '@/lib/repositories/documentRepository';

const mockUser = { id: 'user-offline-1', email: 'offline@artix.dev' };

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}));

// Mock Supabase to simulate offline state
vi.mock('@/integrations/supabase/client', () => {
  const offlineError = { message: 'Failed to fetch (offline network)', code: 'PGRST000' };
  const mockBuilder: any = {
    select: vi.fn(() => mockBuilder),
    eq: vi.fn(() => mockBuilder),
    is: vi.fn(() => mockBuilder),
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

describe('Offline-First useDocuments Hook Integration', () => {
  let queryClient: QueryClient;
  let docRepo: DocumentRepository;
  const projectId = 'proj-offline-alpha';

  beforeEach(async () => {
    await deleteArtixDB();
    docRepo = new DocumentRepository();
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

  it('creates and persists a document to IndexedDB even when network is completely down', async () => {
    const { result } = renderHook(() => useDocuments(projectId), { wrapper });

    let createdDoc: any;
    await act(async () => {
      createdDoc = await result.current.createDocument({
        projectId,
        title: 'Offline Notes',
      });
    });

    expect(createdDoc).toBeDefined();
    expect(createdDoc.title).toBe('Offline Notes');
    expect(createdDoc.id).toBeDefined();

    // Verify it was persisted to IndexedDB directly
    const local = await docRepo.getById(createdDoc.id);
    expect(local).toBeDefined();
    expect(local?.title).toBe('Offline Notes');
    expect(local?.localRevision).toBe(1);
  });

  it('updates document content offline without failing', async () => {
    const { result } = renderHook(() => useDocuments(projectId), { wrapper });

    let created: any;
    await act(async () => {
      created = await result.current.createDocument({
        projectId,
        title: 'Flight Specs',
      });
    });

    await act(async () => {
      const res = await result.current.updateDocument({
        id: created.id,
        content: '# Offline changes\nWritten while disconnected.',
      });
      expect(res.updated_at).toBeDefined();
    });

    const local = await docRepo.getById(created.id);
    expect(local?.content).toBe('# Offline changes\nWritten while disconnected.');
    expect(local?.localRevision).toBe(2);
  });

  it('soft-deletes document offline and excludes it from queries', async () => {
    const { result } = renderHook(() => useDocuments(projectId), { wrapper });

    let created: any;
    await act(async () => {
      created = await result.current.createDocument({
        projectId,
        title: 'Delete Offline',
      });
    });

    await act(async () => {
      await result.current.deleteDocument(created.id);
    });

    // Should no longer be visible via getById
    const local = await docRepo.getById(created.id);
    expect(local).toBeNull();

    // But exists as soft-deleted in IndexedDB
    const raw = await docRepo.getByIdIncludeDeleted(created.id);
    expect(raw?.isDeleted).toBe(true);
  });
});
