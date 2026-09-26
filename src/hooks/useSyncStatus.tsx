import { useEffect, useState, useCallback } from 'react';
import { getSyncEngine, SyncStatus } from '@/lib/sync/syncEngine';
import { useAuth } from './useAuth';

export interface UseSyncStatusReturn {
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  lastSyncedAt: Date | null;
  error: { code: string; message: string } | null;
  triggerSync: () => Promise<void>;
}

export function useSyncStatus(): UseSyncStatusReturn {
  const { user } = useAuth();
  const engine = getSyncEngine();

  const [status, setStatus] = useState<SyncStatus>(() => engine.getStatus());
  const [pendingCount, setPendingCount] = useState<number>(0);

  const refreshPendingCount = useCallback(async () => {
    try {
      const fullStatus = await engine.getStatusWithPending(user?.id);
      setPendingCount(fullStatus.pendingCount);
    } catch {
      // Ignore background count errors
    }
  }, [engine, user?.id]);

  useEffect(() => {
    // Initial fetch of pending count
    refreshPendingCount();

    const unsubscribe = engine.subscribe((newStatus) => {
      setStatus(newStatus);
      refreshPendingCount();
    });

    return () => {
      unsubscribe();
    };
  }, [engine, refreshPendingCount]);

  const triggerSync = useCallback(async () => {
    await engine.triggerSync(user?.id);
    await refreshPendingCount();
  }, [engine, user?.id, refreshPendingCount]);

  return {
    isOnline: status.isOnline,
    isSyncing: status.state === 'syncing',
    pendingCount,
    lastSyncedAt: status.lastSyncedAt,
    error: status.error ?? null,
    triggerSync,
  };
}
