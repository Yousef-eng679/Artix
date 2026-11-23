import { clearDraft, setDraft } from './draftRecovery';

/**
 * tabCloseGuard.ts
 * ────────────────
 * Flushes unsaved (dirty) document or canvas content synchronously into local
 * user-scoped crash-recovery storage (`localStorage`) when the user closes or
 * reloads the tab.
 *
 * Strictly offline-first (OF-14): NEVER issues network beacon or `fetch`
 * requests to server endpoints, keeping all unsaved drafts local.
 */

export interface TabCloseGuard {
  /** Mark an entity as having unsaved local content. */
  markDirty(entityId: string, content: string): void;
  /** Mark an entity as clean (local Dexie save succeeded). */
  markClean(entityId: string): void;
  /** Flush all dirty entities locally — called from beforeunload handler. */
  handleBeforeUnload(): void;
  /** Tear down — clear in-memory dirty map. */
  destroy(): void;
}

export function createTabCloseGuard(
  onFlushLocal?: ((entityId: string, content: string) => void) | string,
): TabCloseGuard {
  const dirtyDocs = new Map<string, string>();
  const flushCallback = typeof onFlushLocal === 'function' ? onFlushLocal : undefined;

  function markDirty(entityId: string, content: string): void {
    dirtyDocs.set(entityId, content);
  }

  function markClean(entityId: string): void {
    dirtyDocs.delete(entityId);
    clearDraft(entityId);
  }

  function flushOne(entityId: string, content: string): void {
    setDraft(entityId, content);

    if (flushCallback) {
      try {
        flushCallback(entityId, content);
      } catch {
        // Ignore callback errors during unload
      }
    }
  }

  function handleBeforeUnload(): void {
    dirtyDocs.forEach((content, entityId) => {
      flushOne(entityId, content);
    });
  }

  function destroy(): void {
    dirtyDocs.clear();
  }

  return { markDirty, markClean, handleBeforeUnload, destroy };
}
