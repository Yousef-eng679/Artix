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

## 2. Tombstone State Machine

```text
               User Deletes Entity Locally
                            │
                            ▼
               ┌────────────────────────┐
               │  LOCAL_PENDING_DELETE  │ ──► isDeleted: true in IndexedDB
               └────────────┬───────────┘     Delete queued in outbox
                            │
                            │ (Server Acknowledges CAS Delete)
                            ▼
               ┌────────────────────────┐
               │     DELETED_SYNCED     │ ──► Retained in IndexedDB
               └────────────┬───────────┘     Prevents remote resurrection
                            │
                            │ (Age > 30 Days & Network Healthy)
                            ▼
               ┌────────────────────────┐
               │    PURGED (Cleaned)    │ ──► Permanent physical row deletion
               └────────────────────────┘

          Remote Delete Received via Pull Change Feed
                            │
                            ▼
               ┌────────────────────────┐
               │ REMOTE_CONFIRMED_DELETE│ ──► isDeleted: true
               └────────────────────────┘     NO outbox delete mutation enqueued!
```

---

## 3. Formal Tombstone Invariants

### Invariant 1: Local Deletion Integrity
When a user deletes a document, design, or folder:
- The local row is NOT immediately wiped from disk.
- It is updated with `isDeleted = true`, `deletedAt = now()`, and incremented `localRevision`.
- The outbox mutation is enqueued with `operation = 'delete'` and the `baseServerVersion`.

### Invariant 2: Non-Resurrection Guard
When `PullEngine` receives a remote change for an entity ID that is marked `isDeleted: true` locally:
- If the remote change has an older or concurrent version, `PullEngine` rejects re-inserting the entity.
- The local tombstone suppresses the remote change, preventing the document from popping back into the sidebar.

### Invariant 3: Remote Confirmed Deletes Do Not Echo
When a remote change feed delivers `operation: 'delete'`:
- `TombstoneManager.markRemoteDelete(type, id, userId)` sets `isDeleted = true` and `syncState = 'deleted_synced'`.
- It does **NOT** insert an entry into the outbox. Deleting a locally confirmed remote delete would cause an infinite reflection loop.

---

## 4. Safe Garbage Collection & Purging (`purgeExpiredTombstones`)

Tombstones cannot accumulate indefinitely in IndexedDB without wasting client storage. `TombstoneManager` executes safe background garbage collection:

```typescript
export async function purgeExpiredTombstones(
  db: ArtixDB, 
  maxAgeMs = 30 * 24 * 60 * 60 * 1000 // 30 Days
): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

  // Find confirmed deleted entities older than 30 days:
  const expiredDocs = await db.documents
    .where('isDeleted')
    .equals(1)
    .filter((d) => !!d.deletedAt && d.deletedAt < cutoff)
    .toArray();

  let purgedCount = 0;
  for (const doc of expiredDocs) {
    // Safety check: ensure NO pending outbox mutation remains for this entity
    const pendingOutbox = await db.outbox
      .where('[userId+entityType+entityId]')
      .equals([doc.userId, 'document', doc.id])
      .first();

    if (!pendingOutbox) {
      // Safe to physically delete from IndexedDB
      await db.documents.delete(doc.id);
      await db.sync_metadata.delete(`document:${doc.id}`);
      purgedCount++;
    }
  }

  return purgedCount;
}
```

### Safety Pre-Conditions for Physical Purging
A tombstone is physically deleted only if:
1. `deletedAt` is older than 30 days ($T_{\text{tombstone}} > 30\text{d}$).
2. The entity's sync status is `deleted_synced` (confirmed on cloud).
3. There are zero pending or in-flight outbox entries referencing the entity.
