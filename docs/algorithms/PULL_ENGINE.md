# Pull Engine & Durable Change-Feed Replication

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/sync/pullEngine.ts`, `supabase/migrations/20260928130000_durable_sync_changes.sql`, `src/test/sync/pullEngine.test.ts`

---

## 1. Overview

The `PullEngine` is responsible for synchronizing remote cloud modifications into the local IndexedDB database. Rather than downloading full snapshots or polling entity tables, Artix utilizes an **append-only change feed** stored in PostgreSQL (`public.sync_changes`).

Each client maintains a persistent sequence cursor. Synchronization is strictly incremental and guarantees that local uncommitted edits are never overwritten by incoming network changes.

---

## 2. Server-Side Change Feed Log (`public.sync_changes`)

Whenever an entity is created, modified, or deleted in PostgreSQL (via direct user push or cloud triggers), the PostgreSQL trigger `record_sync_change()` automatically logs the change event:

```sql
CREATE TABLE public.sync_changes (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  entity_version BIGINT NOT NULL,
  payload JSONB,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sync_changes_user_seq ON public.sync_changes (user_id, sequence ASC);
```

### Advantages of the Change Feed Model
- **Bandwidth Efficiency**: Only modified attributes or records are transmitted; full database rescans are eliminated.
- **Strict Linear Ordering**: The identity sequence guarantees that remote events are consumed in the exact physical order they were committed on the database.
- **Historical Auditability**: Cloud state changes are recorded with operation type, timestamp, and version.

---

## 3. The Pull Algorithm

```text
1. Fetch Persistent Sequence Cursor:
   lastCursor = await syncMetadataRepo.getLastSyncedSequence(userId)

2. Query Next Change Batch from Supabase:
   SELECT * FROM public.sync_changes
   WHERE user_id = :userId AND sequence > :lastCursor
   ORDER BY sequence ASC
   LIMIT 100;

3. For each change record in batch:
   ┌──────────────────────────────────────────────────────────┐
   │ Check Pending-Local Guard:                               │
   │ Does this entity have an active unpushed outbox mutation?│
   └────────────────────────────┬─────────────────────────────┘
                                │
               ┌────────────────┴───────────────┐
               │ YES                            │ NO
               ▼                                ▼
   ┌───────────────────────┐       ┌────────────────────────┐
   │ Check for Conflict:   │       │ Apply Remote Change    │
   │ Remote payload differs│       │ Directly to IndexedDB: │
   │ from local draft?     │       │                        │
   └───────────┬───────────┘       │ - create: insert row   │
               │                   │ - update: update row   │
       ┌───────┴──────┐            │ - delete: mark tomb-   │
       │ YES          │ NO         │   stone in Tombstone-  │
       ▼              ▼            │   Manager              │
   Record 3-way     No-op          └───────────┬────────────┘
   conflict in      (Identical)                │
   ConflictRepo;                               ▼
   Block outbox;                   ┌────────────────────────┐
   Set status                      │ Advance Local Cursor:  │
   'conflict'.                     │ lastCursor = sequence  │
                                   └────────────────────────┘
```

---

## 4. Pending-Local Protection Invariant

A fundamental flaw of naive sync engines is that pulling remote data overwrites local unsaved drafts. Artix eliminates this via the **Pending-State Safe Guard**:

```typescript
// Inside PullEngine.applyRemoteChange():
const pendingOutboxEntries = await this.outboxRepo.getByEntity(
  change.entityType,
  change.entityId,
  userId
);

const hasActivePendingMutation = pendingOutboxEntries.some(
  (entry) => entry.state === 'pending' || entry.state === 'in_flight'
);

if (hasActivePendingMutation) {
  // Local modifications exist. Verify if content actually differs.
  const localEntity = await this.getEntity(change.entityType, change.entityId);
  const isIdentical = this.isPayloadEqual(localEntity, change.payload);

  if (!isIdentical) {
    // True concurrent conflict: DO NOT OVERWRITE LOCAL WORK!
    await this.conflictRepo.recordConflict({
      id: crypto.randomUUID(),
      entityType: change.entityType,
      entityId: change.entityId,
      baseContent: change.payload,
      localContent: localEntity,
      remoteContent: change.payload,
      detectedAt: new Date().toISOString()
    });

    // Block outbox entry to prevent overwrite attempts
    await this.outboxRepo.blockEntry(change.entityType, change.entityId, userId);
    await this.syncMetadataRepo.setSyncState(change.entityId, change.entityType, 'conflict');
    return;
  }
}
```

---

## 5. Cursor Monotonicity & Transactional Commit

The sequence cursor stored in `sync_metadata` advances **strictly after** the local entity update is written to IndexedDB.

- If the client loses power or crashes during a batch of 50 changes at change 25:
  - Changes 1–24 committed, cursor is at 24.
  - Change 25 did not commit, cursor remains at 24.
  - Upon restart, `PullEngine` queries `WHERE sequence > 24` and re-applies change 25 safely and idempotently.
- Stale events where `sequence <= lastCursor` are dropped as no-ops.
