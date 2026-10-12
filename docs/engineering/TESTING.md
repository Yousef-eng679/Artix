# Testing Architecture & Verification Protocols

> **Status**: `IMPLEMENTED`  
> **Test Suite Count**: **81 test files passed (100%)**, **566 total tests green**

---

## 1. Testing Philosophy

In a local-first distributed system, testing individual functions in isolation is insufficient. The primary source of failure is **distributed asynchronous edge cases**: race conditions, network timeouts, offline edits, concurrent CAS mismatches, and multi-tab leadership changes.

Artix employs a multi-tiered testing strategy:
1. **Unit Tests**: Pure algorithms (diff3, FNV-1a hash, outbox compaction algebra, error taxonomy).
2. **Repository Integration Tests**: Atomic 3-table Dexie transactions on in-memory `fake-indexeddb`.
3. **Component Interaction Tests**: Testing-library renders with React Query and Context providers.
4. **Distributed Failure Matrix (`correctnessMatrix.test.ts`)**: 10 rigorous network and multi-tab simulation scenarios.

---

## 2. Test Execution Commands

```bash
# Run full Vitest test suite (all 81 test files)
npx vitest run

# Run specific test file in watch mode
npx vitest src/test/sync/correctnessMatrix.test.ts

# Run with coverage report
npx vitest run --coverage

# Type-check without compiling
npx tsc --noEmit

# Lint check
npm run lint
```

---

## 3. Test Infrastructure & Mocking Guidelines (`src/test/setup.ts`)

- **In-Memory IndexedDB**: Tests use `fake-indexeddb` to provide realistic, isolated IndexedDB databases in Node.js without disk pollution:
  ```typescript
  import 'fake-indexeddb/auto';
  ```
- **Web Locks Mock**: When running in Node.js, `TabCoordinator` falls back gracefully to single-process mode, with explicit `setLeaderForTesting(boolean)` helpers.
- **Supabase Mocking**: Tests mock Supabase REST builders (`from('table').select().eq()`) using spy functions, accurately simulating HTTP 200, 409 Conflict, and network timeout exceptions.

---

## 4. The 10 Distributed Failure Matrix Scenarios (`correctnessMatrix.test.ts`)

| Scenario | Modeled Failure Mode | Invariant Verified |
|---|---|---|
| **Scenario A** | Offline Create -> Edit -> Complete Database Restart | Local durability and revision monotonicity across browser restarts. |
| **Scenario B** | Network Drop After Server Commit (Lost Response) | Idempotent retry using `mutationId` against `processed_mutations`. |
| **Scenario C** | Concurrent Device Edits (Stale Baseline Version) | Server CAS mismatch detection, HTTP 409 throwing, outbox blocking, and 3-way conflict capture. |
| **Scenario D** | Local User Edit During In-Flight Network Push | Revision-safe acknowledgment: acknowledging revision $N$ does not clobber pending revision $N+1$. |
| **Scenario E** | Remote Stale Snapshot Arrives During Local Edit | Pending-state protection: remote change rejected from overwriting local unpushed draft. |
| **Scenario F** | Entity Deleted Remotely on Server | Reconnecting client pulls `operation: 'delete'`, marks entity `REMOTE_CONFIRMED_DELETE` locally without outbox push loop. |
| **Scenario G** | Leader Tab Crashes Mid-Push | Standby tab immediately claims expired lease and safely resumes synchronization. |
| **Scenario H** | User Logout Followed by Immediate Different User Login | Complete database teardown, zero cross-user cache leakage, isolated user database opened. |
| **Scenario I** | Total Supabase Realtime Outage | Cursor-based change feed pull guarantees 100% convergence without Realtime. |
| **Scenario J** | Duplicate Change Event Delivery | Monotonic sequence cursor filters out previously processed events. |
