import { OutboxEntry } from '../local/types';

/**
 * Sorts outbox mutations into strict dependency order using a topological sort.
 * Guarantees that:
 * 1. Root and parent folders are pushed before child folders referencing them.
 * 2. Folders are created before documents and designs referencing their folderId.
 * 3. Child entities are deleted before their parent folders are deleted.
 * 4. Mutations on the same entity preserve strictly sequential FIFO order by createdAt.
 * 5. Independent entries preserve chronological FIFO order.
 */
export function orderOutboxByDependency(entries: OutboxEntry[]): OutboxEntry[] {
  if (entries.length <= 1) {
    return entries;
  }

  // Map entityId -> OutboxEntry for quick dependency lookups
  const folderCreates = new Map<string, OutboxEntry>();
  const folderDeletes = new Map<string, OutboxEntry>();

  for (const entry of entries) {
    if (entry.entityType === 'workspace_folder') {
      if (entry.operation === 'create') {
        folderCreates.set(entry.entityId, entry);
      } else if (entry.operation === 'delete') {
        folderDeletes.set(entry.entityId, entry);
      }
    }
  }

  // Build adjacency list: entryId -> Set of entryIds that MUST precede it
  // inDegree: entryId -> number of incoming prerequisite dependencies
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, Set<string>>(); // prerequisite -> Set<dependents>

  for (const entry of entries) {
    inDegree.set(entry.id, 0);
    dependents.set(entry.id, new Set<string>());
  }

  const addDependency = (prerequisiteId: string, dependentId: string) => {
    if (prerequisiteId === dependentId) return;
    const depSet = dependents.get(prerequisiteId);
    if (depSet && !depSet.has(dependentId)) {
      depSet.add(dependentId);
      inDegree.set(dependentId, (inDegree.get(dependentId) || 0) + 1);
    }
  };

  // 1. Same-entity FIFO preservation
  const entityGroups = new Map<string, OutboxEntry[]>();
  for (const entry of entries) {
    const key = `${entry.entityType}:${entry.entityId}`;
    const group = entityGroups.get(key) || [];
    group.push(entry);
    entityGroups.set(key, group);
  }

  for (const group of entityGroups.values()) {
    if (group.length > 1) {
      group.sort((a, b) => a.createdAt - b.createdAt);
      for (let i = 0; i < group.length - 1; i++) {
        addDependency(group[i].id, group[i + 1].id);
      }
    }
  }

  // 2. Cross-entity folder dependencies
  for (const entry of entries) {
    const payload = (entry.payload as Record<string, any>) || {};
    const refFolderId = payload.folderId || payload.folder_id || payload.parentFolderId || payload.parent_folder_id;

    if (refFolderId) {
      // If the referenced folder is also being created in this batch, the folder create MUST precede this entry
      const folderCreate = folderCreates.get(refFolderId);
      if (folderCreate && folderCreate.id !== entry.id) {
        addDependency(folderCreate.id, entry.id);
      }

      // If the referenced folder is being deleted, child entity deletes MUST precede folder delete
      const folderDelete = folderDeletes.get(refFolderId);
      if (folderDelete && folderDelete.id !== entry.id && entry.operation === 'delete') {
        addDependency(entry.id, folderDelete.id);
      }
    }
  }

  // Kahn's Algorithm for Topological Sort
  // Priority queue / sorted array to break ties deterministically with createdAt
  const ready: OutboxEntry[] = entries.filter((e) => inDegree.get(e.id) === 0);
  ready.sort((a, b) => a.createdAt - b.createdAt);

  const sorted: OutboxEntry[] = [];
  const processed = new Set<string>();

  while (ready.length > 0) {
    const current = ready.shift()!;
    sorted.push(current);
    processed.add(current.id);

    const children = dependents.get(current.id);
    if (children) {
      for (const childId of children) {
        const remaining = (inDegree.get(childId) || 1) - 1;
        inDegree.set(childId, remaining);
        if (remaining === 0) {
          const childEntry = entries.find((e) => e.id === childId);
          if (childEntry) {
            ready.push(childEntry);
            ready.sort((a, b) => a.createdAt - b.createdAt);
          }
        }
      }
    }
  }

  // If there are cycle leftovers (e.g. malformed self-referential graph), append them sorted by createdAt
  if (sorted.length < entries.length) {
    const remaining = entries.filter((e) => !processed.has(e.id));
    remaining.sort((a, b) => a.createdAt - b.createdAt);
    sorted.push(...remaining);
  }

  return sorted;
}
