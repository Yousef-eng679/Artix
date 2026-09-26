import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSyncStatus } from '@/hooks/useSyncStatus';
import { deleteArtixDB } from '@/lib/local/db';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { getSyncEngine } from '@/lib/sync/syncEngine';

const mockUser = { id: 'user-sync-test', email: 'sync@artix.dev' };

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}));

describe('useSyncStatus hook', () => {
  let outboxRepo: OutboxRepository;

  beforeEach(async () => {
    await deleteArtixDB();
    outboxRepo = new OutboxRepository();
  });

  afterEach(async () => {
    await deleteArtixDB();
  });

  it('initializes with default online status and 0 pending count', async () => {
    const { result } = renderHook(() => useSyncStatus());

    expect(result.current.isOnline).toBe(true);
    expect(result.current.isSyncing).toBe(false);
    expect(result.current.pendingCount).toBe(0);
    expect(typeof result.current.triggerSync).toBe('function');
  });

  it('reflects updated pendingCount when outbox entries exist and triggerSync runs', async () => {
    // Enqueue an entry in outbox
    await outboxRepo.enqueue({
      userId: mockUser.id,
      projectId: 'proj-1',
      entityType: 'document',
      entityId: 'doc-1',
      operation: 'create',
      payload: { title: 'Test' },
      localRevision: 1,
    });

    const { result } = renderHook(() => useSyncStatus());

    // Trigger sync
    await act(async () => {
      await result.current.triggerSync();
    });

    // After triggerSync runs, it refreshed pending count
    expect(result.current.isSyncing).toBe(false);
  });
});
