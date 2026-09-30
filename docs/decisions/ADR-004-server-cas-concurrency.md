# ADR-004: Optimistic Compare-and-Swap (CAS) Concurrency

- **Status**: `ACCEPTED` / `IMPLEMENTED`
- **Date**: 2026-09-27
- **Deciders**: Architecture Team
- **Related Files**: `supabase/migrations/20260928120000_server_concurrency_protocol.sql`, `src/lib/sync/adapters/`, `src/test/sync/concurrencyCAS.test.ts`

---

## Context

When multiple clients (or multiple offline devices) modify the same document or system design concurrently, naive synchronization systems apply "Last-Write-Wins" (LWW) based on wall-clock timestamps. 

In engineering workstations, LWW is destructive: if Developer A edits Section 1 offline and Developer B edits Section 2 online, B's write can silently obliterate A's entire work upon A's reconnection.

---

## Decision

We decided to implement **Optimistic Compare-and-Swap (CAS) Concurrency**:
1. All synchronizable tables in PostgreSQL carry an integer `version` column, incremented automatically by database triggers on every update.
2. Push mutations carry the `baseServerVersion` held locally when the edit began.
3. Push adapters execute updates with `.eq('version', baseServerVersion)`.
4. If another device modified the entity in the interim, the version will not match. The query modifies 0 rows, and the push adapter detects this and throws an HTTP `409 CONFLICT`.
5. The conflicting mutation is marked `blocked`, and the system captures a 3-way conflict.

---

## Alternatives Considered

1. **Wall-Clock Last-Write-Wins (LWW)**:
   - *Why rejected*: Client clock skew can corrupt causality, and concurrent work is silently lost.
2. **Pessimistic Cloud Locks (Row-Level Locking over WebSockets)**:
   - *Why rejected*: Incompatible with offline-first design. If a user loses connection while holding a lock, other users are blocked indefinitely.
3. **Full Operational Transformation (OT) or CRDTs**:
   - *Why rejected*: Excessive complexity and overhead for visual node canvases and coarse-grained technical specifications. 3-way merge (`diff3`) provides superior transparency for technical documentation.

---

## Consequences

### Positive
- Guaranteed protection against silent Lost Updates.
- Mathematical certainty of server causality.
- Clean separation between automatic updates and conflict capture.

### Negative / Tradeoffs
- Requires clients to track and monotonically propagate `baseServerVersion` across sequential offline edits.

---

## Current Implementation

- `supabase/migrations/20260928120000_server_concurrency_protocol.sql`
- `src/lib/sync/adapters/documentPushAdapter.ts`
- Verified by `src/test/sync/concurrencyCAS.test.ts` and `src/test/sync/correctnessMatrix.test.ts` (Scenario C).
