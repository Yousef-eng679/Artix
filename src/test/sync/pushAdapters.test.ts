import { describe, it, expect, vi } from 'vitest';
import { getPushAdapter, WorkspaceFolderPushAdapter, DocumentPushAdapter, SystemDesignPushAdapter } from '@/lib/sync/adapters';
import { OutboxEntry } from '@/lib/local/types';

describe('Phase 4: Structured Push Adapters', () => {
  it('registers and retrieves the correct adapter per entity type', () => {
    expect(getPushAdapter('workspace_folder')).toBeInstanceOf(WorkspaceFolderPushAdapter);
    expect(getPushAdapter('document')).toBeInstanceOf(DocumentPushAdapter);
    expect(getPushAdapter('system_design')).toBeInstanceOf(SystemDesignPushAdapter);
  });

  it('WorkspaceFolderPushAdapter pushes create, update, and delete operations', async () => {
    const adapter = new WorkspaceFolderPushAdapter();

    const mockUpsert = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: { updated_at: '2026-09-28T00:00:00Z' }, error: null }) }),
    });
    const mockUpdate = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { updated_at: '2026-09-28T01:00:00Z' }, error: null }) }) }),
    });
    const mockDelete = vi.fn().mockReturnValue({
      eq: () => Promise.resolve({ error: null }),
    });

    const mockSupabase = {
      from: (table: string) => {
        expect(table).toBe('workspace_folders');
        return {
          upsert: mockUpsert,
          update: mockUpdate,
          delete: mockDelete,
        };
      },
    };

    const createEntry: OutboxEntry = {
      id: 'm1',
      userId: 'u1',
      projectId: 'p1',
      entityType: 'workspace_folder',
      entityId: 'f1',
      operation: 'create',
      payload: { name: 'Folder A', parentFolderId: null },
      localRevision: 1,
      baseServerVersion: null,
      state: 'in_flight',
      attemptCount: 0,
      createdAt: 100,
      updatedAt: 100,
    };

    const createRes = await adapter.push(createEntry, mockSupabase);
    expect(createRes?.updated_at).toBe('2026-09-28T00:00:00Z');
    expect(mockUpsert).toHaveBeenCalled();

    const updateEntry: OutboxEntry = {
      ...createEntry,
      operation: 'update',
      payload: { name: 'Folder Renamed' },
    };
    const updateRes = await adapter.push(updateEntry, mockSupabase);
    expect(updateRes?.updated_at).toBe('2026-09-28T01:00:00Z');
    expect(mockUpdate).toHaveBeenCalled();

    const deleteEntry: OutboxEntry = {
      ...createEntry,
      operation: 'delete',
      payload: null,
    };
    const deleteRes = await adapter.push(deleteEntry, mockSupabase);
    expect(deleteRes).toBeNull();
    expect(mockDelete).toHaveBeenCalled();
  });

  it('DocumentPushAdapter pushes document mutations to documents table', async () => {
    const adapter = new DocumentPushAdapter();

    const mockUpsert = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: { updated_at: '2026-09-28T02:00:00Z' }, error: null }) }),
    });

    const mockSupabase = {
      from: (table: string) => {
        expect(table).toBe('documents');
        return { upsert: mockUpsert };
      },
    };

    const docEntry: OutboxEntry = {
      id: 'm-doc',
      userId: 'u1',
      projectId: 'p1',
      entityType: 'document',
      entityId: 'doc-123',
      operation: 'create',
      payload: { title: 'Doc Title', content: 'Doc body', format: 'markdown', folderId: 'f1' },
      localRevision: 1,
      baseServerVersion: null,
      state: 'in_flight',
      attemptCount: 0,
      createdAt: 100,
      updatedAt: 100,
    };

    const res = await adapter.push(docEntry, mockSupabase);
    expect(res?.updated_at).toBe('2026-09-28T02:00:00Z');
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'doc-123',
        folder_id: 'f1',
        title: 'Doc Title',
      })
    );
  });
});
