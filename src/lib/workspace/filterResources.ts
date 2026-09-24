import { WorkspaceResource, SidebarFilterKind } from '@/types/workspace';

/**
 * Pure client-side filtering utility over normalized workspace resources.
 *
 * Invariants:
 * 1. Preserves array identity if no query and 'all' filter (React memoization friendly).
 * 2. Case-insensitive substring matching against resource.title.
 * 3. Safe against special regex characters.
 */
export function filterWorkspaceResources(
  resources: WorkspaceResource[],
  query: string,
  filterKind: SidebarFilterKind = 'all'
): WorkspaceResource[] {
  const trimmed = query.trim().toLowerCase();

  if (!trimmed && filterKind === 'all') {
    return resources;
  }

  return resources.filter((res) => {
    if (filterKind !== 'all' && res.kind !== filterKind) {
      return false;
    }
    if (!trimmed) {
      return true;
    }
    return res.title.toLowerCase().includes(trimmed);
  });
}
