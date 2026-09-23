import { WorkspaceResource } from '@/types/workspace';

export interface AdaptableDocument {
  id: string;
  project_id?: string | null;
  title: string;
  updated_at: string;
  created_at?: string;
  format?: string;
  folder_id?: string | null;
}

export interface AdaptableDesign {
  id: string;
  project_id: string;
  name: string;
  updated_at: string;
  created_at?: string;
  folder_id?: string | null;
  board_state?: {
    nodes?: unknown[];
  };
}

/**
 * Transforms disparate document and system design domain models into a
 * normalized, presentation-ready WorkspaceResource list.
 *
 * Invariants:
 * 1. Pure function with zero network access and zero mutations.
 * 2. Strict project boundary: resources from other projects are omitted.
 * 3. 4-Tier Deterministic Sorting:
 *    - Tier 1: updatedAt DESC (newest first)
 *    - Tier 2: Normalized lowercase title ASC
 *    - Tier 3: Original title ASC
 *    - Tier 4: Resource ID ASC (unbreakable tie-breaker)
 */
export function toWorkspaceResources(
  documents: AdaptableDocument[],
  designs: AdaptableDesign[],
  projectId: string
): WorkspaceResource[] {
  const resources: WorkspaceResource[] = [];

  if (!projectId) return resources;

  for (const doc of documents) {
    if (doc.project_id === projectId) {
      resources.push({
        id: doc.id,
        projectId,
        title: doc.title || 'Untitled Document',
        kind: 'document',
        updatedAt: doc.updated_at,
        createdAt: doc.created_at,
        folderId: doc.folder_id ?? null,
        meta: {
          format: doc.format,
        },
      });
    }
  }

  for (const design of designs) {
    if (design.project_id === projectId) {
      resources.push({
        id: design.id,
        projectId,
        title: design.name || 'Untitled Design',
        kind: 'design',
        updatedAt: design.updated_at,
        createdAt: design.created_at,
        folderId: design.folder_id ?? null,
        meta: {
          nodeCount: Array.isArray(design.board_state?.nodes) ? design.board_state.nodes.length : 0,
        },
      });
    }
  }

  return resources.sort((a, b) => {
    // Tier 1: updatedAt descending
    const timeA = new Date(a.updatedAt).getTime();
    const timeB = new Date(b.updatedAt).getTime();
    const timeDiff = timeB - timeA;
    if (timeDiff !== 0 && !Number.isNaN(timeDiff)) return timeDiff;

    // Tier 2: Lowercase title ascending
    const lowerA = a.title.toLowerCase();
    const lowerB = b.title.toLowerCase();
    const lowerDiff = lowerA.localeCompare(lowerB);
    if (lowerDiff !== 0) return lowerDiff;

    // Tier 3: Original title ascending (deterministic lexical comparison)
    if (a.title !== b.title) {
      return a.title < b.title ? -1 : 1;
    }

    // Tier 4: ID ascending (unbreakable tie-breaker)
    return a.id.localeCompare(b.id);
  });
}
