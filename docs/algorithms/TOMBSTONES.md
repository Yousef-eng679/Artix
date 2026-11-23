# Tombstones & Safe Deletion Lifecycle

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/sync/tombstoneManager.ts`, `src/test/sync/tombstonesCorrectness.test.ts`

---

## 1. The Problem of Entity Resurrection

In distributed local-first systems without tombstones, deleting an entity offline frequently causes **resurrection bugs**:
1. Device A deletes document `doc-1` while offline.
2. Device A connects to the network and pulls remote changes from the server.
3. If the server or change feed contains a prior event for `doc-1`, Device A might re-insert `doc-1` because its local database no longer remembers that `doc-1` existed and was deleted!

Artix eliminates resurrection via `TombstoneManager` (`src/lib/sync/tombstoneManager.ts`).

---

## 2. Tombstone State Machine (`TombstoneLifecycleState`)

Defined in `src/lib/sync/tombstoneManager.ts` (`'ACTIVE' | 'LOCAL_PENDING_DELETE' | 'REMOTE_CONFIRMED_DELETE' | 'REMOTE_DELETE_CONFLICT' | 'PURGED_TOMBSTONE'`):

```text
               User Deletes Entity Locally
                            │
                            ▼
               ┌─────────────────────────┐
               │  LOCAL_PENDING_DELETE   │ ──► isDeleted: true in IndexedDB
               └────────────┬────────────┘     syncState: 'deleted_pending', delete queued in outbox
                            │
                            │ (Server Acknowledges CAS Delete)
                            ▼
               ┌─────────────────────────┐
               │ REMOTE_CONFIRMED_DELETE │ ──► Retained in IndexedDB (syncState: 'deleted_synced')
               └────────────┬────────────┘     Prevents remote resurrection
                            │
                            │ (Age > 30 Days & Zero Outbox/Conflict Dependencies)
                            ▼
               ┌─────────────────────────┐
               │    PURGED_TOMBSTONE     │ ──► Permanent physical row deletion from IndexedDB
               └─────────────────────────┘

          Remote Delete Received via Pull Change Feed
                            │
              ┌─────────────┴─────────────┐
              │ No Local Pending Edits    │ Local Pending Edits Exist
              ▼                           ▼
┌─────────────────────────┐ ┌─────────────────────────┐
│ REMOTE_CONFIRMED_DELETE │ │  REMOTE_DELETE_CONFLICT │
│ isDeleted: true         │ │ ConflictRecord saved    │
│ syncState:              │ │ (reason:                │
│   'deleted_synced'      │ │  'remote_deleted')      │
│ NO outbox entry queued  │ │ Outbox entry blocked    │
└─────────────────────────┘ └─────────────────────────┘
```

---

## 3. Formal Tombstone Invariants

### Invariant 1: Local Deletion Integrity Across All 4 Entity Types
When a user deletes a project, workspace folder, document, or system design:
- The local row is NOT immediately wiped from disk; it is updated with `isDeleted = true` and incremented `localRevision`.
- The outbox mutation is enqueued with `operation = 'delete'` and the current `baseServerVersion`.
- Deleting a project (`ProjectRepository.delete`) cascades local soft-delete (`isDeleted: true`) across all child `workspace_folders`, `documents`, and `system_designs` and purges their non-in-flight outbox entries in a 6-table atomic Dexie transaction.

### Invariant 2: Non-Resurrection Guard
When `PullEngine` receives a remote change for an entity ID that is marked `isDeleted: true` locally:
- If the local delete is still pending push (`LOCAL_PENDING_DELETE`), `PullEngine` records a conflict rather than resurrecting the entity.
- If the entity is already `REMOTE_CONFIRMED_DELETE` (`deleted_synced`) and the incoming event has an older or equal version, the tombstone suppresses the stale event.

### Invariant 3: Remote Confirmed Deletes Do Not Echo
When `PullEngine.pullBatch()` receives `operation: 'delete'` from `public.sync_changes` and no local edits are pending:
- It applies `isDeleted = true` and `syncState = 'deleted_synced'` directly inside the atomic pull transaction.
- It does **NOT** insert an entry into `db.outbox`. If local unpushed edits exist, it transitions to `REMOTE_DELETE_CONFLICT` (`reason: 'remote_deleted'`).

---

## 4. Safe Garbage Collection & Purging (`TombstoneManager.purgeTombstones`)

Tombstones cannot accumulate indefinitely in IndexedDB without wasting client storage. `tombstoneManager.purgeTombstones(userId, retentionMs)` executes safe garbage collection inside a **6-table atomic Dexie transaction** across all 4 synced entity tables:

```typescript
// Inside TombstoneManager.purgeTombstones(userId, retentionMs = 30 * 24 * 60 * 60 * 1000):
await this.db.transaction(
  'rw',
  [
    this.db.projects,
    this.db.documents,
    this.db.system_designs,
    this.db.workspace_folders,
    this.db.outbox,
    this.db.sync_metadata,
  ],
  async () => {
    // Scans projects, documents, system_designs, and workspace_folders where:
    //   row.userId === userId && row.isDeleted === true
    // Skips any entity that:
    //   - has pending, in_flight, or blocked outbox entries, OR
    //   - has syncState !== 'deleted_synced' (e.g. 'conflict' or 'deleted_pending'), OR
    //   - was deleted within the 30-day retention window
    // Otherwise physically deletes the entity row and its sync_metadata row.
  }
);
```

### Safety Pre-Conditions for Physical Purging
A tombstone is physically deleted only if:
1. The deletion timestamp is older than 30 days ($T_{\text{tombstone}} > 30\text{d}$).
2. The entity's sync status in `sync_metadata` is `'deleted_synced'` (never `'conflict'` or `'deleted_pending'`).
3. There are zero `pending`, `in_flight`, or `blocked` outbox entries referencing the entity.
