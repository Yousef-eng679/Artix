# Conflict Resolution & 3-Way Diff3 Merge Protocol

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/sync/conflictResolver.ts`, `src/lib/repositories/conflictRepository.ts`, `src/components/ConflictResolutionModal.tsx`, `src/test/sync/conflictResolver.test.ts`, `src/test/sync/circularImportsDiff3AndCryptoV2.test.ts`, `src/test/sync/multiDeviceConflictResolution.test.tsx`

---

## 1. Overview

Conflicts in distributed systems occur when two or more devices modify the same entity concurrently from the same baseline state, or when one device modifies an entity that another device has deleted remotely.

Artix rejects naive Last-Write-Wins (LWW) policies because LWW causes silent data loss. Instead, Artix implements a **3-Way Conflict Architecture** across all 4 synced entity types (`project`, `document`, `system_design`, `workspace_folder`):
1. Concurrency violations are detected deterministically via `public.apply_sync_mutation` CAS checks (`reason`: `'version_mismatch' | 'remote_deleted' | 'already_exists'`) or by `PullEngine` when incoming changes collide with unpushed local edits.
2. Conflicting outbox entries are immediately parked as `blocked` to stop overwrite attempts.
3. The common ancestor (`basePayload`), local draft (`localPayload`), and remote modification (`remotePayload`) are persisted atomically in `ConflictRepository`.
4. Users resolve conflicts via `ConflictResolutionCenter` / `ConflictResolutionModal`, with LCS-aligned 3-way line merging (`diff3`) for documents and an unresolved conflict-marker guard (`UnresolvedConflictMarkersError`).

---

## 2. The 3-Way Conflict Snapshot Model

When a conflict occurs, a structured snapshot is saved in IndexedDB (`conflicts` table, defined in `src/lib/local/types.ts`):

```typescript
export interface ConflictRecord {
  id: string;                                // Primary Key (UUID v4)
  entityType: 'project' | 'document' | 'system_design' | 'workspace_folder';
  entityId: string;                          // Target entity UUID
  userId: string;                            // Owning user
  basePayload: Record<string, any> | null;   // Common ancestor snapshot (version N)
  localPayload: Record<string, any>;         // User's unpushed local edits
  remotePayload: Record<string, any> | null; // Remote state in PostgreSQL (null when remote_deleted)
  reason?: 'version_mismatch' | 'remote_deleted' | 'already_exists' | string | null;
  remoteVersion?: string | null;             // Authoritative server version string
  detectedAt: number;                        // Epoch milliseconds
  resolvedAt?: number | null;                // Epoch ms when resolved (unresolved records have !resolvedAt)
}
```

---

## 3. Resolution Strategies Across All 4 Entity Types

`ConflictRepository.resolveConflict()` and `ConflictResolutionModal.tsx` support four deterministic resolution strategies:

| Strategy | Applicable Entities | Behavior |
|---|---|---|
| **`keep_local`** | `project`, `document`, `system_design`, `workspace_folder` | Rebases the blocked outbox entry's `baseServerVersion` onto `remoteVersion` and returns it to `'pending'`. If `reason === 'remote_deleted'`, replaces the blocked update/delete entry with a fresh `operation: 'create'` carrying the full local entity snapshot so the deleted entity is re-created on the server. |
| **`keep_remote`** | `project`, `document`, `system_design`, `workspace_folder` | Overwrites the local entity with `remotePayload` (or, if `reason === 'remote_deleted'`, marks the entity `isDeleted = true` locally — cascading local child soft-deletes when `entityType === 'project'`), deletes pending outbox entries for the entity, and sets `syncState` to `'synced'` or `'deleted_synced'`. |
| **`create_copy`** | `document`, `system_design`, `workspace_folder`, `project` | Clones the local entity under a new UUID (`ConflictResolver.resolveSystemDesignConflict` / `resolveFolderConflictName` / `" (Conflict Copy)"`), enqueues a `create` mutation for the copy, and applies the remote state (`keep_remote`) to the original entity ID. |
| **`merge_document`** | `document` | Computes an LCS-aligned 3-way `diff3` text merge (`ConflictResolver.mergeDocumentText(base, local, remote)`), allows interactive editing in `ConflictResolutionModal`, verifies zero unresolved conflict markers remain, writes the merged content locally, and rebases the outbox entry onto `remoteVersion`. |

---

## 4. The LCS-Aligned Diff3 Merge Algorithm (`conflictResolver.ts`)

For technical documents, `ConflictResolver.mergeDocumentText` aligns `base -> local` and `base -> remote` using dynamic-programming Longest Common Subsequence (`computeLcsMapping`) before walking 3-way chunks:

```text
       Base (Common Ancestor)
            ┌─────────┐
            │ Line 1  │
            │ Line 2  │
            │ Line 3  │
            └────┬────┘
                 │
       ┌─────────┴─────────┐
       ▼                   ▼
     Local               Remote
  ┌─────────┐         ┌─────────┐
  │ Line 1  │         │ Line 1  │
  │ Line 2* │         │ Line 2  │ (Unchanged)
  │ Line 3  │         │ Line 3* │
  └────┬────┘         └────┬────┘
       │                   │
       └─────────┬─────────┘
                 │ LCS Diff3 Merge
                 ▼
          Merged Document
       ┌───────────────────┐
       │ Line 1            │ (Common)
       │ Line 2*           │ (Local change auto-applied)
       │ Line 3*           │ (Remote change auto-applied)
       └───────────────────┘
```

### Overlapping Conflict Markers & Push Guard
When both local and remote devices modify the *same* region differently (and neither side matches the other), `mergeDocumentText` emits standard conflict markers:
```markdown
<<<<<<< LOCAL
const API_URL = "https://api.v2.internal";
=======
const API_URL = "https://gateway.prod.cloud";
>>>>>>> REMOTE
```
`ConflictResolver.hasUnresolvedConflictMarkers(text)` guards three boundaries against accidental marker persistence:
1. `ConflictResolutionModal.tsx`: disables the "Apply Merge" confirmation button until all markers are removed.
2. `ConflictRepository.resolveConflict()`: throws `UnresolvedConflictMarkersError` (`code: 'UNRESOLVED_CONFLICT_MARKERS'`) if `merge_document` is called with markers still present.
3. `DocumentPushAdapter`: throws `UnresolvedConflictMarkersError` (HTTP `422`) before network dispatch if any document content contains unresolved markers.

---

## 5. Atomic Conflict Resolution Transaction

```typescript
// Inside ConflictRepository.resolveConflict({ conflictId, strategy, mergedContent, copyTitle }):
await this.db.transaction(
  'rw',
  [
    this.db.projects,
    this.db.documents,
    this.db.system_designs,
    this.db.workspace_folders,
    this.db.outbox,
    this.db.sync_metadata,
    this.db.conflicts,
  ],
  async () => {
    // 1. Validate ConflictRecord and (for merge_document) check hasUnresolvedConflictMarkers()
    // 2. Apply keep_local, keep_remote, create_copy, or merge_document state updates
    // 3. Rebase or purge outbox entries and update sync_metadata
    // 4. Stamp conflict.resolvedAt = Date.now()
  }
);
```
