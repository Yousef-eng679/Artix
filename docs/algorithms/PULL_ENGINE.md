# Pull Engine & Durable Change-Feed Replication

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/sync/pullEngine.ts`, `supabase/migrations/20260928130000_durable_sync_changes.sql`, `supabase/migrations/20261020100000_commit_ordered_sync_changes.sql`, `supabase/migrations/20261101100000_expand_sync_protocol_and_projects.sql`, `supabase/migrations/20261101100200_sync_changes_retention_and_floor.sql`, `src/test/sync/pullEngine.test.ts`, `src/test/sync/pullCursorCommitOrder.test.ts`, `src/test/sync/bootstrapHydrationAndRetentionFloor.test.tsx`

---

## 1. Overview

The `PullEngine` is responsible for synchronizing remote cloud modifications into the local IndexedDB database (`ArtixDB` v3) across all 4 synced entity types (`project`, `workspace_folder`, `document`, `system_design`). It combines an **append-only commit-ordered change feed** (`public.sync_changes`) with cold-start snapshot hydration (`bootstrapHydrateAll`) and retention-floor recovery (`resnapshotAll`).

Each client maintains a persistent sequence cursor in `ArtixDB.database_meta` under `key = 'server_cursor'`. Synchronization guarantees that local uncommitted edits are never overwritten by incoming network changes.

---

## 2. Server-Side Change Feed Log (`public.sync_changes`) & Retention Floor

Whenever a project, folder, document, or system design is created, modified, or deleted in PostgreSQL, the trigger `record_sync_change()` logs a commit-ordered change event:

```sql
CREATE TABLE public.sync_changes (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('project', 'document', 'system_design', 'workspace_folder')),
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  entity_version BIGINT NOT NULL,
  mutation_id UUID NULL,
  payload JSONB,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sync_changes_user_seq ON public.sync_changes (user_id, sequence ASC);
CREATE INDEX idx_sync_changes_user_mutation ON public.sync_changes (user_id, mutation_id) WHERE mutation_id IS NOT NULL;
CREATE INDEX idx_sync_changes_changed_at_seq ON public.sync_changes (changed_at ASC, sequence ASC);
```

### Key Server Invariants
- **Commit-Ordered Per-User Sequence (Audit F-001)**: Inside `record_sync_change()`, PostgreSQL acquires `pg_advisory_xact_lock(hashtextextended('artix.sync_changes:' || v_user_id::TEXT, 0))` before inserting, serializing per-user sequence allocation until transaction commit so `sequence` order strictly equals commit order.
- **Root-Scoped `mutation_id`**: `apply_sync_mutation` sets transaction-local GUCs (`artix.current_mutation_id`, `artix.current_mutation_entity_type`, `artix.current_mutation_entity_id`). `record_sync_change()` stamps `mutation_id` only onto the direct root entity row (never onto cascaded child deletes), enabling deterministic self-echo recognition.
- **Bounded Retention & Monotonic Floor (`public.sync_retention_state`)**: `public.prune_sync_changes(p_retention, p_batch_limit)` advances `sync_retention_state.min_retained_sequence` monotonically before batch-deleting expired rows, and `public.get_sync_feed_bounds()` exposes `{ min_retained_sequence, max_sequence }` to authenticated clients.

---

## 3. Three-Tier Pull Orchestration (`PullEngine.syncPull`)

```text
1. Query Feed Bounds:
   bounds = await supabase.rpc('get_sync_feed_bounds')
   // { min_retained_sequence, max_sequence }

2. Mode Selection:
   ├── If database_meta['hydration_complete'] !== true:
   │     Run bootstrapHydrateAll(userId, bounds):
   │     - Snapshot active rows from projects, workspace_folders, documents, system_designs
   │     - Set server_cursor = bounds.max_sequence and hydration_complete = true
   │     - Run incremental pullAll() to catch concurrent writes during snapshot
   │
   ├── Else if server_cursor < bounds.min_retained_sequence:
   │     Run resnapshotAll(userId, bounds):
   │     - Non-destructively reconcile live entity tables (preserving local pending outbox work
   │       and soft-deleting local rows that vanished remotely)
   │     - Advance server_cursor to bounds.max_sequence and run incremental pullAll()
   │
   └── Else (Normal Incremental Delta Pull — pullAll / pullBatch):
         SELECT * FROM public.sync_changes
         WHERE user_id = :userId AND sequence > :lastCursor
         ORDER BY sequence ASC
         LIMIT 50;  -- up to maxBatches = 20 per cycle

3. For each change in batch (inside a single 8-table atomic Dexie transaction):
   ├── Self-Echo Check (change.mutation_id matches local outbox or lastAckedMutationId):
   │     Acknowledge push, advance any newer chained outbox entry's baseServerVersion,
   │     and NEVER overwrite newer local entity state.
   ├── Pending-Local Guard (active outbox entry exists for entityId):
   │     If remote change conflicts with local draft -> record 3-way ConflictRecord
   │     ('version_mismatch' or 'remote_deleted'), block outbox entry, set 'conflict'.
   └── No Local Conflict:
         Apply create / update / soft-delete to local entity table and sync_metadata.
         Advance database_meta['server_cursor'] = change.sequence in the same transaction.
```

---

## 4. Self-Echo Guard & Pending-Local Protection Invariant

`PullEngine` runs two guards before writing any remote row to IndexedDB:

1. **Deterministic Self-Echo Recognition**: If `change.mutation_id` matches an entry in `db.outbox` (for example, when a push succeeded on the server right as the connection dropped, or Pull raced ahead of the Push HTTP response) or matches `syncMeta.lastAckedMutationId`:
   - The echoed outbox entry is drained.
   - If the user already made a newer local edit ($R_{\text{local}} > R_{\text{echoed}}$), the local entity row is **not** overwritten; instead, the next chained outbox entry's `baseServerVersion` is updated to `String(change.entity_version)` and `syncState` stays `'pending'`.
2. **Pending-State Conflict Guard**: If non-echoed pending or in-flight outbox entries exist for `(entityType, entityId)` and the remote snapshot differs from local state (or is a remote delete), `PullEngine` records a `ConflictRecord` (`basePayload`, `localPayload`, `remotePayload`, `reason: 'version_mismatch' | 'remote_deleted'`, `remoteVersion`, `detectedAt: Date.now()`), marks the outbox entry `'blocked'`, and sets `syncState = 'conflict'`.

---

## 5. Atomic Cursor Advancement & Post-Commit UI Notification

The sequence cursor in `database_meta` (`key: 'server_cursor'`) is updated inside the **same 8-table Dexie transaction** (`[projects, documents, system_designs, workspace_folders, outbox, sync_metadata, conflicts, database_meta]`) as the batch's entity mutations—and advances unconditionally across every branch (including self-echoes, no-ops, and conflict captures) so the client never stalls on a poison sequence (Audit F-007).

Only **after** the Dexie transaction commits does `PullEngine` invoke `coordinator.notifyRemoteChange(...)` with each entity's persisted `localRevision`, refreshing active React hooks and peer browser tabs.
