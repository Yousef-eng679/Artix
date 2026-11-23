# Push Engine & CAS Concurrency Protocol

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/sync/syncEngine.ts`, `src/lib/sync/adapters/`, `src/lib/sync/adapters/idempotency.ts`, `supabase/migrations/20261020110000_atomic_idempotent_mutation_rpc.sql`, `supabase/migrations/20261101100000_expand_sync_protocol_and_projects.sql`, `supabase/migrations/20261101100100_contract_strict_cas_base_version.sql`, `src/test/sync/pushAdapters.test.ts`

---

## 1. Overview

The `SyncEngine` is the push authority in Artix. It drains ready outbox mutations from IndexedDB in topological dependency order and dispatches them to Supabase PostgreSQL via specialized push adapters and the single-transaction `public.apply_sync_mutation` RPC.

Every push operation is protected by three guarantees:
1. **Strict CAS Baseline Validation**: Client-side `requireValidCasBaseVersion()` and server-side `apply_sync_mutation` require a positive integer `baseServerVersion >= 1` on every `update` and `delete`, preceded by a pre-push baseline reconciler for legacy rows.
2. **Single-Transaction Idempotency & CAS**: `public.apply_sync_mutation` checks `public.processed_mutations`, executes the CAS-guarded mutation, logs `public.sync_changes` with `mutation_id`, and records the idempotency ledger entry in **one atomic PostgreSQL transaction**.
3. **Fenced Revision-Safe Acknowledgements**: Client acknowledgement and failure transitions run inside atomic Dexie transactions verified against the entry's `leaseToken`.

---

## 2. Push Adapter Architecture (`src/lib/sync/adapters/`)

Push logic is modularized across four adapter classes implementing `EntityPushAdapter`, all sharing `executeAtomicMutation()` and `requireValidCasBaseVersion()` in `src/lib/sync/adapters/idempotency.ts`:
- `ProjectPushAdapter` (`projectPushAdapter.ts`): Handles project creation, rename/update, and CAS deletion.
- `WorkspaceFolderPushAdapter` (`folderPushAdapter.ts`): Handles hierarchical folder creation, rename/reparent updates, and CAS deletion.
- `DocumentPushAdapter` (`documentPushAdapter.ts`): Enforces `ConflictResolver.hasUnresolvedConflictMarkers()` (`UnresolvedConflictMarkersError`, HTTP `422`) before dispatching document creation, updates, and CAS deletions.
- `SystemDesignPushAdapter` (`systemDesignPushAdapter.ts`): Handles canvas `board_state` creation, updates, and CAS deletions.

All adapter calls are wrapped in `withTimeout(..., TRANSPORT_TIMEOUT_MS)` (`30,000ms`, `src/lib/sync/transportTimeout.ts`).

### Push Execution Pipeline

```text
Outbox Entry Ready for Push (passed per-entity causal barrier & DAG sort)
             │
             ▼
┌────────────────────────────────────────────────────────┐
│   Step 0: Pre-Push Baseline Reconciler & Lease Claim   │
│ - reconcileMissingCasBaseline() heals legacy null base │
│ - markInFlight() sets leaseToken, 30s TTL, dispatched  │
└────────────────────────────┬───────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────┐
│     Step 1: Single-Transaction RPC (`apply_sync_mutation`) │
│ - pg_advisory_xact_lock('artix.mutation:' || mutation_id)  │
│ - Check `public.processed_mutations` ledger                │
│ - Set `artix.current_mutation_*` GUCs for `sync_changes`   │
│ - Execute INSERT / UPDATE / DELETE WHERE version = base    │
│ - Insert `processed_mutations` row in SAME transaction     │
└────────────────────────────┬───────────────────────────┘
                             │
       ┌─────────────────────┼─────────────────────┐
       │ 'applied' or        │ 'conflict'          │ Transient / Quota /
       │ 'already_processed' │ (version_mismatch / │ Validation Error
       ▼                     │  remote_deleted /   ▼
┌──────────────────────┐     │  already_exists)  ┌──────────────────────┐
│ Step 2A: Atomic Ack  │     ▼                   │ Step 2C: Atomic Fail │
│ [outbox, sync_meta]  │ ┌────────────────────┐  │ [outbox, sync_meta]  │
│ - Verify leaseToken  │ │ Step 2B: Conflict  │  │ - Verify leaseToken  │
│ - Advance next entry │ │ [outbox, meta,     │  │ - Backoff nextRetryAt│
│   baseServerVersion  │ │  conflicts]        │  │   or park 'blocked'  │
│ - Delete entry.id    │ │ - Block entry      │  └──────────────────────┘
└──────────────────────┘ │ - Save 3-way record│
                         └────────────────────┘
```

---

## 3. Atomic Server CAS & Idempotency (`executeAtomicMutation`)

Rather than issuing separate client-side `SELECT processed_mutations`, table `UPDATE`, and `INSERT processed_mutations` requests, all four adapters invoke `executeAtomicMutation()` (`src/lib/sync/adapters/idempotency.ts`):

```typescript
// 1. Fail-closed client baseline check for 'update' and 'delete':
const baseVersion =
  entry.operation === 'update' || entry.operation === 'delete'
    ? requireValidCasBaseVersion(entry) // throws MissingCasBaselineError (422) if null or < 1
    : null;

// 2. Single-transaction PostgreSQL RPC:
const { data, error } = await withTimeout(
  supabase.rpc('apply_sync_mutation', {
    p_mutation_id: entry.mutationId,
    p_user_id: entry.userId,
    p_entity_type: entry.entityType,
    p_entity_id: entry.entityId,
    p_operation: entry.operation,
    p_project_id: entry.projectId,
    p_payload: payload,
    p_base_version: baseVersion,
  }),
  TRANSPORT_TIMEOUT_MS
);
```

When `data.status === 'conflict'`, `executeAtomicMutation` throws a structured `409 CONFLICT` error carrying `conflictReason` (`'version_mismatch' | 'remote_deleted' | 'already_exists'`), `remoteVersion` (`data.current_version`), and `remoteSnapshot` (`data.current_row`). If the RPC itself is missing (`PGRST202` / `42883`), it fails closed as a non-retryable `SCHEMA_ERROR` rather than falling back to unguarded writes.

---

## 4. Fenced Revision-Safe Acknowledgements

In rapid editing sessions, a user may make an additional edit (Revision $N+1$, appended as a new causal outbox entry because Revision $N$ had `dispatched: true`) while Revision $N$ is in flight over the network.

`SyncEngine` finalizes push success inside a **single atomic Dexie transaction** across `[db.outbox, db.sync_metadata]`:

```typescript
await this.db.transaction('rw', [this.db.outbox, this.db.sync_metadata], async () => {
  const currentEntry = await this.db.outbox.get(entry.id);
  // Fence out stale completions if lease was reclaimed by another tab
  if (!currentEntry || currentEntry.leaseToken !== claimedLeaseToken) {
    return;
  }

  // Delete only the acknowledged outbox entry
  await this.db.outbox.delete(entry.id);

  // Propagate the new serverVersion onto the next causal pending entry for this entity
  const remaining = await this.outboxRepo.getByEntity(entry.entityType, entry.entityId, entry.userId);
  for (const nextEntry of remaining) {
    if (nextEntry.baseServerVersion === null || nextEntry.baseServerVersion === entry.baseServerVersion) {
      await this.db.outbox.update(nextEntry.id, { baseServerVersion: serverVersion });
    }
  }

  // Keep syncState 'pending' if newer local revisions or chained outbox entries remain
  const hasNewerWork = remaining.length > 0 || currentEntityRevision > entry.localRevision;
  await this.syncMetadataRepo.upsert({
    entityId: entry.entityId,
    entityType: entry.entityType,
    userId: entry.userId,
    serverVersion,
    lastAckedMutationId: entry.mutationId,
    syncState: hasNewerWork ? 'pending' : (entry.operation === 'delete' ? 'deleted_synced' : 'synced'),
  });
});
```

---

## 5. Error Taxonomy & Retry Strategy

Defined in `src/lib/sync/errorTaxonomy.ts` (`classifySyncError`):

| Error Code / Category | HTTP Status / PG Code | SyncEngine Action |
|---|---|---|
| **`CONFLICT`** (`conflict`) | `409` / `23505` (Unique) | Atomic transaction across `[outbox, sync_metadata, conflicts]`: mark outbox entry `blocked`, record `ConflictRecord`, set `syncState = 'conflict'`. |
| **`AUTH_EXPIRED`** (`auth`) | `401` / `PGRST301` | Release entry back to `pending`, pause sync loop, and prompt non-destructive re-authentication. |
| **`FORBIDDEN`** (`auth`) | `403` / `42501` (RLS) | Non-retryable permission violation; park outbox entry in `blocked`. |
| **`RATE_LIMITED`** (`transient`) | `429` (`Retry-After`) | Retryable; honors `Retry-After` header (`parseRetryAfterMs`, capped at `MAX_SYNC_BACKOFF_MS = 300_000`ms) and **never** exhausts `maxRetries` into `blocked`. |
| **`NETWORK_ERROR` / `REQUEST_TIMEOUT` / `SERVER_ERROR`** (`transient`) | `5xx` / `ETIMEDOUT` | Retryable with exponential backoff `min(1000 * 2^(attempt-1), 30000)` + 0–500ms jitter (`nextRetryAt`); parks in **`blocked`** after `maxRetries = 5`. |
| **`TIER_LIMIT_EXCEEDED`** (`quota`) | `P0001` (`check_plan_tier_limit`) | Non-retryable plan limit rejection; parks entry in **`blocked`** and surfaces Upgrade + Retry CTA in `SyncStatusBanner`. |
| **`STORAGE_QUOTA`** (`quota`) | `DOMException: QuotaExceededError` | Local IndexedDB quota exhaustion; halts sync batch cleanly and notifies `onStorageQuotaExceeded`. |
| **`VALIDATION_FAILED` / `UNRESOLVED_CONFLICT_MARKERS` / `SCHEMA_ERROR`** (`validation` / `permanent`) | `400` / `422` / `22023` / `PGRST202` | Non-retryable; parks entry in **`blocked`** for user/operator inspection via `SyncStatusBanner`. |
