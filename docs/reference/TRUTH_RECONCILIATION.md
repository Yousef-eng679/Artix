# Artix Truth Reconciliation Report
**Codebase vs. Migrations vs. Tests vs. Historical Documentation Audit**

---

## 1. Executive Summary

This audit reconciles contradictions and terminology drifts found between early architectural plans, intermediate review notes, and the verified **`v2.5.0`** implementation. 

In accordance with Section 2 of the Artix Documentation Recovery Plan:
> **Source-of-Truth Hierarchy:** Code + Database Migrations + Tests take absolute precedence over intermediate design notes or historical AI execution artifacts.

---

## 2. Reconciled Contradiction Targets

### Target A: Multi-Tab Leader Election & Coordination
- **Contradiction in Prior Documentation**: Several intermediate planning documents (e.g. `docs/SYNC_FAILURE_MODES.md`, legacy `tabSync.ts` descriptions) described a 1-second interval heartbeat model (`HEARTBEAT` pings across BroadcastChannel) to elect and maintain a leader tab.
- **Actual Code Truth (`src/lib/sync/tabCoordinator.ts`)**:
  - Leader election uses the browser's native **Web Locks API** (`navigator.locks.request('artix_sync_leader_lock_<hash>', ...)`).
  - The lock is acquired exclusively by the first tab and held open indefinitely.
  - When the leader tab closes or crashes, the browser kernel immediately passes the lock to the next waiting tab, achieving **zero-latency leader failover**.
  - `BroadcastChannel` is used strictly for **event messaging**:
    - `ENTITY_CHANGED`: broadcasts local writes to peer tabs with a 3000ms deduplication cache filter.
    - `REQUEST_SYNC`: sent by standby tabs to prompt the leader tab to drain the outbox.
  - There are **no periodic leader election heartbeats**.
- **Documentation Standard**: All canonical documentation must describe the Web Locks API mechanism and BroadcastChannel event bus, omitting fictitious timer heartbeats.

---

### Target B: Server Version Column Types
- **Contradiction in Prior Documentation**: Protocol documents described all version numbers as 64-bit `BIGINT`, while some schema notes mentioned 32-bit `INTEGER`.
- **Actual Migration Truth (`supabase/migrations/`)**:
  - `20260928120000_server_concurrency_protocol.sql` & `20261101100000_expand_sync_protocol_and_projects.sql`:
    - `projects.version`: `INTEGER NOT NULL DEFAULT 1`
    - `documents.version`: `INTEGER NOT NULL DEFAULT 1`
    - `system_designs.version`: `INTEGER NOT NULL DEFAULT 1`
    - `workspace_folders.version`: `INTEGER NOT NULL DEFAULT 1`
  - `20260928130000_durable_sync_changes.sql`:
    - `sync_changes.entity_version`: `BIGINT NOT NULL`
    - `sync_changes.sequence`: `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
  - `20260928140000_idempotent_mutation_ledger.sql`:
    - `processed_mutations.version`: `BIGINT NULL`
- **Reconciliation Invariant**:
  - In PostgreSQL, `INTEGER` values safely cast and promote to `BIGINT`.
  - In client-side TypeScript (`src/lib/local/types.ts` & adapters), versions are serialized and parsed as `number` (or string representation) during CAS comparison.
- **Documentation Standard**: Canonical schemas must document the exact SQL types: `INTEGER` on entity tables, and `BIGINT` on `sync_changes` and `processed_mutations`.

---

### Target C: Delete & Tombstone Semantics
- **Contradiction in Prior Documentation**: Some early text described durable soft-deletes retaining deleted rows in the Supabase entity tables, while other text implied hard deletes.
- **Actual Code & Migration Truth**:
  - **Client-Side (Local IndexedDB)**:
    - Retains soft-delete tombstones (`isDeleted: true`, `deletedAt: timestamp`).
    - Handled by `TombstoneManager` (`src/lib/sync/tombstoneManager.ts`).
    - States: `LOCAL_PENDING_DELETE`, `REMOTE_CONFIRMED_DELETE`, `DELETED_SYNCED`.
    - Local tombstones prevent resurrection if stale network changes arrive.
    - Purged after a 30-day retention window.
  - **Server-Side (Supabase PostgreSQL)**:
    - All four push adapters (`projectPushAdapter.ts`, `documentPushAdapter.ts`, `folderPushAdapter.ts`, `systemDesignPushAdapter.ts`) invoke `public.apply_sync_mutation` (`20261020110000`, `20261101100000`, `20261101100100`), which executes a strict **CAS DELETE** requiring `p_base_version >= 1`:
      ```sql
      DELETE FROM public.documents AS d
       WHERE d.id = p_entity_id
         AND d.user_id = p_user_id
         AND d.version = p_base_version;
      ```
    - The PostgreSQL trigger `record_sync_change()` captures this `AFTER DELETE` and writes a commit-ordered audit row to `public.sync_changes` with `operation = 'delete'`, the final `entity_version`, and root `mutation_id`.
  - **Remote Change Feed Pull**:
    - Other devices pulling `sync_changes` receive `operation = 'delete'` and mark their local entity as `REMOTE_CONFIRMED_DELETE` via `TombstoneManager` without re-queuing into the outbox.
- **Documentation Standard**: Distinguish local soft-tombstones from server-side CAS table deletion and change-feed audit logging.

---

### Target D: Outbox State Names & Transitions
- **Contradiction in Prior Documentation**: Historical diagrams included conceptual states like `ACKNOWLEDGED` or `RETRY` inside the outbox table.
- **Actual Code Truth (`src/lib/local/types.ts`)**:
  - Outbox states are strictly defined by:
    ```typescript
    export type OutboxState = 'pending' | 'in_flight' | 'blocked' | 'failed';
    ```
  - When a push is successfully acknowledged, it is **deleted entirely** from the `outbox` table (`await db.outbox.delete(entry.id)`). There is no permanent `ACKNOWLEDGED` state in the database.
  - Temporary network failures do not write a `RETRY` state; the entry is transitioned back to `state: 'pending'` with an incremented `attemptCount` and an exponential backoff timestamp.
  - Permanent CAS conflicts transition the entry to `blocked` (with status `conflict` recorded in `ConflictRepository`).
- **Documentation Standard**: All state machine documentation must strictly adhere to `'pending' | 'in_flight' | 'blocked' | 'failed'`.

---

### Target E: Single-Transaction Server Idempotency & CAS (`apply_sync_mutation`)
- **Contradiction in Prior Documentation**: Early post-C12 notes described client push adapters issuing separate `SELECT processed_mutations`, entity `UPDATE`, and `INSERT processed_mutations` network calls (leaving a crash window between entity commit and ledger write, tracked as Audit F-003).
- **Actual Code & Migration Truth (`src/lib/sync/adapters/idempotency.ts`, `20261020110000`, `20261101100000`, `20261101100100`)**:
  - The client generates a durable UUID v4 `mutationId` when the mutation is first enqueued.
  - Push adapters call `executeAtomicMutation()` -> `supabase.rpc('apply_sync_mutation', ...)`.
  - Inside **one PostgreSQL transaction**, `public.apply_sync_mutation` acquires `pg_advisory_xact_lock(hashtextextended('artix.mutation:' || p_mutation_id::TEXT, 0))`, checks `public.processed_mutations`, sets transaction-local `artix.current_mutation_*` GUCs so `record_sync_change()` stamps `mutation_id` onto the root `sync_changes` row, executes the strict CAS mutation (`p_base_version >= 1`), and inserts the `processed_mutations` ledger row.
- **Documentation Standard**: Always describe push execution as a single-transaction PostgreSQL RPC (`public.apply_sync_mutation`) combining ledger idempotency, strict CAS, and `sync_changes` mutation correlation.

---

### Target F: Supabase Realtime Role & Retention-Floor Cursor Recovery
- **Contradiction in Prior Documentation**: Early architecture notes described Realtime as the primary vehicle for synchronizing remote data and used a 150ms debounce figure.
- **Actual Code Truth (`src/lib/sync/realtimeSync.ts`, `pullEngine.ts`, `20261101100200`)**:
  - Supabase Realtime broadcast channels act purely as a **wake-up / acceleration trigger** on the leader tab.
  - When an event is received, `RealtimeSyncManager` debounces with a **50ms** leading + trailing-edge window and invokes `syncEngine.triggerSync(userId)`.
  - The synchronization correctness boundary is governed strictly by `PullEngine.syncPull()`, which queries `get_sync_feed_bounds()` (`sync_retention_state.min_retained_sequence`), runs `bootstrapHydrateAll()` on first login or `resnapshotAll()` if the cursor (`database_meta['server_cursor']`) fell behind pruned history, and range-queries `sync_changes` where `sequence > lastCursor` (`LIMIT 50`).
  - Self-echoed changes matching `change.mutation_id` are acknowledged without overwriting newer local edits.
- **Documentation Standard**: Always document Realtime as a 50ms-debounced optional wakeup signal; `PullEngine` (`server_cursor` + `get_sync_feed_bounds`) is the correctness authority.

---

### Target G: User Scoping vs. Cryptographic Security Boundaries
- **Contradiction in Prior Documentation**: Early notes described user-scoped IndexedDB naming as a "client-side cryptographic partition".
- **Actual Code Truth (`src/lib/local/db.ts`)**:
  - `getUserScopeHash(userId)` computes an FNV-1a 32-bit hash used as a namespace for database naming (`ArtixDB_v2_<hash>`).
  - This is a **local storage separation and lifecycle management mechanism**, not encryption or cryptographic isolation.
  - True cryptographic security is provided by:
    1. **Supabase RLS & JWTs**: PostgreSQL Row Level Security checks `auth.uid() = user_id` for all network requests.
    2. **Client-Side Key Encryption (`src/lib/ai/crypto.ts`)**: User-supplied third-party AI keys (OpenAI, Anthropic, Gemini) are encrypted using PBKDF2 (600,000 iterations v:2; legacy v:1 250,000) and AES-GCM 256-bit with user passphrases in `localStorage`.
- **Documentation Standard**: Categorize `getUserScopeHash` as namespace separation, and accurately locate cryptographic boundaries at RLS and BYOK client encryption.
