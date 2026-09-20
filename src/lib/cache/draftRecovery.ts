/**
 * draftRecovery.ts
 * ────────────────
 * Utilities for crash recovery of uncommitted localStorage drafts (Task §2.3).
 *
 * Provides safe getters, comparators, and clearers for both markdown/text
 * documents and JSON-serialized architecture boards.
 */

export function getDraftKey(id: string): string {
  return `artix.draft.${id}`;
}

export function getDraft(id: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(getDraftKey(id));
  } catch {
    return null;
  }
}

export function clearDraft(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(getDraftKey(id));
  } catch {
    // ignore
  }
}

/**
 * Returns the recovered draft content if it exists, is non-empty, and differs
 * from the loaded server content. If it matches the server content, it cleans up
 * the stale draft and returns null.
 */
export function getRecoverableDraft(id: string, currentContent: string): string | null {
  const draft = getDraft(id);
  if (!draft || draft.trim().length === 0) return null;

  if (draft === currentContent) {
    // Draft already matches server content — clean up silently
    clearDraft(id);
    return null;
  }

  return draft;
}

/**
 * Parses and returns a recovered BoardState draft if it exists, is valid JSON,
 * has valid nodes/edges arrays, and differs from the loaded server board state.
 */
export function getRecoverableBoardDraft<T = unknown>(id: string, currentBoardState: T): T | null {
  const draft = getDraft(id);
  if (!draft || draft.trim().length === 0) return null;

  try {
    const parsed = JSON.parse(draft) as T;
    if (parsed && typeof parsed === 'object' && 'nodes' in parsed && 'edges' in parsed) {
      const currentJson = JSON.stringify(currentBoardState);
      const draftJson = JSON.stringify(parsed);

      if (draftJson === currentJson) {
        clearDraft(id);
        return null;
      }

      return parsed;
    }
  } catch {
    // Corrupted JSON draft — ignore
  }

  return null;
}
