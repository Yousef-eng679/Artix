# Outbox Lifecycle, Compaction Algebra & Dependency Ordering

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/repositories/outboxRepository.ts`, `src/lib/sync/dependencyOrder.ts`, `src/test/sync/outboxMutationAlgebra.test.ts`

---

## 1. Overview

The Outbox is a transactional queue residing in IndexedDB (`ArtixDB.outbox`). It buffers every local mutation until it is reliably replicated to Supabase PostgreSQL. 

The outbox guarantees:
- **Zero Work Lost**: If the browser is closed or the device powers down, pending outbox records remain persisted on disk.
- **Topological Causality**: Hierarchical dependencies (e.g. parent folder before child document) are strictly preserved.
- **Minimal Network Traffic**: Redundant consecutive offline edits on the same entity are compacted into a single minimal delta.

---

## 2. Outbox Entry Data Structure

Defined in `src/lib/local/types.ts`:

```typescript
export interface OutboxEntry {
  id: string;                       // Primary Key in IndexedDB (UUID v4)
  mutationId: string;               // Durable idempotency key sent to server
  userId: string;                   // Owning user identifier
  projectId: string | null;         // Container project identifier
  entityType: 'document' | 'system_design' | 'workspace_folder';
  entityId: string;                 // Target entity UUID
  operation: 'create' | 'update' | 'delete';
  payload: Record<string, any>;     // Mutation data delta or full snapshot
  baseServerVersion?: string;       // Baseline version for CAS concurrency check
  localRevision: number;            // Local entity revision at mutation time
  state: 'pending' | 'in_flight' | 'blocked' | 'failed';
  leaseOwner: string | null;        // TabId of the leader currently processing entry
  leaseExpiresAt: number | null;    // Epoch ms when lease expires
  attemptCount: number;             // Push retry attempts
  createdAt: number;                // Enqueue timestamp
  updatedAt: number;                // Last state transition timestamp
}
```

---

## 3. Outbox Mutation Algebra (Compaction Matrix)

When a user modifies the same entity multiple times while offline or before the next sync cycle, `OutboxRepository` applies formal mutation algebra to prevent redundant cloud writes:

| Existing State in Outbox | Incoming New Mutation | Resulting Outbox State | Resulting Payload & Behavior |
|---|---|---|---|
| **Case 1: `CREATE`** | `UPDATE` | `CREATE` | Merges new fields into original `CREATE` payload. Keeps operation as `CREATE`. |
| **Case 2: `CREATE`** | `DELETE` | **`NOOP` (Purged)** | Since the entity was never pushed to the server, both the `CREATE` and `DELETE` are canceled. Outbox entry is deleted. |
| **Case 3: `UPDATE`** | `UPDATE` | `UPDATE` | Merges update fields. **Crucial Invariant**: Retains the original `baseServerVersion` to prevent corrupting the server CAS check. |
| **Case 4: `UPDATE`** | `DELETE` | `DELETE` | Replaces `UPDATE` with `DELETE`. Retains original `baseServerVersion` so the server can verify concurrency before deleting. |
| **Case 5: `DELETE`** | `DELETE` | `DELETE` | Idempotent no-op; retains original delete. |
| **Case 6: `DELETE`** | `CREATE` (Restore) | `UPDATE` | If a user deletes an entity and re-creates/restores it locally, it transitions to `UPDATE` with the new content, clearing `isDeleted`. |

---

## 4. Topological DAG Push Ordering

Entities cannot be pushed in arbitrary arrival order. For example, if a document references a `folderId`, the folder must exist in PostgreSQL before the document is inserted, otherwise a foreign key violation or dangling reference occurs.

The topological sort in `src/lib/sync/dependencyOrder.ts` enforces the following priority tiers:

```text
Priority 1 (Highest): Parent Workspace Folders (operation: 'create' / 'update')
       │
       ▼
Priority 2: Nested Child Folders (parentFolderId dependencies)
       │
       ▼
Priority 3: Documents and System Designs (operation: 'create' / 'update')
       │
       ▼
Priority 4: Document and System Design Deletions (operation: 'delete')
       │
       ▼
Priority 5 (Lowest): Workspace Folder Deletions (parent folders deleted last)
```

### Folder Cascading Payloads
When a folder is deleted, `FolderRepository` computes all descendant subfolder IDs, document IDs, and system design IDs, appending them to the mutation payload:
```typescript
payload: {
  id: folderId,
  affectedDocumentIds: ['doc-1', 'doc-2'],
  affectedDesignIds: ['design-1'],
  affectedFolderIds: ['subfolder-1']
}
```
This guarantees that local and cloud cascade deletions remain atomic and fully audited.

---

## 5. In-Flight Lease & Crash Recovery Lifecycle

To prevent concurrent tabs from double-pushing the same entry, Artix implements a distributed lease mechanism:

```text
1. Leader tab queries outbox:
   WHERE state = 'pending' AND (attemptCount < maxRetries)

2. Leader claims lease:
   entry.state = 'in_flight'
   entry.leaseOwner = leaderTabId
   entry.leaseExpiresAt = Date.now() + 15000 (15-second TTL)

3. Push completes with 200 OK:
   await db.outbox.delete(entry.id) -- DRAINED & REMOVED

4. Push encounters transient network error:
   entry.state = 'pending'
   entry.leaseOwner = null
   entry.leaseExpiresAt = null
   entry.attemptCount += 1
   entry.updatedAt = Date.now() + (2 ** entry.attemptCount * 500) -- Exponential Backoff

5. Leader tab crashes mid-push:
   Standby tab or restart detects:
   WHERE state = 'in_flight' AND leaseExpiresAt < Date.now()
   -> Reclaims entry to 'pending' immediately.
```
