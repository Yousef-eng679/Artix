import React, { createContext, useContext, useEffect, useState, useMemo, ReactNode } from 'react';
import { useAuth } from '@/hooks/useAuth';
import {
  UserSyncRuntime,
  openUserRuntime,
  closeUserRuntime,
  getActiveUserRuntime,
  RuntimeStatus,
  RuntimeError,
} from '@/lib/sync/userSyncRuntime';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { WorkspaceFolderRepository } from '@/lib/repositories/folderRepository';
import { SystemDesignRepository } from '@/lib/repositories/systemDesignRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncEngine } from '@/lib/sync/syncEngine';
import { TabCoordinator } from '@/lib/sync/tabCoordinator';
import { RealtimeSyncManager } from '@/lib/sync/realtimeSync';
import { ArtixDB } from '@/lib/local/db';

export interface UserSyncRuntimeContextType {
  runtime: UserSyncRuntime | null;
  db: ArtixDB | null;
  documentRepo: DocumentRepository | null;
  folderRepo: WorkspaceFolderRepository | null;
  systemDesignRepo: SystemDesignRepository | null;
  outboxRepo: OutboxRepository | null;
  syncEngine: SyncEngine | null;
  tabCoordinator: TabCoordinator | null;
  realtimeSync: RealtimeSyncManager | null;
  isReady: boolean;
  runtimeStatus: RuntimeStatus | null;
  isDegraded: boolean;
  runtimeError: RuntimeError | null;
}

const UserSyncRuntimeContext = createContext<UserSyncRuntimeContextType | null>(null);

export function UserSyncRuntimeProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [runtime, setRuntime] = useState<UserSyncRuntime | null>(() => getActiveUserRuntime() ?? null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(() => getActiveUserRuntime()?.getStatus() ?? null);
  const [isReady, setIsReady] = useState<boolean>(false);

  useEffect(() => {
    let isCancelled = false;

    if (authLoading) return;

    if (!user?.id) {
      closeUserRuntime().then(() => {
        if (!isCancelled) {
          setRuntime(null);
          setRuntimeStatus(null);
          setIsReady(true);
        }
      });
      return () => {
        isCancelled = true;
      };
    }

    setIsReady(false);
    openUserRuntime(user.id)
      .then((active) => {
        if (!isCancelled) {
          setRuntime(active);
          setRuntimeStatus(active.getStatus());
          setIsReady(true);
        }
      })
      .catch((err) => {
        console.error('[UserSyncRuntimeProvider] Failed to open runtime:', err);
        if (!isCancelled) {
          setIsReady(true);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [user?.id, authLoading]);

  // Subscribe to live status changes on the active runtime
  useEffect(() => {
    if (!runtime) {
      setRuntimeStatus(null);
      return;
    }

    const unsub = runtime.subscribeStatus((status) => {
      setRuntimeStatus(status);
    });

    return () => {
      unsub();
    };
  }, [runtime]);

  const value = useMemo<UserSyncRuntimeContextType>(() => {
    if (!runtime) {
      return {
        runtime: null,
        db: null,
        documentRepo: null,
        folderRepo: null,
        systemDesignRepo: null,
        outboxRepo: null,
        syncEngine: null,
        tabCoordinator: null,
        realtimeSync: null,
        isReady,
        runtimeStatus: null,
        isDegraded: false,
        runtimeError: null,
      };
    }

    return {
      runtime,
      db: runtime.db,
      documentRepo: runtime.documentRepo,
      folderRepo: runtime.folderRepo,
      systemDesignRepo: runtime.systemDesignRepo,
      outboxRepo: runtime.outboxRepo,
      syncEngine: runtime.syncEngine,
      tabCoordinator: runtime.tabCoordinator,
      realtimeSync: runtime.realtimeSync,
      isReady,
      runtimeStatus,
      isDegraded: runtimeStatus?.isDegraded ?? false,
      runtimeError: runtimeStatus?.error ?? null,
    };
  }, [runtime, isReady, runtimeStatus]);

  return (
    <UserSyncRuntimeContext.Provider value={value}>
      {children}
    </UserSyncRuntimeContext.Provider>
  );
}

export function useUserSyncRuntime(): UserSyncRuntimeContextType | null {
  return useContext(UserSyncRuntimeContext);
}
