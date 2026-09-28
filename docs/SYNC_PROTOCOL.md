# Artix Synchronization Protocol Specification (v2.0)

## 1. Overview & System Scope
The Artix Local-First Synchronization Engine is a distributed, client-authoritative replication protocol operating between client browser instances (backed by IndexedDB via Dexie.js) and a PostgreSQL/Supabase cloud backend.

This protocol specification defines the exact data contracts, mutation identity rules, versioning semantics, change feed replication, and conflict invariants independent of any UI framework or component hierarchy.

---

## 2. Core Entities & Data Contracts

### 2.1 Entity Model
Syncable entities include:
1. **`document`**: Technical documents with title, markdown/xml content, format, project association, and folder association.
2. **`system_design`**: Architecture graph states with name, node/edge board state, project association, and folder association.
3. **`workspace_folder`**: Organizational hierarchy nodes supporting nested tree reparenting.

### 2.2 Outbox Entry Contract
Every uncommitted or in-flight mutation is tracked durably in the client's `outbox` table:

```typescript
export interface OutboxEntry {
  id: string;                      // Local outbox record UUID
  mutationId: string;              // Durable idempotency key (persists across retries)
  userId: string;                  // User partition identifier
  projectId: string | null;        // Associated project ID (if applicable)
  entityType: 'document' | 'system_design' | 'workspace_folder';
  entityId: string;                // Primary UUID of the target entity
  operation: 'create' | 'update' | 'delete';
  baseServerVersion: string | null;// Monotonic server version at time of mutation
  localRevision: number;           // Monotonic local revision of entity when queued
  payload: unknown;                // Clean mutation delta or full entity payload
  state: 'pending' | 'in_flight' | 'acknowledged' | 'failed' | 'conflict' | 'blocked';
  attemptCount: number;            // Number of network push attempts
  createdAt: number;               // Epoch timestamp of initial creation
  updatedAt: number;               // Epoch timestamp of last state change
  nextRetryAt?: number | null;     // Epoch timestamp for exponential backoff
  leaseOwner?: string | null;      // Tab coordinator UUID currently processing push
  leaseExpiresAt?: number | null;  // Heartbeat lease expiry timestamp (60s default)
  lastError?: {
    code: string;
    message: string;
    status?: number;
    timestamp: number;
  } | null;
}
```

### 2.3 Sync Metadata Contract
Every synchronized or local entity has an accompanying record in `sync_metadata`:

```typescript
export interface SyncMetadata {
  entityType: 'document' | 'system_design' | 'workspace_folder';
  entityId: string;
  userId: string;
  syncState: 'local_only' | 'pending' | 'syncing' | 'synced' | 'conflict' | 'blocked' | 'deleted_pending' | 'deleted_synced';
  serverVersion: string | null;     // Monotonic server version acknowledged by cloud
  serverUpdatedAt: string | null;   // Cloud updated_at timestamp
  localRevision: number;            // Latest local revision number
  lastSyncedAt: number | null;      // Epoch timestamp of last successful push/pull
  baseSnapshot: unknown | null;     // Exact server snapshot at last clean synchronization
  conflictId?: string | null;       // Pointer to active conflict record (if state === 'conflict')
}
```

### 2.4 Server Change Feed Record (`sync_changes`)
The cloud backend records every state transition in the append-only `sync_changes` table:

```sql
CREATE TABLE public.sync_changes (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('document', 'system_design', 'workspace_folder')),
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  entity_version BIGINT NOT NULL,
  payload JSONB,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 3. Protocol Rules & Semantics

### 3.1 Local Write Authority & Transactional Atomicity
- All user modifications (creations, edits, deletions, reparenting) MUST commit within an atomic 3-table Dexie transaction: `[entity_table, outbox, sync_metadata]`.
- The user operation is considered complete when the local database transaction succeeds. It NEVER awaits a network roundtrip.

### 3.2 Mutation Identity & Durable Idempotency
- Every logical mutation receives a cryptographically random UUID (`mutationId`) at creation.
- The `mutationId` is durable: it remains constant across all network retries, connection drops, and tab failovers.
- The server maintains a `processed_mutations` ledger:
  ```sql
  CREATE TABLE public.processed_mutations (
    mutation_id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ```
- If a client pushes a mutation whose `mutation_id` was already processed (e.g. previous response was lost due to network drop), the server acknowledges the operation as a successful no-op and returns the current record version.

### 3.3 Server Concurrency Protocol (Compare-and-Swap)
- Every syncable cloud table (`documents`, `system_designs`, `workspace_folders`) maintains a monotonic `version BIGINT` column incremented by trigger on update.
- When an entity already exists on the server, `baseServerVersion` MUST equal `sync_metadata.serverVersion`.
- The server update query enforces:
  ```sql
  UPDATE public.documents
  SET title = $1, content = $2, format = $3, updated_at = now()
  WHERE id = $4 AND user_id = $5 AND version = $6
  RETURNING version, updated_at;
  ```
- If 0 rows are affected due to version mismatch, the push adapter raises an HTTP 409 `ConflictError`. The client marks the outbox item as `'conflict'` and registers a 3-way conflict in `ConflictRepository`.

### 3.4 Change Feed & Server Cursor Semantics
- Clients track their durable position in the remote change feed using a persistent cursor key `server_cursor` stored in `database_meta`.
- When polling or reacting to Realtime wakeup signals, `PullEngine` queries:
  ```sql
  SELECT sequence, entity_type, entity_id, operation, entity_version, payload, changed_at
  FROM public.sync_changes
  WHERE user_id = $1 AND sequence > $server_cursor
  ORDER BY sequence ASC
  LIMIT 100;
  ```
- The cursor advances locally **only after** all changes in the batch have been successfully committed to local IndexedDB.

### 3.5 Conflict Detection & Deterministic Resolution
- When a remote change arrives for an entity that has pending local outbox mutations:
  - If remote content matches local content, the remote version is accepted and pending outbox mutation is retired as redundant.
  - If remote content diverges:
    - **Documents**: Resolved via deterministic 3-way line diff3 algorithm (`baseSnapshot`, `localSnapshot`, `remoteSnapshot`). If cleanly mergeable, local document is updated to merged text and queued for sync. If conflicting, both versions are recorded in `ConflictRepository` with user resolution choices (`keep_local`, `keep_remote`, `merge_document`, `create_copy`).
    - **System Designs**: Because visual node graphs cannot be safely line-merged, a divergent remote design produces an automatic timestamped copy (`"${name} (Remote Copy - ${timestamp})"`) or leaves resolution to user strategy (`keep_local`, `keep_remote`, `create_copy`).
    - **Folders**: Unicode NFKC normalized names prevent case/whitespace duplicate collisions. Conflicts resolve by appending `"(Conflict Copy)"` or adopting remote hierarchy.

### 3.6 Tombstone & Deletion Protocol
- Local deletion sets `isDeleted: true` and `deletedAt: ISO_TIMESTAMP` on the entity, queues a `delete` mutation in the outbox, and sets `syncState: 'deleted_pending'`.
- Upon server acknowledgement, the cloud sets `deleted_at` (soft delete) or cascades deletes, logging a `delete` event in `sync_changes`.
- Local metadata transitions to `'deleted_synced'`. The local entity record is retained as a tombstone until the server cursor passes the deletion event, after which local garbage collection safely purges it.
