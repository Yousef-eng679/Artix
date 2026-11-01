import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, RefreshCw } from 'lucide-react';
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
 * Surfaces outbox entries parked in 'blocked' state (excluding conflicts, which have their own
 * resolution workflow) and lets the user retry them once the underlying cause is fixed.
 */
export function SyncStatusBanner() {
  const runtime = useUserSyncRuntime();
  const outboxRepo = runtime?.outboxRepo ?? null;
  const syncEngine = runtime?.syncEngine ?? null;
  // ArtixDB is already user-scoped; runtime.userId narrows further when available.
  const userId = runtime?.runtime?.userId;

  const [blocked, setBlocked] = useState<OutboxEntry[]>([]);
  const [isRetrying, setIsRetrying] = useState(false);

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

  if (blocked.length === 0) return null;

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
        <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isRetrying ? 'animate-spin' : ''}`} aria-hidden="true" />
        Retry
      </Button>
    </div>
  );
}
