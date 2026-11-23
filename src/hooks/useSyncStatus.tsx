import { useEffect, useState, useCallback, useMemo } from 'react';
import { getSyncEngine, SyncStatus } from '@/lib/sync/syncEngine';
import { getTabCoordinator } from '@/lib/sync/tabCoordinator';
import { useAuth } from './useAuth';
import { useUserSyncRuntime } from '@/contexts/UserSyncRuntimeContext';

export interface UseSyncStatusReturn {
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  blockedCount: number;
  lastSyncedAt: Date | null;
  error: { code: string; message: string } | null;
  triggerSync: () => Promise<void>;
  retryBlocked: () => Promise<number>;
}

export function useSyncStatus(): UseSyncStatusReturn {
  const { user } = useAuth();
  const runtimeContext = useUserSyncRuntime();
  const engine = useMemo(
    () => runtimeContext?.syncEngine || getSyncEngine(user?.id),
    [runtimeContext?.syncEngine, user?.id]
  );
  const coordinator = useMemo(
    () => runtimeContext?.tabCoordinator || getTabCoordinator(user?.id),
    [runtimeContext?.tabCoordinator, user?.id]
  );

  const [status, setStatus] = useState<SyncStatus>(() => engine.getStatus());
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [blockedCount, setBlockedCount] = useState<number>(0);

  const refreshPendingCount = useCallback(async () => {
    try {
      const fullStatus = await engine.getStatusWithPending(user?.id);
      setPendingCount(fullStatus.pendingCount);
      setBlockedCount(fullStatus.blockedCount ?? 0);
    } catch {
      // Ignore background count errors
    }
  }, [engine, user?.id]);

  useEffect(() => {
    // Initial fetch of pending count
    refreshPendingCount();

    const unsubscribeEngine = engine.subscribe((newStatus) => {
      setStatus(newStatus);
      refreshPendingCount();
    });

    const unsubscribeCoordinator = coordinator.onCrossTabChange(() => {
      refreshPendingCount();
    });

    return () => {
      unsubscribeEngine();
      unsubscribeCoordinator();
    };
  }, [engine, coordinator, refreshPendingCount]);

  const triggerSync = useCallback(async () => {
    await engine.triggerSync(user?.id);
    await refreshPendingCount();
  }, [engine, user?.id, refreshPendingCount]);

  const retryBlocked = useCallback(async () => {
    const count = await engine.retryBlocked(user?.id);
    await refreshPendingCount();
    return count;
  }, [engine, user?.id, refreshPendingCount]);

  return {
    isOnline: status.isOnline,
    isSyncing: status.state === 'syncing',
    pendingCount,
    blockedCount,
    lastSyncedAt: status.lastSyncedAt,
    error: status.error ?? null,
    triggerSync,
    retryBlocked,
  };
}
