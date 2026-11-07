import { useSyncExternalStore } from 'react';
import { ResourceKind } from '@/types/workspace';
import { getDraft } from '@/lib/cache/draftRecovery';
import { getActiveUserScope, getUserScopeHash } from '@/lib/local/db';

type Listener = () => void;

function getScopedDirtyKey(resourceId: string): string {
  const scope = getActiveUserScope()?.trim();
  if (scope) {
    return `${getUserScopeHash(scope)}:${resourceId}`;
  }
  return resourceId;
}

class DirtyTracker {
  private dirtyIds = new Set<string>();
  private listeners = new Set<Listener>();

  markDirty(resourceId: string): void {
    if (!resourceId) return;
    const key = getScopedDirtyKey(resourceId);
    if (!this.dirtyIds.has(key)) {
      this.dirtyIds.add(key);
      this.notify();
    }
  }

  markClean(resourceId: string): void {
    if (!resourceId) return;
    const key = getScopedDirtyKey(resourceId);
    if (this.dirtyIds.has(key)) {
      this.dirtyIds.delete(key);
      this.notify();
    }
  }

  isDirty(resourceId: string, kind?: ResourceKind): boolean {
    if (!resourceId) return false;
    const key = getScopedDirtyKey(resourceId);
    if (this.dirtyIds.has(key)) {
      return true;
    }
    // Check user-scoped localStorage draft
    if (kind === 'design') {
      const draft = getDraft(`design-${resourceId}`);
      return Boolean(draft && draft.trim().length > 0);
    }
    const docDraft = getDraft(resourceId);
    if (docDraft && docDraft.trim().length > 0) {
      return true;
    }
    if (!kind) {
      const designDraft = getDraft(`design-${resourceId}`);
      return Boolean(designDraft && designDraft.trim().length > 0);
    }
    return false;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): string {
    return Array.from(this.dirtyIds).sort().join(',');
  }

  clear(): void {
    this.dirtyIds.clear();
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach((l) => {
      try {
        l();
      } catch (err) {
        console.error('[dirtyTracker] Listener error:', err);
      }
    });
  }
}

export const dirtyTracker = new DirtyTracker();

/**
 * Hook to reactively subscribe to a specific resource's dirty state.
 */
export function useIsResourceDirty(resourceId: string, kind?: ResourceKind): boolean {
  return useSyncExternalStore(
    (onStoreChange) => dirtyTracker.subscribe(onStoreChange),
    () => dirtyTracker.isDirty(resourceId, kind),
    () => false,
  );
}
