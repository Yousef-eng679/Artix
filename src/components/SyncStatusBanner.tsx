import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CloudOff, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUserSyncRuntime } from '@/contexts/UserSyncRuntimeContext';
import type { OutboxEntry } from '@/lib/local/types';

function describeBlocked(entries: OutboxEntry[]): { text: string; showUpgrade: boolean } {
  const count = entries.length;
  const noun = count === 1 ? 'change' : 'changes';
  const codes = new Set(entries.map((e) => e.lastError?.code));

  if (codes.has('TIER_LIMIT_EXCEEDED')) {
    return {
      text: `Plan limit reached — ${count} ${noun} saved on this device but not synced. Upgrade or remove items, then retry.`,
      showUpgrade: true,
    };
  }
  if (codes.has('STORAGE_QUOTA')) {
    return {
      text: `Browser storage is full — ${count} ${noun} could not be processed. Free up space, then retry.`,
      showUpgrade: false,
    };
  }
  return {
    text: `${count} ${noun} could not be synced and are paused. Your work is saved on this device.`,
    showUpgrade: false,
  };
}

/**
 * Surfaces:
 *  1. An explicit unhydrated-offline notice when a brand-new browser profile opens offline
 *     before initial workspace hydration (`TASK-27` / Cold-Start Matrix Case 3).
 *  2. Outbox entries parked in `'blocked'` state (excluding conflicts, which have their own
 *     `ConflictResolutionCenter` modal) with a one-click Retry action (`TASK-18`).
 */
export function SyncStatusBanner() {
  const runtime = useUserSyncRuntime();
  const outboxRepo = runtime?.outboxRepo ?? null;
  const syncEngine = runtime?.syncEngine ?? null;
  const userId = runtime?.runtime?.userId;

  const [blocked, setBlocked] = useState<OutboxEntry[]>([]);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const syncNetworkState = () => {
      setIsOnline(typeof navigator !== 'undefined' ? navigator.onLine !== false : true);
    };
    window.addEventListener('online', syncNetworkState);
    window.addEventListener('offline', syncNetworkState);
    return () => {
      window.removeEventListener('online', syncNetworkState);
      window.removeEventListener('offline', syncNetworkState);
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!outboxRepo || typeof outboxRepo.getBlocked !== 'function') {
      setBlocked([]);
      return;
    }
    try {
      const entries = await outboxRepo.getBlocked(userId);
      setBlocked(entries.filter((e) => e.lastError?.code !== 'CONFLICT'));
    } catch {
      // Non-critical UI refresh; ignore transient Dexie errors
    }
  }, [outboxRepo, userId]);

  useEffect(() => {
    refresh();
    if (!syncEngine) return;
    return syncEngine.subscribe(() => {
      refresh();
    });
  }, [syncEngine, refresh]);

  const handleRetry = useCallback(async () => {
    if (!syncEngine) return;
    const targetUserId = userId ?? blocked[0]?.userId;
    if (!targetUserId) return;
    setIsRetrying(true);
    try {
      await syncEngine.retryBlocked(targetUserId);
    } finally {
      setIsRetrying(false);
      await refresh();
    }
  }, [syncEngine, userId, blocked, refresh]);

  const showUnhydratedOffline = Boolean(
    runtime?.isReady && runtime.isHydrated === false && !isOnline,
  );

  if (!showUnhydratedOffline && blocked.length === 0) {
    return null;
  }

  return (
    <>
      {showUnhydratedOffline && (
        <div
          role="status"
          data-testid="unhydrated-offline-banner"
          className="flex items-center gap-3 px-4 py-2 text-sm border-b border-sky-500/30 bg-sky-500/10 text-sky-950 dark:text-sky-200"
        >
          <CloudOff className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-0">
            Workspace not yet downloaded for offline use — connect once to sync.
          </span>
        </div>
      )}
      {blocked.length > 0 && (() => {
        const { text, showUpgrade } = describeBlocked(blocked);
        return (
          <div
            role="alert"
            data-testid="sync-blocked-banner"
            className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm border-b border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="flex-1 min-w-0">{text}</span>
            {showUpgrade && (
              <Button asChild size="sm" variant="outline">
                <Link to="/pricing">Upgrade</Link>
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              onClick={handleRetry}
              disabled={isRetrying}
              data-testid="retry-blocked-sync-btn"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 mr-1.5 ${isRetrying ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              Retry
            </Button>
          </div>
        );
      })()}
    </>
  );
}
