# Artix Synchronization Failure Modes & Recovery Matrix

## 1. Overview
Distributed offline-first synchronization systems must treat partial failure, network ambiguity, concurrent client edits, crashes, and browser lifecycle anomalies as standard operational conditions rather than exceptions.

This document formalizes the complete taxonomy of synchronization failure modes, their detection mechanisms, and guaranteed recovery paths in Artix.

---

## 2. Failure Modes & Recovery Matrix

| # | Failure Mode | Scenario Description | Detection Mechanism | System Invariant & Recovery Action |
|:---:|:---|:---|:---|:---|
| **FM-01** | **Network Transport Timeout** | Request sent to Supabase hangs indefinitely due to network degradation or dropped TCP SYN/ACK packets. | Bounded 10,000ms `AbortController` timeout (`TimeoutError`). | The push adapter aborts with code `ETIMEDOUT`. `SyncEngine` marks the outbox entry `'failed'`, clears the lease, schedules exponential backoff (`nextRetryAt`), and leaves remaining queue items intact. |
| **FM-02** | **Lost Response (Ambiguous Mutation)** | Server successfully receives and commits the mutation, but the network response is lost before reaching the client. | Client times out and retries on subsequent sync cycle with identical `mutationId`. | The server's `processed_mutations` table recognizes the duplicate `mutation_id`. The server treats the retry idempotently, skips double-application, and returns an acknowledgement with the current version. |
| **FM-03** | **Leader Tab Crash During Push** | The active leader tab claims an outbox mutation, marks it `in_flight`, and terminates (browser tab crash or power loss). | In-flight lease expiry (`leaseExpiresAt < Date.now()`). | When a standby tab is promoted to leader (or on next application boot), `recoverStaleLeases()` executes within a Dexie transaction, resetting expired leases back to `'pending'` so work is never lost. |
| **FM-04** | **Concurrent Server Modification (CAS Collision)** | Two devices edit the same entity concurrently from identical baseline version $V_0$. Device A pushes first ($V_0 \to V_1$). Device B then pushes against $V_0$. | Server Compare-and-Swap SQL condition `WHERE id = $1 AND version = $2` affects 0 rows. | Push adapter raises HTTP 409 `ConflictError`. `SyncEngine` transitions outbox entry to `'conflict'`, preserves local edits without data loss, and invokes `ConflictResolver` (3-way diff3 merge for documents; divergence copies for canvas designs). |
| **FM-05** | **Local Edit During In-Flight Push** | Client initiates push for local revision $R_{10}$. While network request is in flight, user makes another edit locally, advancing entity to revision $R_{11}$. | Revision comparison on acknowledgement: `ack.localRevision !== entity.localRevision`. | The server's acknowledgement of $R_{10}$ updates `sync_metadata.serverVersion` to the server version, but the entity's `syncState` remains `'pending'` because local revision $R_{11}$ has not yet been pushed. |
| **FM-06** | **Stale Remote Observation Overwrite** | A stale remote snapshot arrives (via polling or delayed query) for an entity that has pending local outbox edits. | Pending mutation check in `applyRemoteSnapshot` and `PullEngine`. | Local unacknowledged user intent takes precedence. The stale remote snapshot is discarded or flagged for conflict analysis; it is NEVER allowed to overwrite local unacknowledged changes. |
| **FM-07** | **Missed Realtime Events (Extended Offline)** | Client remains offline for hours or days, missing ephemeral WebSocket notifications from Supabase Realtime. | Durable change feed sequence comparison: `sequence > server_cursor`. | Upon reconnect, `PullEngine` queries the persistent `sync_changes` table using its local `server_cursor`. All intermediate mutations and tombstones stream down sequentially in total order. |
| **FM-08** | **Account Switching / Logout Data Leakage** | User A logs out and User B logs in on the same browser device without clearing browser storage. | User-partitioned database naming (`ArtixDB_v2_<hash>`) and `UserSyncRuntime`. | `closeUserRuntime(userA)` stops background synchronization, closes User A's IndexedDB, and disconnects broadcast channels. User B's runtime opens a completely isolated database partition. Zero cross-user data leakage. |
| **FM-09** | **Topological Hierarchy Inversion** | User creates a folder and a child document while offline. Reconnection must not push child document before parent folder exists in cloud. | `TopologicalDependencySorter` ordering in `SyncEngine`. | Mutations are topologically sorted before draining: parent `workspace_folders` are strictly pushed prior to dependent `documents` and `system_designs`, avoiding foreign key constraint violations on the server. |
| **FM-10** | **Browser Storage Quota Exceeded** | IndexedDB write fails with `QuotaExceededError` due to local disk saturation. | Try/catch boundary in Dexie transactions and storage quota estimates. | Mutation fails cleanly with `StorageQuotaError`. System transitions to degraded read-only local mode, alerts the user, and halts new outbox queuing until storage is freed. |

---

## 3. Distributed Recovery Guarantees

1. **No Data Loss**: Local user mutations are durable immediately upon commit and will survive application restarts, network failures, and browser crashes.
2. **Deterministic Convergence**: Two replicas disconnected and reconnected will converge to the exact same state without human intervention unless an irreconcilable line conflict is encountered.
3. **Auditability**: Every conflict, failed lease, and retry attempt leaves a clear trace in `sync_metadata` and `conflicts` tables for debugging and user visibility.
