import { getActiveUserScope, getUserScopeHash } from '@/lib/local/db';

/**
 * draftRecovery.ts
 * ────────────────
 * Utilities for crash recovery of uncommitted localStorage drafts (Task §2.3).
 *
 * Provides user-scoped getters, setters, comparators, and clearers for both
 * markdown/text documents and JSON-serialized architecture boards (OF-12 / OF-14).
 */

export function getDraftKey(id: string, userId?: string | null): string {
  const scopeUser = (userId !== undefined ? userId : getActiveUserScope())?.trim();
  if (scopeUser) {
    return `artix.draft.${getUserScopeHash(scopeUser)}.${id}`;
  }
  return `artix.draft.${id}`;
}

export function setDraft(id: string, content: string, userId?: string | null): void {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(getDraftKey(id, userId), content);
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

export function getDraft(id: string, userId?: string | null): string | null {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(getDraftKey(id, userId));
  } catch {
    return null;
  }
}

export function clearDraft(id: string, userId?: string | null): void {
  if (typeof window === 'undefined' && typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(getDraftKey(id, userId));
  } catch {
    // ignore
  }
}

/**
 * Returns the recovered draft content if it exists, is non-empty, and differs
 * from the loaded server content. If it matches the server content, it cleans up
 * the stale draft and returns null.
 */
export function getRecoverableDraft(
  id: string,
  currentContent: string,
  userId?: string | null,
): string | null {
  const draft = getDraft(id, userId);
  if (!draft || draft.trim().length === 0) return null;

  if (draft === currentContent) {
    // Draft already matches server content — clean up silently
    clearDraft(id, userId);
    return null;
  }

  return draft;
}

/**
 * Parses and returns a recovered BoardState draft if it exists, is valid JSON,
 * has valid nodes/edges arrays, and differs from the loaded server board state.
 */
export function getRecoverableBoardDraft<T = unknown>(
  id: string,
  currentBoardState: T,
  userId?: string | null,
): T | null {
  const draft = getDraft(id, userId);
  if (!draft || draft.trim().length === 0) return null;

  try {
    const parsed = JSON.parse(draft) as T;
    if (parsed && typeof parsed === 'object' && 'nodes' in parsed && 'edges' in parsed) {
      const currentJson = JSON.stringify(currentBoardState);
      const draftJson = JSON.stringify(parsed);

      if (draftJson === currentJson) {
        clearDraft(id, userId);
        return null;
      }

      return parsed;
    }
  } catch {
    // Corrupted JSON draft — ignore
  }

  return null;
}
