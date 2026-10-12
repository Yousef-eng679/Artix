# Artix Truth Reconciliation Report
**Codebase vs. Migrations vs. Tests vs. Historical Documentation Audit**

---

## 1. Executive Summary

This audit reconciles contradictions and terminology drifts found between early architectural plans, intermediate review notes, and the verified **post-C12** implementation in `c:\Fenix-main`. 

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
  - `20260928120000_server_concurrency_protocol.sql`:
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
    - Push adapters (`documentPushAdapter.ts`, `folderPushAdapter.ts`, `systemDesignPushAdapter.ts`) perform an **optimistic CAS DELETE**:
      ```sql
      DELETE FROM documents WHERE id = :id AND version = :baseServerVersion;
      ```
    - The PostgreSQL trigger `record_sync_change()` captures this `AFTER DELETE` and writes an audit row to `public.sync_changes` with `operation = 'delete'` and the final `entity_version`.
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

### Target E: Idempotency & Exactly-Once Language
- **Contradiction in Prior Documentation**: Certain review documents loosely claimed "database-level distributed exactly-once transactions".
- **Actual Code Truth (`src/lib/sync/adapters/idempotency.ts`)**:
  - The client generates a durable UUID v4 `mutationId` when the mutation is first enqueued.
  - The push adapter checks `processed_mutations` for this `mutationId`. If found, it returns the prior acknowledgement without executing duplicate database modifications.
  - If not found, it applies the mutation and then records the `mutationId` into `processed_mutations`.
  - This is an **application-level idempotency ledger pattern**, not a distributed two-phase commit (2PC) or distributed transactional atomic lock.
- **Documentation Standard**: Use rigorous terminology: "At-least-once transport with durable mutation identity ledger ensuring idempotent logical execution."

---

### Target F: Supabase Realtime Role
- **Contradiction in Prior Documentation**: Early architecture notes described Realtime as the primary vehicle for synchronizing remote data.
- **Actual Code Truth (`src/lib/sync/realtimeSync.ts`, `pullEngine.ts`)**:
  - Supabase Realtime broadcast channels act purely as a **wake-up / acceleration trigger**.
  - When an event is received, `RealtimeSyncManager` debounces (150ms) and invokes `syncEngine.triggerSync(userId, { reason: 'realtime' })`.
  - The synchronization correctness boundary is governed strictly by the **durable change-feed cursor** in `PullEngine`, which range-queries `sync_changes` where `sequence > lastCursor`.
  - If Realtime disconnects, drops packets, or is blocked by network firewalls, the system still converges with 100% correctness via pull (Scenario I verification).
- **Documentation Standard**: Always document Realtime as an optional latency optimizer and wake-up signal; `PullEngine` change-feed cursor is the primary correctness authority.

---

### Target G: User Scoping vs. Cryptographic Security Boundaries
- **Contradiction in Prior Documentation**: Early notes described user-scoped IndexedDB naming as a "client-side cryptographic partition".
- **Actual Code Truth (`src/lib/local/db.ts`)**:
  - `getUserScopeHash(userId)` computes an FNV-1a 32-bit hash used as a namespace for database naming (`ArtixDB_v2_<hash>`).
  - This is a **local storage separation and lifecycle management mechanism**, not encryption or cryptographic isolation.
  - True cryptographic security is provided by:
    1. **Supabase RLS & JWTs**: PostgreSQL Row Level Security checks `auth.uid() = user_id` for all network requests.
    2. **Client-Side Key Encryption (`src/lib/ai/crypto.ts`)**: User-supplied third-party AI keys (OpenAI, Anthropic, Gemini) are encrypted using PBKDF2 (100,000 iterations) and AES-GCM 256-bit with user passphrases in `localStorage`.
- **Documentation Standard**: Categorize `getUserScopeHash` as namespace separation, and accurately locate cryptographic boundaries at RLS and BYOK client encryption.
