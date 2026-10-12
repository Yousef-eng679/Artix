# ADR-002: User-Scoped IndexedDB Namespaces

- **Status**: `ACCEPTED` / `IMPLEMENTED`
- **Date**: 2026-09-25
- **Deciders**: Architecture Team
- **Related Files**: `src/lib/local/db.ts`, `src/lib/sync/userSyncRuntime.ts`, `src/test/local/userScopedDb.test.ts`

---

## Context

When multiple user accounts share the same physical computer or browser profile (e.g. logging out of a personal account and logging into a corporate account), storing all data in a single global `ArtixDB` database introduces catastrophic risks:
1. One user's cached documents could be inadvertently read by another user before cloud sync clears them.
2. Filter queries on `userId` might fail if software bugs omit a `where('userId').equals(...)` clause.
3. Database index scans degrade in performance as multi-tenant records accumulate locally.

---

## Decision

We decided to partition IndexedDB physical databases by user identity:
- Each user account receives a dedicated database named `ArtixDB_v2_<hash>`, where `<hash>` is an 8-character hex string derived from a deterministic 32-bit FNV-1a hash of the user's UUID.
- When an account switch occurs, the previous user's database is cleanly closed and evicted from memory before the new user's database is opened.

---

## Alternatives Considered

1. **Single Global Database with `userId` Compound Indexing**:
   - *Why rejected*: A single missed query filter could leak sensitive documents across user boundaries. Teardown on logout requires recursive deletion of thousands of rows rather than simply closing the database.
2. **Dynamic Client Encryption Key per User**:
   - *Why rejected*: Browser-based IndexedDB encryption requires Web Crypto overhead on every disk block, significantly reducing mobile performance while adding little protection against an attacker with root access to the browser process.

---

## Consequences

### Positive
- Strict physical separation of user data on client disk.
- O(1) instant account teardown on logout (close connection, no row-by-row deletions required).
- IndexedDB indices operate solely on single-tenant data, maximizing query speed.

### Negative / Tradeoffs
- Switching accounts requires instantiating a new database handle.

---

## Current Implementation

- `src/lib/local/db.ts`: `getUserScopeHash(userId)` and `getUserArtixDB(userId)`.
- Verified in `src/test/local/userScopedDb.test.ts` and `src/test/sync/correctnessMatrix.test.ts` (Scenario H).
