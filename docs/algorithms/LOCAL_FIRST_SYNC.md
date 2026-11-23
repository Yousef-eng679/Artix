# Local-First Synchronization Architecture & Failure Modes

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/sync/syncEngine.ts`, `src/lib/sync/pullEngine.ts`, `src/test/sync/correctnessMatrix.test.ts`, `src/test/sync/controllableFakeServerFaultInjection.test.ts`, `src/test/postgres/backendConcurrencyAndRls.pg.test.ts`, `tests/e2e/offlineColdStartAndSyncMatrix.spec.ts`

---

## 1. Overview & Core Invariants

Artix implements a formal synchronization protocol between client-side Dexie IndexedDB instances (`ArtixDB` v3) and a central Supabase PostgreSQL 17 database across 4 synced entities (`projects`, `workspace_folders`, `documents`, `system_designs`). Synchronization is governed by eight core invariants:

1. **Local Durability Invariant**: Every mutation accepted by the UI is committed to local persistent storage before the user operation returns.
2. **Monotonic Version Invariant**: Every state update on the server increments the entity version strictly monotonically:
   $$\text{version}_{t+1} > \text{version}_t$$
3. **Commit-Ordered Change-Feed Sequence Invariant**: `record_sync_change()` acquires a per-user transaction advisory lock (`pg_advisory_xact_lock`) before inserting into `public.sync_changes`, ensuring `sequence` order strictly equals PostgreSQL commit order.
4. **Monotonic Cursor & Retention-Floor Invariant**: The client pull cursor (`database_meta['server_cursor']`) never decreases ($\text{cursor}_{t+1} \ge \text{cursor}_t$). If a device's cursor falls below `sync_retention_state.min_retained_sequence`, `PullEngine.resnapshotAll()` re-hydrates live tables non-destructively before advancing the cursor.
5. **Strict CAS Baseline Invariant**: Every `update` or `delete` mutation requires an explicit positive integer `baseServerVersion >= 1` (`MissingCasBaselineError` client-side; `apply_sync_mutation` server-side). Legacy null baselines are healed pre-push via `reconcileMissingCasBaseline()`.
6. **Pending-State & Self-Echo Protection Invariant**: A remote change downloaded from the network may NEVER overwrite a local entity that has unpushed pending mutations with different content. Self-echoes identified by `change.mutation_id` are acknowledged without overwriting newer local revisions.
7. **Idempotent Atomic RPC Invariant**: Re-submitting an outbox entry with the same `mutationId` to `public.apply_sync_mutation` returns the prior ledger result (`status: 'already_processed'`) inside the same transaction without duplicating side effects.
8. **Lease-Token Fencing Invariant**: Every `in_flight` claim generates a UUID `leaseToken` and marks `dispatched: true`. Push acknowledgement and failure transactions verify `current.leaseToken === claimedLeaseToken` so a slow zombie tab cannot corrupt reclaimed state.

---

## 2. The Local Write Pipeline

```text
User Action (Create/Edit Project, Folder, Document, or System Design)
                         │
                         ▼
        Repository Method (`update`, `create`, `delete`)
        (Validates `expectedLocalRevision` -> throws `StaleBufferError` if stale)
                         │
                         ▼
     ┌────────────────────────────────────────────────────────┐
     │           Atomic Dexie Transaction Begins              │
     │      db.transaction('rw', [entities, outbox, meta])    │
     └───────────────────────────┬────────────────────────────┘
                                 │
         ┌───────────────────────┼────────────────────────┐
         ▼                       ▼                        ▼
 1. Write Entity State   2. Enqueue Outbox        3. Update Metadata
 - content / name        - Compacts only if tail  - syncState: 'pending'
 - localRevision += 1      is pending &           - localRevision
 - updatedAt: now()        !dispatched            - lastModifiedAt
                         - mutationId (UUID v4)
                         - baseServerVersion
                                 │
                                 ▼
     ┌────────────────────────────────────────────────────────┐
     │     Local Commit Succeeds -> tx.on('complete')         │
     │     UI Updates Reactively & Outbox Wakeup Fires        │
     └───────────────────────────┬────────────────────────────┘
                                 │
                                 ▼
     ┌────────────────────────────────────────────────────────┐
     │            TabCoordinator.broadcastChange()            │
     │   Notifies Peer Tabs with real `localRevision`         │
     └───────────────────────────┬────────────────────────────┘
                                 │
                                 ▼
     ┌────────────────────────────────────────────────────────┐
     │             Background Sync Triggered                  │
     │    Leader Tab Drains Outbox to Cloud via SyncEngine    │
     └────────────────────────────────────────────────────────┘
```

*(Note: `FolderRepository.delete` spans a 5-table atomic cascade transaction; `ProjectRepository.delete` spans a 6-table atomic cascade transaction across `[projects, documents, system_designs, workspace_folders, outbox, sync_metadata]`.)*

---

## 3. Exhaustive Distributed Failure Modes & Recovery Matrix

The Artix synchronization protocol is verified across `src/test/sync/correctnessMatrix.test.ts` and `src/test/sync/controllableFakeServerFaultInjection.test.ts`:

| Scenario ID | Failure Description | Runtime Behavior & Mitigation | Verified Test Suite |
|---|---|---|---|
| **Scenario A** | **Local Durability Across Restart**: User creates or edits entities while offline, then reloads or closes browser before reconnecting. | Mutations, local revisions, and outbox entries persist in IndexedDB (`ArtixDB_v2_<hash>`). Upon re-opening (even offline with an expired JWT), all drafts are intact and queued for push. | `correctnessMatrix.test.ts` (Scenario A), `offlineColdStartAndSyncMatrix.spec.ts` |
| **Scenario B** | **Ambiguous Remote Result / Dropped Response**: Client sends push mutation to server; server commits transaction, but network drops before response reaches client. | Client retries with identical `mutationId`. `public.apply_sync_mutation` checks `processed_mutations` under an advisory lock and returns `'already_processed'` with the recorded version. | `correctnessMatrix.test.ts` (Scenario B), `controllableFakeServerFaultInjection.test.ts` |
| **Scenario C** | **Concurrent Edit / Stale Base Version**: Device A and Device B start from version 10. Device A pushes version 11. Device B pushes with `baseServerVersion = 10`. | `apply_sync_mutation` detects the version mismatch and returns `{ status: 'conflict', reason: 'version_mismatch', current_row }`. Outbox entry is marked `blocked` and a 3-way conflict snapshot is saved in `ConflictRepository` in one atomic Dexie transaction. | `correctnessMatrix.test.ts` (Scenario C) |
| **Scenario D** | **Local Edit During In-Flight Push**: Client claims revision $N$ (`dispatched: true`). While HTTP request is in flight, user types revision $N+1$. Server ack or pull self-echo for $N$ arrives. | Because $N$ is marked `dispatched: true`, edit $N+1$ appends as a new causal outbox entry rather than mutating $N$. When $N$ is acknowledged (or self-echoed with `mutation_id`), $N+1$'s `baseServerVersion` advances to $N$'s new server version while local entity state stays `pending` at $N+1$. | `correctnessMatrix.test.ts` (Scenario D), `dispatchedSelfEchoAndCausalBarrier.test.ts` |
| **Scenario E** | **Remote Stale/Concurrent Snapshot Arrival**: While local entity has unpushed edits, a background pull downloads a remote change from another device. | `PullEngine` checks `change.mutation_id` (not a self-echo) and inspects the outbox for active entries. It rejects the overwrite, records a 3-way conflict (`version_mismatch` or `remote_deleted`), and marks the outbox entry `blocked`. | `correctnessMatrix.test.ts` (Scenario E) |
| **Scenario F** | **Remote Deletion of Entity**: Entity is deleted on server by another device while local client is offline. Client reconnects. | Client pulls `operation: 'delete'` from `public.sync_changes`. If no local edits are pending, `PullEngine` sets `isDeleted: true` and `syncState: 'deleted_synced'` without enqueuing an outbox entry. If local edits are pending, a `remote_deleted` conflict is recorded. | `correctnessMatrix.test.ts` (Scenario F) |
| **Scenario G** | **Leader Tab Crash Mid-Push & Zombie Leader Fencing**: Leader tab acquires outbox lease (`leaseToken`), sends network request, and stalls or crashes. | Standby tab acquires leadership via Web Locks, reclaims expired leases (`30,000ms` TTL) with a new `leaseToken`, and drains the outbox. Any late response from a zombie tab is fenced out by `leaseToken` verification. | `correctnessMatrix.test.ts` (Scenario G), `atomicPushAckAndLeaseTokenFencing.test.ts` |
| **Scenario H** | **Account Switch / Multi-Tenant Isolation**: User A logs out while sync is active; User B logs in immediately on the same machine. | `closeUserRuntime` stops Realtime, aborts sync timers, evicts `TabCoordinator` and `SyncEngine`, closes `ArtixDB_v2_<hash_A>`, clears `QueryClient` and `dirtyTracker`, and purges sensitive caches before mounting `ArtixDB_v2_<hash_B>`. | `correctnessMatrix.test.ts` (Scenario H), `multiAccountEvictionAndStorageScope.test.tsx` |
| **Scenario I** | **Complete Realtime Outage**: Supabase Realtime WebSocket connection drops or is blocked by network firewall. | System falls back seamlessly to durable cursor polling on `public.sync_changes` + debounced outbox-enqueue wakeups and scheduled retry timers (`nextRetryAt`). | `correctnessMatrix.test.ts` (Scenario I) |
| **Scenario J** | **Duplicate Event & Pruned Cursor Recovery**: Network delivers duplicate change events or device reconnects after 30-day feed pruning. | Changes where `sequence <= server_cursor` are ignored; if `server_cursor < min_retained_sequence`, `PullEngine.resnapshotAll()` re-hydrates live tables before resuming incremental pulls. | `correctnessMatrix.test.ts` (Scenario J), `bootstrapHydrationAndRetentionFloor.test.tsx` |

---

## 4. End-to-End Replication Cycle Pseudocode

```python
# Push Cycle (SyncEngine)
def drain_outbox(user_id):
    if not tab_coordinator.is_leader():
        return

    outbox_repo.recover_stale_leases(now())
    # Per-entity causal barrier filters out entries behind in_flight/blocked/backoff predecessors
    entries = outbox_repo.get_pending(user_id=user_id, ready_only=True, now=now())
    sorted_entries = order_outbox_by_dependency(entries)

    for entry in sorted_entries:
        reconcile_missing_cas_baseline(entry)
        # 1. Acquire 30s lease with fencing token and sticky dispatched flag
        lease_token = outbox_repo.mark_in_flight(entry.id, tab_id, lease_duration_ms=30000)

        try:
            # 2. Single-transaction atomic RPC (idempotency ledger + strict CAS + sync_changes)
            result = execute_atomic_mutation(entry)
            # 3. Atomic Dexie ack transaction fenced by lease_token
            acknowledge_push_in_tx(entry, lease_token, result.server_version)

        except ConflictError as e:
            record_conflict_and_block_in_tx(entry, lease_token, e.remote_snapshot, e.reason)

        except SyncError as e:
            classified = classify_sync_error(e)
            # Parks in 'blocked' on non-retryable or maxRetries (5); honors 429 Retry-After (up to 300s)
            outbox_repo.mark_failed_in_tx(entry.id, classified, lease_token)
            schedule_next_retry_timer()

# Pull Cycle (PullEngine.syncPull)
def sync_pull(user_id):
    bounds = supabase.rpc('get_sync_feed_bounds')
    if not is_hydrated():
        return bootstrap_hydrate_all(user_id, bounds)

    last_seq = database_meta.get('server_cursor') or 0
    if last_seq < bounds.min_retained_sequence:
        return resnapshot_all(user_id, bounds)

    batch = (supabase.from('sync_changes')
                     .select('*')
                     .eq('user_id', user_id)
                     .gt('sequence', last_seq)
                     .order('sequence', ascending=True)
                     .limit(50))

    # Executed inside a single atomic 8-table Dexie transaction:
    for change in batch:
        if is_self_echo(change.mutation_id):
            acknowledge_self_echo_without_overwriting_newer_local(change)
        elif outbox_repo.has_conflicting_pending_mutation(change.entity_id):
            record_conflict_and_block(change)
        else:
            apply_remote_change_locally(change)
        database_meta.put('server_cursor', change.sequence)
    # Post-commit: notify local hooks and peer tabs with real localRevision
```
