# ADR-005: Durable Append-Only Change Feed & Sequence Cursor

- **Status**: `ACCEPTED` / `IMPLEMENTED`
- **Date**: 2026-09-27
- **Deciders**: Architecture Team
- **Related Files**: `supabase/migrations/20260928130000_durable_sync_changes.sql`, `supabase/migrations/20261020100000_commit_ordered_sync_changes.sql`, `supabase/migrations/20261101100000_expand_sync_protocol_and_projects.sql`, `supabase/migrations/20261101100200_sync_changes_retention_and_floor.sql`, `src/lib/sync/pullEngine.ts`, `src/test/sync/pullEngine.test.ts`

---

## Context

To keep multiple devices in sync, clients need to receive changes made on other devices. Naive approaches query entity tables with `WHERE updated_at > last_sync_time`. 

This timestamp-polling approach has severe drawbacks:
1. Clock skew between database servers and application layers can cause missed updates.
2. Deleted rows are omitted unless soft-delete columns are permanently retained in entity tables.
3. Rapid concurrent updates can share identical millisecond timestamps, creating ambiguous boundary queries.

---

## Decision

We decided to implement an **Append-Only Commit-Ordered Change Feed Log with Monotonic Sequence Cursors and Retention-Floor Recovery**:
1. A dedicated PostgreSQL table `public.sync_changes` captures all `create`, `update`, and `delete` operations across `project`, `document`, `system_design`, and `workspace_folder` via `record_sync_change()`, which takes a per-user `pg_advisory_xact_lock` so `sequence` order strictly equals commit order, and records root `mutation_id` for self-echo recognition.
2. The primary key is an auto-incrementing 64-bit integer (`sequence BIGINT GENERATED ALWAYS AS IDENTITY`).
3. Clients store a durable sequence cursor in `ArtixDB.database_meta` under `key = 'server_cursor'` (plus `'hydration_complete'`).
4. Pull requests check `public.get_sync_feed_bounds()` (`min_retained_sequence`, `max_sequence` from `public.sync_retention_state`), executing `bootstrapHydrateAll()` on first login, `resnapshotAll()` if `server_cursor < min_retained_sequence` after `prune_sync_changes()`, or incremental range scans (`WHERE user_id = :userId AND sequence > :cursor ORDER BY sequence ASC LIMIT 50`).
5. The local cursor advances inside the same 8-table atomic Dexie transaction as the batch's entity mutations.

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
- Requires maintaining the `sync_changes` table and periodically pruning historical logs via `public.prune_sync_changes()`, paired with client `resnapshotAll()` when a device's cursor falls below `sync_retention_state.min_retained_sequence`.

---

## Current Implementation

- `supabase/migrations/20260928130000_durable_sync_changes.sql`, `20261020100000_commit_ordered_sync_changes.sql`, `20261101100000_expand_sync_protocol_and_projects.sql`, `20261101100200_sync_changes_retention_and_floor.sql`
- `src/lib/sync/pullEngine.ts`
- Verified in `src/test/sync/pullEngine.test.ts`, `src/test/sync/pullCursorCommitOrder.test.ts`, `src/test/sync/bootstrapHydrationAndRetentionFloor.test.tsx`, `src/test/sync/correctnessMatrix.test.ts` (Scenario J), and `src/test/postgres/backendConcurrencyAndRls.pg.test.ts`.
