# Local-First Synchronization Architecture & Failure Modes

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/sync/syncEngine.ts`, `src/lib/sync/pullEngine.ts`, `src/test/sync/correctnessMatrix.test.ts`

---

## 1. Overview & Core Invariants

Artix implements a formal synchronization protocol between client-side Dexie IndexedDB instances and a central Supabase PostgreSQL database. Synchronization is governed by five fundamental mathematical invariants:

1. **Local Durability Invariant**: Every mutation accepted by the UI is committed to local persistent storage before the user operation returns.
2. **Monotonic Version Invariant**: Every state update on the server increments the entity version strictly monotonically:
   $$\text{version}_{t+1} > \text{version}_t$$
3. **Monotonic Cursor Invariant**: The client pull cursor sequence never decreases:
   $$\text{cursor}_{t+1} \ge \text{cursor}_t$$
4. **Pending-State Protection Invariant**: A remote change downloaded from the network may NEVER overwrite a local entity that has unpushed pending mutations with different content.
5. **Idempotent Retry Invariant**: Re-submitting an outbox entry with the same `mutationId` produces the identical server acknowledgement without duplicating database side effects.

---

## 2. The Local Write Pipeline

```text
User Action (Edit Document / Move Node / Create Folder)
                         │
                         ▼
        Repository Method (`update`, `create`, `delete`)
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
 - content / title       - mutationId (UUID v4)   - syncState: 'pending'
 - localRevision += 1    - operation: 'update'    - localRevision
 - updatedAt: now()      - baseServerVersion      - lastModifiedAt
                         - payload snapshot
                                 │
                                 ▼
     ┌────────────────────────────────────────────────────────┐
     │              Local Commit Succeeds (0ms)               │
     │              UI Updates Reactively                     │
     └───────────────────────────┬────────────────────────────┘
                                 │
                                 ▼
     ┌────────────────────────────────────────────────────────┐
     │            TabCoordinator.broadcastChange()            │
     │       Notifies Peer Tabs via BroadcastChannel          │
     └───────────────────────────┬────────────────────────────┘
                                 │
                                 ▼
     ┌────────────────────────────────────────────────────────┐
     │             Background Sync Triggered                  │
     │    Leader Tab Drains Outbox to Cloud via SyncEngine    │
     └────────────────────────────────────────────────────────┘
```

---

## 3. Exhaustive Distributed Failure Modes & Recovery Matrix

The Artix synchronization protocol is hardened against distributed edge cases, as verified in `src/test/sync/correctnessMatrix.test.ts`:

| Scenario ID | Failure Description | Runtime Behavior & Mitigation | Verified Test Suite |
|---|---|---|---|
| **Scenario A** | **Local Durability Across Restart**: User creates or edits documents while offline, then reloads or closes browser before reconnecting. | Mutations, local revisions, and outbox entries persist in IndexedDB. Upon re-opening database, all drafts are intact and queued for push. | `correctnessMatrix.test.ts` (Scenario A) |
| **Scenario B** | **Ambiguous Remote Result / Dropped Response**: Client sends push mutation to server; server commits transaction, but network drops before response reaches client. | Client retries with identical `mutationId`. Server push adapter inspects `processed_mutations` ledger, detects previous execution, and returns prior acknowledgement without re-applying mutation. | `correctnessMatrix.test.ts` (Scenario B) |
| **Scenario C** | **Concurrent Edit / Stale Base Version**: Device A and Device B start from version 10. Device A pushes version 11. Device B pushes with `baseServerVersion = 10`. | Server CAS predicate detects version mismatch and returns 0 modified rows. Push adapter raises HTTP `409 CONFLICT`. Outbox entry is marked `blocked`. 3-way conflict snapshot is saved in `ConflictRepository`. | `correctnessMatrix.test.ts` (Scenario C) |
| **Scenario D** | **Local Edit During In-Flight Push**: Client pushes revision $N$. While HTTP request is in flight, user types revision $N+1$. Server ack for $N$ arrives. | Push acknowledgment verifies `entry.localRevision === entity.localRevision`. Since local state is now $N+1$, acknowledgment refreshes `serverVersion` but keeps entity state as `pending`. Outbox entry for $N+1$ is retained. | `correctnessMatrix.test.ts` (Scenario D) |
| **Scenario E** | **Remote Stale Snapshot Arrival**: While local entity has unpushed edits, a background pull downloads an older or concurrent remote snapshot. | `PullEngine` inspects outbox for active entries matching `entityId`. Detects uncommitted local work, rejects remote overwrite, logs a conflict, and marks outbox `blocked`. | `correctnessMatrix.test.ts` (Scenario E) |
| **Scenario F** | **Remote Deletion of Entity**: Entity is deleted on server by another device while local client is offline. Client reconnects. | Client pulls change event `operation: 'delete'` from `public.sync_changes`. `TombstoneManager` marks entity as `REMOTE_CONFIRMED_DELETE` locally. No push mutation is enqueued. | `correctnessMatrix.test.ts` (Scenario F) |
| **Scenario G** | **Leader Tab Crash Mid-Push**: Leader tab acquires outbox lease, sends network request, and crashes immediately before acknowledgement. | Standby tab detects expired lease (`leaseExpiresAt < Date.now()`). Reclaims lease back to `pending` and takes over cloud push with identical `mutationId`. | `correctnessMatrix.test.ts` (Scenario G) |
| **Scenario H** | **Account Switch / Multi-Tenant Isolation**: User A logs out while sync is active; User B logs in immediately on the same machine. | `openUserRuntime` detects user change, halts User A runtime, unsubscribes Realtime, closes User A database, and mounts User B's isolated database (`ArtixDB_v2_<hash_B>`). Zero cross-user data leakage. | `correctnessMatrix.test.ts` (Scenario H) |
| **Scenario I** | **Complete Realtime Outage**: Supabase Realtime WebSocket connection drops or is blocked by network firewall. | System falls back seamlessly to durable cursor polling on `public.sync_changes`. When connection returns, client pulls from last sequence. Complete convergence achieved without Realtime. | `correctnessMatrix.test.ts` (Scenario I) |
| **Scenario J** | **Duplicate Event Delivery**: Network delivers the same remote change feed event multiple times. | `PullEngine` tracks monotonic sequence cursor. Changes where `sequence <= last_synced_sequence` are filtered and discarded as no-ops. | `correctnessMatrix.test.ts` (Scenario J) |

---

## 4. End-to-End Replication Cycle Pseudocode

```python
# Push Cycle (SyncEngine)
def drain_outbox(user_id):
    if not tab_coordinator.is_leader():
        return
    
    entries = outbox_repo.get_pending(user_id)
    sorted_entries = topological_sort_dag(entries)
    
    for entry in sorted_entries:
        # 1. Acquire lease
        entry.state = 'in_flight'
        entry.lease_owner = tab_id
        entry.lease_expires_at = now() + 15000
        outbox_repo.update(entry)
        
        try:
            # 2. Check Idempotency Ledger
            cached = check_idempotency(entry)
            if cached:
                acknowledge_push(entry, cached.version)
                continue
                
            # 3. Push to Supabase with CAS Guard
            result = adapter.push(entry)
            record_idempotency(entry, result)
            acknowledge_push(entry, result.version)
            
        except Conflict409Error as e:
            entry.state = 'blocked'
            outbox_repo.update(entry)
            record_3way_conflict(entry, e.remote_snapshot)
            
        except NetworkTimeoutError:
            entry.state = 'pending'
            entry.attempt_count += 1
            entry.updated_at = now() + exponential_backoff(entry.attempt_count)
            outbox_repo.update(entry)

# Pull Cycle (PullEngine)
def pull_changes(user_id):
    last_seq = sync_metadata.get_cursor(user_id)
    batch = supabase.from('sync_changes')
                    .select('*')
                    .eq('user_id', user_id)
                    .gt('sequence', last_seq)
                    .order('sequence', ascending=True)
                    .limit(100)
    
    for change in batch:
        if outbox_repo.has_pending_mutation(change.entity_id):
            record_conflict(change)
            continue
            
        apply_remote_change_locally(change)
        advance_cursor(change.sequence)
```
