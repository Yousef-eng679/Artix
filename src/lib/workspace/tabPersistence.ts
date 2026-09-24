import { WorkspaceTab } from '@/types/workspace';

export const TAB_STORAGE_KEY_PREFIX = 'artix.workspace.tabs.';

export function getTabStorageKey(projectId: string): string {
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
 * Loads persisted workspace tabs for a given project.
 * Returns null if no tabs are persisted or if data is corrupt.
 */
export function loadWorkspaceTabs(projectId: string): WorkspaceTab[] | null {
  if (!projectId) return null;

  try {
    const raw = localStorage.getItem(getTabStorageKey(projectId));
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
 * Persists open workspace tabs for a given project.
 * Silently catches quota/storage exceptions so UI never crashes.
 */
export function saveWorkspaceTabs(projectId: string, tabs: WorkspaceTab[]): void {
  if (!projectId) return;

  try {
    const serialized = JSON.stringify(
      tabs.map((t) => ({
        id: t.id,
        resourceKind: t.resourceKind,
        resourceId: t.resourceId,
      })),
    );
    localStorage.setItem(getTabStorageKey(projectId), serialized);
  } catch (err) {
    console.warn(`[tabPersistence] Failed to save tabs for project ${projectId}:`, err);
  }
}

/**
 * Clears persisted workspace tabs for a given project.
 */
export function clearWorkspaceTabs(projectId: string): void {
  if (!projectId) return;

  try {
    localStorage.removeItem(getTabStorageKey(projectId));
  } catch (err) {
    console.warn(`[tabPersistence] Failed to clear tabs for project ${projectId}:`, err);
  }
}
