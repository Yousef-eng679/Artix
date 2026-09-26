import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
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

  it('keeps newly created document in documents query state even after invalidateQueries', async () => {
    const { result } = renderHook(() => useDocuments(projectId), { wrapper });

    let created: any;
    await act(async () => {
      created = await result.current.createDocument({
        projectId,
        title: 'Authoritative Document',
      });
    });

    expect(created.id).toBeDefined();

    // Trigger explicit query refetch/invalidation
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['documents', mockUser.id, projectId] });
    });

    // The documents array must contain the newly created document directly from IndexedDB
    expect(result.current.documents.some((d) => d.id === created.id)).toBe(true);
    expect(result.current.documents.find((d) => d.id === created.id)?.title).toBe('Authoritative Document');
  });

  it('preserves projectId and folderId when updating content only (preventing file detachment on tab switch)', async () => {
    const { result } = renderHook(() => useDocuments(projectId), { wrapper });

    let created: any;
    await act(async () => {
      created = await result.current.createDocument({
        projectId,
        title: 'Project Doc',
        folderId: 'folder-123',
      });
    });

    expect(created.project_id).toBe(projectId);

    // Simulate auto-save or Editor unmount flush sending only { id, content }
    await act(async () => {
      await result.current.updateDocument({
        id: created.id,
        content: 'New content added offline',
      });
    });

    // In IndexedDB, projectId and folderId must NOT have been wiped to undefined!
    const fromDB = await docRepo.getById(created.id);
    expect(fromDB).toBeDefined();
    expect(fromDB?.projectId).toBe(projectId);
    expect(fromDB?.folderId).toBe('folder-123');
    expect(fromDB?.content).toBe('New content added offline');

    // And listByProject must still return it
    const list = await docRepo.listByProject(mockUser.id, projectId);
    expect(list.some((d) => d.id === created.id)).toBe(true);
  });

  it('self-heals orphaned documents missing projectId by restoring them to current project', async () => {
    // Intentionally create an orphaned document with null projectId (as happened in earlier sessions)
    const orphanedDoc = await docRepo.create({
      userId: mockUser.id,
      projectId: null,
      title: 'Previously Orphaned Doc',
      content: 'Important thoughts',
    });

    expect(orphanedDoc.projectId).toBeNull();

    // Now render the hook for this project
    const { result } = renderHook(() => useDocuments(projectId), { wrapper });

    // The orphaned document must be self-healed and now associated with projectId
    await waitFor(async () => {
      const healed = await docRepo.getById(orphanedDoc.id);
      expect(healed?.projectId).toBe(projectId);
    });
  });
});

describe('useAutoSave Unmount Flush Integration', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('flushes pending debounced save synchronously upon unmount (tab switch)', async () => {
    const { useAutoSave } = await import('@/lib/autosave');
    const onSave = vi.fn().mockResolvedValue(undefined);

    const { result, unmount } = renderHook(() =>
      useAutoSave({
        delay: 1500,
        onSave,
        documentId: 'doc-unmount-test',
      })
    );

    act(() => {
      result.current.triggerSave('Critical offline edits before switching tabs');
    });

    // Save should NOT have fired yet because delay is 1500ms
    expect(onSave).not.toHaveBeenCalled();

    // Unmount immediately simulates switching tabs
    act(() => {
      unmount();
    });

    // Await promise microtasks so save queue processes the enqueued save
    await act(async () => {
      await Promise.resolve();
    });

    // flushSync in unmount cleanup must have triggered onSave immediately
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('Critical offline edits before switching tabs');
  });
});
