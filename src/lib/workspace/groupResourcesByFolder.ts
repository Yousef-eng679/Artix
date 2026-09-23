import { WorkspaceResource, WorkspaceFolder } from '@/types/workspace';

export interface WorkspaceResourceGroup {
  folder: WorkspaceFolder | null;
  resources: WorkspaceResource[];
}

/**
 * Pure utility to organize normalized workspace resources into deterministic folder groups.
 *
 * Invariants:
 * 1. Every resource appears exactly once across all groups.
 * 2. Resources with folderId === null belong to the root group.
 * 3. Resources with an unknown/orphan folderId (not present in folders array)
 *    gracefully fall back to the root group without crashing.
 * 4. Empty folders are preserved in the result with resources: [].
 * 5. Folder groups are deterministically ordered: name ASC, then id ASC as tie-breaker.
 * 6. The root group (folder: null) is always positioned as the final group in the array.
 * 7. Resource ordering within each group preserves the incoming 4-tier sort.
 * 8. Pure function: zero mutations of inputs and zero side effects.
 */
export function groupResourcesByFolder(
  resources: WorkspaceResource[],
  folders: WorkspaceFolder[],
): WorkspaceResourceGroup[] {
  const folderMap = new Map<string, WorkspaceFolder>();
  for (const f of folders) {
    folderMap.set(f.id, f);
  }

  const groups = new Map<string | null, WorkspaceResource[]>();

  // Pre-seed groups for all known folders
  for (const f of folders) {
    groups.set(f.id, []);
  }
  // Pre-seed root group
  groups.set(null, []);

  // Partition resources
  for (const res of resources) {
    const targetKey = res.folderId && folderMap.has(res.folderId) ? res.folderId : null;
    const list = groups.get(targetKey);
    if (list) {
      list.push(res);
    } else {
      // Safety fallback to root
      groups.get(null)!.push(res);
    }
  }

  // Sort folders deterministically: name ASC, then id ASC
  const sortedFolders = [...folders].sort((a, b) => {
    const nameDiff = a.name.localeCompare(b.name);
    if (nameDiff !== 0) return nameDiff;
    return a.id.localeCompare(b.id);
  });

  // Construct resulting groups: sorted folders first
  const result: WorkspaceResourceGroup[] = sortedFolders.map((f) => ({
    folder: f,
    resources: groups.get(f.id) ?? [],
  }));

  // Root group always last
  result.push({
    folder: null,
    resources: groups.get(null) ?? [],
  });

  return result;
}
