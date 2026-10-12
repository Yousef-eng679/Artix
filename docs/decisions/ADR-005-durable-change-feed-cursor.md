# ADR-005: Durable Append-Only Change Feed & Sequence Cursor

- **Status**: `ACCEPTED` / `IMPLEMENTED`
- **Date**: 2026-09-27
- **Deciders**: Architecture Team
- **Related Files**: `supabase/migrations/20260928130000_durable_sync_changes.sql`, `src/lib/sync/pullEngine.ts`, `src/test/sync/pullEngine.test.ts`

---

## Context

To keep multiple devices in sync, clients need to receive changes made on other devices. Naive approaches query entity tables with `WHERE updated_at > last_sync_time`. 

This timestamp-polling approach has severe drawbacks:
1. Clock skew between database servers and application layers can cause missed updates.
2. Deleted rows are omitted unless soft-delete columns are permanently retained in entity tables.
3. Rapid concurrent updates can share identical millisecond timestamps, creating ambiguous boundary queries.

---

## Decision

We decided to implement an **Append-Only Change Feed Log with Monotonic Sequence Cursors**:
1. A dedicated PostgreSQL table `public.sync_changes` captures all `create`, `update`, and `delete` operations via database triggers.
2. The primary key is an auto-incrementing 64-bit integer (`sequence BIGINT GENERATED ALWAYS AS IDENTITY`).
3. Clients store a durable `last_synced_sequence` cursor in IndexedDB.
4. Pull requests perform fast range scans: `WHERE user_id = :userId AND sequence > :cursor ORDER BY sequence ASC LIMIT 100`.
5. The local cursor advances ONLY after the local IndexedDB transaction commits.

---

## Alternatives Considered

1. **Timestamp-based Entity Polling (`updated_at > :lastSync`)**:
   - *Why rejected*: Unreliable ordering, clock skew vulnerabilities, and high database scanning overhead.
2. **Postgres Logical Decoding (CDC via Debezium or Wal2json)**:
   - *Why rejected*: Requires dedicated infrastructure, heavy DevOps overhead, and is not directly accessible to client browsers over Supabase client libraries.

---

## Consequences

### Positive
- Strict, mathematically verifiable linear order of changes.
- Zero risk of dropped events due to clock drift.
- Deletions are captured naturally as change events without polluting entity tables.

### Negative / Tradeoffs
- Requires maintaining the `sync_changes` table and periodically pruning historical logs.

---

## Current Implementation

- `supabase/migrations/20260928130000_durable_sync_changes.sql`
- `src/lib/sync/pullEngine.ts`
- Verified in `src/test/sync/pullEngine.test.ts` and `src/test/sync/correctnessMatrix.test.ts` (Scenario J).
