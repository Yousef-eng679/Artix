# Outbox Lifecycle, Compaction Algebra & Dependency Ordering

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/repositories/outboxRepository.ts`, `src/lib/sync/dependencyOrder.ts`, `src/test/sync/outboxMutationAlgebra.test.ts`, `src/test/sync/dispatchedSelfEchoAndCausalBarrier.test.ts`, `src/test/sync/atomicPushAckAndLeaseTokenFencing.test.ts`, `src/test/sync/offlineProjectOutboxSync.test.tsx`

---

## 1. Overview

The Outbox is a transactional queue residing in IndexedDB (`ArtixDB.outbox`). It buffers every local mutation across all 4 synced entity types (`project`, `workspace_folder`, `document`, `system_design`) until it is reliably replicated to Supabase PostgreSQL.

The outbox guarantees:
- **Zero Work Lost**: If the browser is closed or the device powers down, pending outbox records remain persisted on disk.
- **Dispatched Immutability & Causal Chaining**: Once an outbox entry has been claimed for network dispatch (`dispatched: true`), subsequent local edits never mutate or compact into it; they append as a new causal entry gated by a per-entity causal barrier.
- **Topological Causality**: Hierarchical dependencies (e.g. project before folder, parent folder before child document) are strictly preserved.
- **Minimal Network Traffic**: Redundant consecutive offline edits on an undispatched tail entry are compacted into a single minimal delta.

---

## 2. Outbox Entry Data Structure

Defined in `src/lib/local/types.ts`:

```typescript
export interface OutboxEntry {
  id: string;                       // Primary Key in IndexedDB (UUID v4)
  mutationId: string;               // Durable idempotency key sent to server
  userId: string;                   // Owning user identifier
  projectId: string | null;         // Container project identifier
  entityType: 'project' | 'document' | 'system_design' | 'workspace_folder';
  entityId: string;                 // Target entity UUID
  operation: 'create' | 'update' | 'delete';
  payload: Record<string, any>;     // Mutation data delta or full snapshot
  baseServerVersion: string | null; // Positive integer baseline string for CAS ('1', '2', ...) or null on create
  localRevision: number;            // Local entity revision at mutation time
  state: 'pending' | 'in_flight' | 'blocked' | 'failed';
  dispatched?: boolean;             // Sticky true once markInFlight claims the entry for network dispatch
  dispatchedAt?: number | null;     // Epoch ms when first dispatched
  leaseOwner: string | null;        // TabId of the leader currently processing entry
  leaseExpiresAt: number | null;    // Epoch ms when lease expires (30,000ms default TTL)
  leaseToken?: string | null;       // UUID fencing token verified on ack/fail/release
  attemptCount: number;             // Push retry attempts
  nextRetryAt?: number | null;      // Backoff gate timestamp (exponential backoff or 429 Retry-After)
  lastError?: { code: string; message: string; at: number } | null;
  errorMessage?: string | null;
  createdAt: number;                // Enqueue timestamp
  updatedAt: number;                // Last state transition timestamp
}
```

---

## 3. Outbox Mutation Algebra (7-Case Compaction Matrix)

When a user modifies the same entity multiple times while offline or before the next sync cycle, `OutboxRepository.enqueueInTx()` compacts into the latest `'pending'` tail entry **only if `!existing.dispatched`**. If the latest entry for that entity has `dispatched === true`, or is `'in_flight'` or `'blocked'`, `enqueueInTx()` appends a new causal `OutboxEntry` behind it.

| Existing Undispatched `pending` Entry | Incoming New Mutation | Resulting Outbox State | Resulting Payload & Behavior |
|---|---|---|---|
| **Case 1: `CREATE`** | `UPDATE` | `CREATE` | Merges new fields into original `CREATE` payload. Keeps operation as `CREATE`. |
| **Case 2: `CREATE`** | `DELETE` | **`NOOP` (Purged)** | Since the entity was never pushed to the server, both the `CREATE` and `DELETE` are canceled. Outbox entry is deleted. |
| **Case 3: `UPDATE`** | `UPDATE` | `UPDATE` | Merges update fields. **Crucial Invariant**: Retains the original `baseServerVersion` to preserve the server CAS check. |
| **Case 4: `UPDATE`** | `DELETE` | `DELETE` | Replaces `UPDATE` with `DELETE`. Retains original `baseServerVersion` so the server verifies concurrency before deleting. |
| **Case 5: `DELETE`** | `DELETE` | `DELETE` | Idempotent no-op; retains original delete and `baseServerVersion`. |
| **Case 6: `DELETE`** | `UPDATE` (Restore) | `UPDATE` | Restores a soft-deleted entity locally and transitions the undispatched delete back to `UPDATE`, preserving `baseServerVersion`. |
| **Case 7: `DELETE`** | `CREATE` | `CREATE` | Replaces the undispatched delete with `CREATE` carrying the new creation payload. |

### Per-Entity Causal Barrier (`getPending(..., { readyOnly: true })`)
When an entity has multiple chained entries $E_1 \to E_2$ (because $E_1$ was already `dispatched: true` when $E_2$ was enqueued), `getPending` enforces a per-entity causal barrier: $E_2$ is held back as long as $E_1$ is `in_flight`, `blocked`, `failed`, or waiting on `nextRetryAt > now`. When $E_1$ is acknowledged at server version $V_{\text{new}}$, `SyncEngine` atomically propagates $V_{\text{new}}$ into $E_2.\text{baseServerVersion}$.

---

## 4. Topological DAG Push Ordering

Entities cannot be pushed in arbitrary arrival order. For example, a project must exist on the server before its folders, documents, or system designs are inserted, and a parent folder must exist before its child folders or resources.

The topological sort in `src/lib/sync/dependencyOrder.ts` (`orderOutboxByDependency`, Kahn's algorithm with FIFO `createdAt` tie-breaking) enforces the following priority tiers:

```text
Priority 0 (Highest): Projects (operation: 'create' / 'update')
       │
       ▼
Priority 1: Parent Workspace Folders (operation: 'create' / 'update')
       │
       ▼
Priority 2: Nested Child Folders (parentFolderId DAG order)
       │
       ▼
Priority 3: Documents and System Designs (operation: 'create' / 'update')
       │
       ▼
Priority 4: Document and System Design Deletions (operation: 'delete')
       │
       ▼
Priority 5: Workspace Folder Deletions (children deleted before parents)
       │
       ▼
Priority 6 (Lowest): Project Deletions (deleted last after child entities)
```

### Local vs. Cloud Deletion Semantics
- **Folder Deletion (`FolderRepository.delete`)**: Runs a 5-table atomic Dexie transaction that soft-deletes the folder and descendant subfolders locally, unfiles child documents/designs (`folderId = null`), and enqueues the folder delete (`payload: { parentFolderId }`), matching PostgreSQL `ON DELETE CASCADE` on subfolders and `ON DELETE SET NULL` on child resources.
- **Project Deletion (`ProjectRepository.delete`)**: Runs a 6-table atomic Dexie transaction (`[projects, documents, system_designs, workspace_folders, outbox, sync_metadata]`) that soft-deletes the project and all child folders, documents, and designs locally, purges non-in-flight child outbox entries, and enqueues the project delete (matching PostgreSQL `ON DELETE CASCADE`).

---

## 5. In-Flight Lease, `leaseToken` Fencing & Backoff Lifecycle

To prevent concurrent or zombie tabs from double-pushing or corrupting state, Artix implements a fenced lease mechanism:

```text
1. Leader tab recovers expired leases and queries ready outbox entries:
   outboxRepo.recoverStaleLeases(now)
   outboxRepo.getPending(limit, userId, { readyOnly: true, now })

2. Leader claims lease (`markInFlight`):
   entry.state = 'in_flight'
   entry.leaseOwner = leaderTabId
   entry.leaseExpiresAt = Date.now() + 30000 (30-second DEFAULT_LEASE_DURATION_MS)
   entry.leaseToken = crypto.randomUUID()
   entry.dispatched = true
   entry.dispatchedAt = entry.dispatchedAt ?? Date.now()

3. Push completes (applied / already_processed):
   In one atomic Dexie transaction across [outbox, sync_metadata]:
   - Verify current.leaseToken === claimedLeaseToken
   - Propagate new serverVersion to next causal pending entry (if any)
   - Update sync_metadata (serverVersion, lastAckedMutationId, syncState)
   - Delete acknowledged entry from db.outbox

4. Push encounters transient error (`NETWORK_ERROR`, `REQUEST_TIMEOUT`, `5xx`, `429`):
   In one atomic Dexie transaction across [outbox, sync_metadata]:
   - Verify current.leaseToken === claimedLeaseToken
   - entry.attemptCount += 1
   - If non-429 and attemptCount >= maxRetries (5) -> entry.state = 'blocked'
   - Else -> entry.state = 'pending', entry.nextRetryAt = now + backoff
     (min(1000 * 2^(attempt-1), 30000) + jitter, or 429 Retry-After up to 300,000ms)

5. Push encounters conflict or non-retryable error (`TIER_LIMIT_EXCEEDED`, `VALIDATION_FAILED`):
   entry.state = 'blocked' (surfaced in SyncStatusBanner with 1-click retryBlocked())
```
