# Push Engine & CAS Concurrency Protocol

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/sync/syncEngine.ts`, `src/lib/sync/adapters/`, `src/test/sync/pushAdapters.test.ts`

---

## 1. Overview

The `SyncEngine` is the push authority in Artix. It drains pending outbox mutations from IndexedDB and dispatches them to Supabase PostgreSQL via specialized push adapters.

Every push operation is protected by two cryptographic and concurrency guarantees:
1. **Idempotency Verification**: Durable `mutationId` checks against `public.processed_mutations`.
2. **Compare-and-Swap (CAS) Predicate**: Monotonic version checking prevents silent Lost Updates.

---

## 2. Push Adapter Architecture (`src/lib/sync/adapters/`)

Push logic is modularized into pure adapter classes implementing `EntityPushAdapter`:
- `DocumentPushAdapter`: Handles document creation, updates, and CAS deletions.
- `SystemDesignPushAdapter`: Handles canvas node graph board state updates.
- `FolderPushAdapter`: Handles hierarchical folder trees and cascading delete payloads.

### Push Execution Pipeline

```text
Outbox Entry Ready for Push
             │
             ▼
┌────────────────────────────────────────────────────────┐
│             Step 1: Check Idempotency Ledger           │
│   SELECT * FROM processed_mutations WHERE mutation_id   │
└────────────────────────────┬───────────────────────────┘
                             │
            ┌────────────────┴────────────────┐
            │ FOUND (Prior Execution)         │ NOT FOUND (New Push)
            ▼                                 ▼
   ┌───────────────────────┐         ┌────────────────────────┐
   │ Return Cached Version │         │ Step 2: Push with CAS  │
   │ and Timestamp         │         │ Predicate to Supabase  │
   └───────────┬───────────┘         └───────────┬────────────┘
               │                                 │
               │               ┌─────────────────┴────────────────┐
               │               │ 200 OK / Updated                 │ 0 Rows Updated (Mismatch)
               │               ▼                                  ▼
               │       ┌───────────────────────┐          ┌───────────────────────┐
               │       │ Step 3: Record in     │          │ Throw 409 CONFLICT    │
               │       │ processed_mutations   │          │ Outbox state: blocked │
               │       └───────────┬───────────┘          └───────────────────────┘
               │                   │
               ▼                   ▼
┌────────────────────────────────────────────────────────┐
│            Step 4: Revision-Safe Acknowledgment        │
│       - Verify localRevision === entry.localRevision   │
│       - If matched: delete from outbox, mark 'synced'  │
│       - If user edited: retain 'pending', update base  │
└────────────────────────────────────────────────────────┘
```

---

## 3. The Optimistic CAS Predicate

When updating or deleting an existing entity, the push adapter verifies that the remote version matches the `baseServerVersion` held locally when the mutation was recorded:

### Update Predicate
```typescript
const baseVer = parseInt(entry.baseServerVersion, 10);

const { data, error } = await supabase
  .from('documents')
  .update({
    title: payload.title,
    content: payload.content,
    format: payload.format,
    folder_id: payload.folderId,
    // Database trigger automatically computes: version = version + 1
  })
  .eq('id', entry.entityId)
  .eq('version', baseVer) // CAS GUARD
  .select('id, version, updated_at')
  .maybeSingle();

if (!data && !error) {
  // Query executed but returned 0 rows -> version mismatch!
  const conflictErr = new Error(`Conflict detected: document '${entry.entityId}' was modified remotely`);
  (conflictErr as any).status = 409;
  (conflictErr as any).code = 'CONFLICT';
  throw conflictErr;
}
```

### Delete Predicate
```typescript
let query = supabase.from('documents').delete().eq('id', entry.entityId);
if (entry.baseServerVersion) {
  query = query.eq('version', parseInt(entry.baseServerVersion, 10));
}
const { data, error } = await query.select('id');
// If 0 rows deleted, inspect remote version and raise 409 CONFLICT if row still exists.
```

---

## 4. Revision-Safe Acknowledgements

In active multi-tab or rapid typing sessions, a user frequently makes an additional edit (Revision $N+1$) while an earlier edit (Revision $N$) is actively in flight over the network.

If an acknowledgment for $N$ naively overwrites the local state with "synced", Revision $N+1$ would be lost!

Artix enforces **Revision-Safe Acknowledgement** (`src/lib/sync/syncEngine.ts`):

```typescript
// Inside acknowledgePush():
const currentDoc = await this.documentRepo.getById(entry.entityId);

if (currentDoc && currentDoc.localRevision === entry.localRevision) {
  // Local state has not changed since push started:
  await this.syncMetadataRepo.updateServerVersion(entry.entityId, entry.entityType, serverVersion);
  await this.syncMetadataRepo.setSyncState(entry.entityId, entry.entityType, 'synced');
} else {
  // User made further edits (localRevision > entry.localRevision) while push was in flight!
  // Refresh the base server version to the newly acknowledged version, but KEEP status as 'pending':
  await this.syncMetadataRepo.updateServerVersion(entry.entityId, entry.entityType, serverVersion);
  await this.syncMetadataRepo.setSyncState(entry.entityId, entry.entityType, 'pending');
}

// In both cases, the fulfilled outbox entry for revision N is drained
await this.outboxRepo.delete(entry.id);
```

---

## 5. Error Taxonomy & Retry Strategy

Defined in `src/lib/sync/errorTaxonomy.ts`:

| Error Category | HTTP Status / Code | SyncEngine Action |
|---|---|---|
| **Conflict** | `409` / `CONFLICT` | Mark outbox entry as `blocked`. Record 3-way conflict. Do NOT retry automatically. |
| **Authentication** | `401` / `403` / `PGRST301` | Halt sync engine. Mark runtime as degraded. Prompt user to re-authenticate. |
| **Network Timeout** | `ETIMEDOUT` / `FETCH_ERROR` / `ECONNREFUSED` | Release lease back to `pending`. Increment `attemptCount`. Apply exponential backoff: $T = 2^{\text{attempts}} \times 500\text{ms}$. |
| **Schema / Validation** | `400` / `23505` (Unique) | Mark outbox entry as `failed`. Log critical error for developer inspection. |
