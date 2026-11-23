import { clearDraft, setDraft } from './draftRecovery';

/**
 * debouncedSave.ts
 * ────────────────
 * Two-tier debounced saver for the Artix caching strategy.
 *
 * Tier 1 — Immediately writes the latest content to localStorage as a user-scoped
 *          draft cache (`artix.draft.{userHash}.{docId}`) so content survives tab crashes.
 * Tier 2 — Fires the real DB save callback only after `delay` ms of
 *          inactivity, deduplicating rapid keystrokes into a single write.
 *
 * Framework-agnostic (no React imports) — composed into hooks upstream.
 */

export interface DebouncedSaver {
  /** Queue a save. Resets the debounce timer on each call. */
  save(content: string): void;
  /** Returns true if a debounced save is still waiting to fire. */
  hasPending(): boolean;
  /** Force-fires the pending save immediately (synchronous trigger). */
  flushSync(): void;
  /** Cancel any pending debounced save without firing it. */
  cancel(): void;
}

export function createDebouncedSaver(
  saveFn: (content: string) => Promise<void>,
  delay: number,
  documentId?: string,
): DebouncedSaver {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let pendingContent: string | null = null;
  let lastSavedContent: string | null = null;

  function writeDraftToLocalStorage(content: string): void {
    if (documentId) {
      setDraft(documentId, content);
    }
  }

  function clearDraftFromLocalStorage(): void {
    if (documentId) {
      clearDraft(documentId);
    }
  }

  function executeSave(content: string): void {
    lastSavedContent = content;
    pendingContent = null;
    timerId = null;
    saveFn(content)
      .then(() => {
        clearDraftFromLocalStorage();
      })
      .catch(() => {
        // Save failed — draft stays in localStorage for crash recovery
      });
  }

  function save(content: string): void {
    // Skip if content hasn't changed since last successful save
    if (content === lastSavedContent) {
      return;
    }

    // Tier 1: Immediately cache to localStorage
    writeDraftToLocalStorage(content);

    // Tier 2: Debounce the DB save
    pendingContent = content;
    if (timerId !== null) {
      clearTimeout(timerId);
    }
    timerId = setTimeout(() => {
      if (pendingContent !== null) {
        executeSave(pendingContent);
      }
    }, delay);
  }

  function hasPending(): boolean {
    return pendingContent !== null && timerId !== null;
  }

  function flushSync(): void {
    if (timerId !== null) {
      clearTimeout(timerId);
    }
    if (pendingContent !== null) {
      executeSave(pendingContent);
    }
  }

  function cancel(): void {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    pendingContent = null;
  }

  return { save, hasPending, flushSync, cancel };
}
