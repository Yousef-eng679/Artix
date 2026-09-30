# ADR-006: Web Locks API for Multi-Tab Leadership

- **Status**: `ACCEPTED` / `IMPLEMENTED`
- **Date**: 2026-09-28
- **Deciders**: Architecture Team
- **Related Files**: `src/lib/sync/tabCoordinator.ts`, `src/test/sync/tabCoordinator.test.ts`, `src/test/sync/leaderWorkerCorrectness.test.ts`

---

## Context

When users open multiple browser tabs of Artix, allowing all tabs to independently push to Supabase creates severe network contention:
1. Duplicate network requests are sent for the same outbox mutations.
2. Concurrent push attempts trigger false-positive 409 CAS conflicts.
3. Network quota is wasted.

We needed a multi-tab coordination mechanism that elects exactly one tab as the sync leader.

---

## Decision

We decided to use the native browser **Web Locks API** (`navigator.locks`) for single-leader election, combined with `BroadcastChannel` for inter-tab event messaging:
- The first tab to open requests an exclusive lock named `artix_sync_leader_lock_<userScope>` and holds it open indefinitely.
- Subsequent tabs queue on the lock request and remain in a Standby role.
- Standby tabs write freely to IndexedDB and send `REQUEST_SYNC` to the leader.
- When the leader tab closes or crashes, the browser kernel automatically and immediately grants the lock to the next standby tab with **zero latency**.

---

## Alternatives Considered

1. **BroadcastChannel Heartbeat Ping-Pong**:
   - *Why rejected*: Browsers aggressively throttle JavaScript timers (`setInterval`) in background or minimized tabs. A leader tab placed in the background would miss heartbeat deadlines, causing standby tabs to falsely declare it dead and create split-brain conditions.
2. **SharedWorker as Background Coordinator**:
   - *Why rejected*: Poor mobile browser support (Safari on iOS has historical limitations with SharedWorkers), complicated lifecycle, and difficult debugging in development environments.
3. **`localStorage` Timestamp Mutex**:
   - *Why rejected*: Fragile crash recovery. If a tab crashes while holding the mutex, all other tabs must wait for a conservative timeout (e.g. 5–10 seconds) before stealing the lock.

---

## Consequences

### Positive
- Zero timer throttling issues in background tabs.
- Instant, operating-system-level failover when leader tab closes.
- 100% reliable single-leader guarantee without split-brain risk.

### Negative / Tradeoffs
- Requires graceful fallback in Node.js unit testing environments where `navigator.locks` is absent.

---

## Current Implementation

- `src/lib/sync/tabCoordinator.ts`
- Verified in `src/test/sync/tabCoordinator.test.ts` and `src/test/sync/correctnessMatrix.test.ts` (Scenario G).
