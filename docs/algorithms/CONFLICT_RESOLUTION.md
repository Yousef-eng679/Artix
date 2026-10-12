# Conflict Resolution & 3-Way Diff3 Merge Protocol

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/sync/conflictResolver.ts`, `src/lib/repositories/conflictRepository.ts`, `src/test/sync/conflictResolver.test.ts`

---

## 1. Overview

Conflicts in distributed systems occur when two or more devices modify the same entity concurrently from the same baseline state. 

Artix rejects naive Last-Write-Wins (LWW) policies because LWW causes silent data loss. Instead, Artix implements a **3-Way Conflict Architecture**:
1. Concurrency violations are detected deterministically via optimistic CAS predicates (`409 CONFLICT`).
2. Conflicting outbox entries are immediately `blocked` to stop overwrite attempts.
3. The common ancestor (`base`), local draft (`local`), and remote modification (`remote`) are persisted in `ConflictRepository`.
4. Technical markdown documents undergo automated line-level 3-way merging (`diff3`).

---

## 2. The 3-Way Conflict Snapshot Model

When a conflict occurs, a structured snapshot is saved in IndexedDB (`conflicts` table):

```typescript
export interface ConflictRecord {
  id: string;                       // Primary Key (UUID v4)
  userId: string;                   // Owning user
  projectId: string;                // Project container
  entityType: 'document' | 'system_design' | 'workspace_folder';
  entityId: string;                 // Target entity UUID
  baseContent: Record<string, any>; // Common ancestor snapshot (version N)
  localContent: Record<string, any>;// User's unpushed local edits
  remoteContent: Record<string, any>;// Remote state currently in PostgreSQL (version N+1)
  detectedAt: string;               // ISO 8601 timestamp
  resolutionState: 'unresolved' | 'resolved_local' | 'resolved_remote' | 'resolved_merged';
}
```

---

## 3. Resolution Strategies by Entity Type

| Entity Type | Conflict Type | Resolution Strategy | Description |
|---|---|---|---|
| **Document** (`content`) | Concurrent text edits | **Automatic Diff3 Line Merge** | Computes 3-way line diff. Non-overlapping edits auto-merge cleanly. Overlapping edits are decorated with standard Git conflict markers. |
| **Document** (`title` / metadata) | Concurrent attribute edits | **Last Acknowledged Remote** | Prompts user with side-by-side comparison modal; defaults to retaining local draft in draft buffer. |
| **System Design** (`board_state`) | Concurrent node/edge moves | **Canvas Union & Flag** | Merges non-overlapping nodes; nodes modified on both devices are duplicated with a `.conflict` badge for user repositioning. |
| **Workspace Folder** | Concurrent rename / reparent | **Deterministic Parent Retain** | Folder renames take remote name; parent reparenting retains valid DAG ancestor path to prevent cycles. |

---

## 4. The Diff3 Merge Algorithm (`conflictResolver.ts`)

For technical documentation, `conflictResolver.ts` implements a deterministic 3-way diff algorithm:

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
                 │ Diff3 Merge
                 ▼
          Merged Document
       ┌───────────────────┐
       │ Line 1            │ (Common)
       │ Line 2*           │ (Local change auto-applied)
       │ Line 3*           │ (Remote change auto-applied)
       └───────────────────┘
```

### Overlapping Conflict Markers
When both local and remote devices modify the *same* lines of text:
```markdown
<<<<<<< LOCAL (Your Draft)
const API_URL = "https://api.v2.internal";
=======
const API_URL = "https://gateway.prod.cloud";
>>>>>>> REMOTE (Server State)
```
The user is presented with Monaco Editor's side-by-side diff widget to choose or blend changes.

---

## 5. Conflict Resolution Workflow

```typescript
// User resolves conflict via UI:
async function resolveConflict(conflictId: string, resolution: 'keep_local' | 'keep_remote' | 'merged', mergedContent?: string) {
  const conflict = await conflictRepo.getById(conflictId);
  
  if (resolution === 'keep_local') {
    // 1. Fetch latest server version
    const latestVersion = await fetchRemoteVersion(conflict.entityId);
    // 2. Refresh outbox entry baseServerVersion to latestVersion
    await outboxRepo.unblockAndRebase(conflict.entityId, latestVersion);
    // 3. Mark conflict resolved
    await conflictRepo.delete(conflictId);
  } else if (resolution === 'keep_remote') {
    // 1. Overwrite local IndexedDB with remoteContent
    await documentRepo.forceUpdate(conflict.entityId, conflict.remoteContent);
    // 2. Drop pending outbox mutation
    await outboxRepo.deleteByEntity(conflict.entityId);
    // 3. Mark conflict resolved
    await conflictRepo.delete(conflictId);
  } else if (resolution === 'merged') {
    // 1. Write merged content locally
    await documentRepo.update(conflict.entityId, { content: mergedContent });
    // 2. Rebase outbox mutation with latest server version
    await outboxRepo.unblockAndRebase(conflict.entityId, latestVersion);
    await conflictRepo.delete(conflictId);
  }
}
```
