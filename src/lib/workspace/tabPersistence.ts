import { WorkspaceTab } from '@/types/workspace';
import { getActiveUserScope, getUserScopeHash } from '@/lib/local/db';

export const TAB_STORAGE_KEY_PREFIX = 'artix.workspace.tabs.';

export function getTabStorageKey(projectId: string, userId?: string | null): string {
  const scopeUser = (userId !== undefined ? userId : getActiveUserScope())?.trim();
  if (scopeUser) {
    return `${TAB_STORAGE_KEY_PREFIX}${getUserScopeHash(scopeUser)}.${projectId}`;
  }
  return `${TAB_STORAGE_KEY_PREFIX}${projectId}`;
}

/**
 * Validates that an unknown object conforms to the minimal WorkspaceTab interface.
 */
function isValidTab(item: unknown): item is WorkspaceTab {
  if (typeof item !== 'object' || item === null) return false;
  const candidate = item as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    (candidate.resourceKind === 'document' || candidate.resourceKind === 'design') &&
    typeof candidate.resourceId === 'string' &&
    candidate.resourceId.length > 0
  );
}

/**
 * Loads persisted workspace tabs for a given project (scoped by active user when present).
 * Returns null if no tabs are persisted or if data is corrupt.
 */
export function loadWorkspaceTabs(projectId: string, userId?: string | null): WorkspaceTab[] | null {
  if (!projectId) return null;

  try {
    const raw = localStorage.getItem(getTabStorageKey(projectId, userId));
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }

    const validTabs = parsed.filter(isValidTab);
    return validTabs;
  } catch (err) {
    console.warn(`[tabPersistence] Failed to load tabs for project ${projectId}:`, err);
    return null;
  }
}

/**
 * Persists open workspace tabs for a given project (scoped by active user when present).
 * Silently catches quota/storage exceptions so UI never crashes.
 */
export function saveWorkspaceTabs(
  projectId: string,
  tabs: WorkspaceTab[],
  userId?: string | null,
): void {
  if (!projectId) return;

  try {
    const serialized = JSON.stringify(
      tabs.map((t) => ({
        id: t.id,
        resourceKind: t.resourceKind,
        resourceId: t.resourceId,
      })),
    );
    localStorage.setItem(getTabStorageKey(projectId, userId), serialized);
  } catch (err) {
    console.warn(`[tabPersistence] Failed to save tabs for project ${projectId}:`, err);
  }
}

/**
 * Clears persisted workspace tabs for a given project.
 */
export function clearWorkspaceTabs(projectId: string, userId?: string | null): void {
  if (!projectId) return;

  try {
    localStorage.removeItem(getTabStorageKey(projectId, userId));
  } catch (err) {
    console.warn(`[tabPersistence] Failed to clear tabs for project ${projectId}:`, err);
  }
}
