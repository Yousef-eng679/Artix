import React, { createContext, useContext, useEffect, useState, useMemo, useRef, ReactNode } from 'react';
import { liveQuery } from 'dexie';
import { QueryClientContext } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import {
  UserSyncRuntime,
  openUserRuntime,
  closeUserRuntime,
  getActiveUserRuntime,
  RuntimeStatus,
  RuntimeError,
} from '@/lib/sync/userSyncRuntime';
import { ProjectRepository } from '@/lib/repositories/projectRepository';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { WorkspaceFolderRepository } from '@/lib/repositories/folderRepository';
import { SystemDesignRepository } from '@/lib/repositories/systemDesignRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncEngine } from '@/lib/sync/syncEngine';
import { TabCoordinator } from '@/lib/sync/tabCoordinator';
import { RealtimeSyncManager } from '@/lib/sync/realtimeSync';
import { ArtixDB, setActiveUserScope } from '@/lib/local/db';
import { dirtyTracker } from '@/lib/workspace/dirtyTracker';

export interface UserSyncRuntimeContextType {
  runtime: UserSyncRuntime | null;
  db: ArtixDB | null;
  projectRepo: ProjectRepository | null;
  documentRepo: DocumentRepository | null;
  folderRepo: WorkspaceFolderRepository | null;
  systemDesignRepo: SystemDesignRepository | null;
  outboxRepo: OutboxRepository | null;
  syncEngine: SyncEngine | null;
  tabCoordinator: TabCoordinator | null;
  realtimeSync: RealtimeSyncManager | null;
  isReady: boolean;
  isHydrated: boolean;
  runtimeStatus: RuntimeStatus | null;
  isDegraded: boolean;
  runtimeError: RuntimeError | null;
}

export const UserSyncRuntimeContext = createContext<UserSyncRuntimeContextType | null>(null);

export function UserSyncRuntimeProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const queryClient = useContext(QueryClientContext);
  const { user, loading: authLoading } = auth;
  const shouldPauseCloudSync = Boolean(auth.isOfflineSession || auth.reauthRequired);
  const shouldPauseCloudSyncRef = useRef(shouldPauseCloudSync);
  shouldPauseCloudSyncRef.current = shouldPauseCloudSync;
  const prevUserIdRef = useRef<string | null>(null);

  const [runtime, setRuntime] = useState<UserSyncRuntime | null>(() => getActiveUserRuntime() ?? null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(() => getActiveUserRuntime()?.getStatus() ?? null);
  const [dbHydrated, setDbHydrated] = useState<boolean>(false);
  const [openError, setOpenError] = useState<RuntimeError | null>(null);
  const [isReady, setIsReady] = useState<boolean>(false);

  useEffect(() => {
    let isCancelled = false;

    if (authLoading) return;

    const nextUserId = user?.id ?? null;
    if (prevUserIdRef.current !== null && prevUserIdRef.current !== nextUserId) {
      queryClient?.clear();
      dirtyTracker.clear();
    }
    prevUserIdRef.current = nextUserId;

    if (!nextUserId) {
      setActiveUserScope(null);
      closeUserRuntime().then(() => {
        if (!isCancelled) {
          setRuntime(null);
          setRuntimeStatus(null);
          setOpenError(null);
          setIsReady(true);
        }
      });
      return () => {
        isCancelled = true;
      };
    }

    setActiveUserScope(nextUserId);
    setIsReady(false);
    setOpenError(null);
    const openPromise = shouldPauseCloudSyncRef.current
      ? openUserRuntime(nextUserId, { cloudSyncPaused: true })
      : openUserRuntime(nextUserId);

    openPromise
      .then((active) => {
        if (!isCancelled) {
          if (typeof active?.setCloudSyncPaused === 'function') {
            active.setCloudSyncPaused(shouldPauseCloudSyncRef.current);
          }
          setOpenError(null);
          setRuntime(active);
          setRuntimeStatus(active.getStatus());
          setIsReady(true);
        }
      })
      .catch((err) => {
        console.error('[UserSyncRuntimeProvider] Failed to open runtime:', err);
        if (!isCancelled) {
          const structuredError: RuntimeError =
            err && typeof err === 'object' && 'code' in err && 'fatal' in err
              ? (err as RuntimeError)
              : {
                  code: 'UNKNOWN',
                  message:
                    err instanceof Error
                      ? err.message
                      : 'Failed to initialize user sync runtime',
                  fatal: true,
                  originalError: err,
                };
          setRuntime(null);
          setRuntimeStatus(null);
          setOpenError(structuredError);
          setIsReady(true);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [user?.id, authLoading, queryClient]);

  // Dynamically pause/resume cloud sync when offline session refreshes online
  useEffect(() => {
    if (runtime && typeof runtime.setCloudSyncPaused === 'function') {
      runtime.setCloudSyncPaused(shouldPauseCloudSync);
    }
  }, [runtime, shouldPauseCloudSync]);

  // Subscribe to live status & database_meta hydration changes on the active runtime
  useEffect(() => {
    if (!runtime) {
      setRuntimeStatus(null);
      setDbHydrated(false);
      return;
    }

    setDbHydrated(Boolean(runtime.getStatus().isHydrated));

    const unsub = runtime.subscribeStatus((status) => {
      setRuntimeStatus(status);
      if (status.isHydrated) {
        setDbHydrated(true);
      }
    });

    const hydrationSub = liveQuery(async () => {
      if (!runtime.db.isOpen()) return false;
      const meta = await runtime.db.database_meta.get('hydration_complete');
      return Boolean(meta?.value);
    }).subscribe({
      next: (hydrated) => {
        setDbHydrated(Boolean(hydrated));
      },
      error: () => {
        // Ignore transient closed-DB errors on teardown
      },
    });

    return () => {
      unsub();
      hydrationSub.unsubscribe();
    };
  }, [runtime]);

  const isHydrated = Boolean(runtimeStatus?.isHydrated || dbHydrated);

  const value = useMemo<UserSyncRuntimeContextType>(() => {
    if (!runtime) {
      return {
        runtime: null,
        db: null,
        projectRepo: null,
        documentRepo: null,
        folderRepo: null,
        systemDesignRepo: null,
        outboxRepo: null,
        syncEngine: null,
        tabCoordinator: null,
        realtimeSync: null,
        isReady,
        isHydrated: false,
        runtimeStatus: null,
        isDegraded: openError !== null,
        runtimeError: openError,
      };
    }

    return {
      runtime,
      db: runtime.db,
      projectRepo: runtime.projectRepo,
      documentRepo: runtime.documentRepo,
      folderRepo: runtime.folderRepo,
      systemDesignRepo: runtime.systemDesignRepo,
      outboxRepo: runtime.outboxRepo,
      syncEngine: runtime.syncEngine,
      tabCoordinator: runtime.tabCoordinator,
      realtimeSync: runtime.realtimeSync,
      isReady,
      isHydrated,
      runtimeStatus,
      isDegraded: Boolean(runtimeStatus?.isDegraded || runtimeStatus?.state === 'errored'),
      runtimeError: runtimeStatus?.error ?? openError,
    };
  }, [runtime, isReady, isHydrated, runtimeStatus, openError]);

  return (
    <UserSyncRuntimeContext.Provider value={value}>
      {children}
    </UserSyncRuntimeContext.Provider>
  );
}

export function useUserSyncRuntime(): UserSyncRuntimeContextType | null {
  return useContext(UserSyncRuntimeContext);
}
