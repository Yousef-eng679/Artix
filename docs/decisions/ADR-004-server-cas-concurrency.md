# ADR-004: Optimistic Compare-and-Swap (CAS) Concurrency

- **Status**: `ACCEPTED` / `IMPLEMENTED`
- **Date**: 2026-09-27
- **Deciders**: Architecture Team
- **Related Files**: `supabase/migrations/20260928120000_server_concurrency_protocol.sql`, `supabase/migrations/20261020110000_atomic_idempotent_mutation_rpc.sql`, `supabase/migrations/20261101100000_expand_sync_protocol_and_projects.sql`, `supabase/migrations/20261101100100_contract_strict_cas_base_version.sql`, `src/lib/sync/adapters/idempotency.ts`, `src/test/sync/concurrencyCAS.test.ts`

---

## Context

When multiple clients (or multiple offline devices) modify the same document or system design concurrently, naive synchronization systems apply "Last-Write-Wins" (LWW) based on wall-clock timestamps. 

In engineering workstations, LWW is destructive: if Developer A edits Section 1 offline and Developer B edits Section 2 online, B's write can silently obliterate A's entire work upon A's reconnection.

---

## Decision

We decided to implement **Optimistic Compare-and-Swap (CAS) Concurrency**:
1. All 4 synchronizable tables in PostgreSQL (`projects`, `workspace_folders`, `documents`, `system_designs`) carry an integer `version` column, incremented automatically by database triggers on every update.
2. Push mutations carry a mandatory positive integer `baseServerVersion >= 1` for every `update` and `delete` (`requireValidCasBaseVersion()` throws `MissingCasBaselineError` client-side; `SyncEngine.reconcileMissingCasBaseline()` heals legacy null baselines pre-push).
3. All push adapters invoke the single-transaction PostgreSQL RPC `public.apply_sync_mutation` (`executeAtomicMutation` in `src/lib/sync/adapters/idempotency.ts`), which checks `processed_mutations`, executes `UPDATE/DELETE ... WHERE id = p_entity_id AND user_id = p_user_id AND version = p_base_version`, stamps `mutation_id` onto `sync_changes`, and records `processed_mutations` atomically.
4. If another device modified or deleted the entity in the interim, `apply_sync_mutation` returns `{ status: 'conflict', reason: 'version_mismatch' | 'remote_deleted' | 'already_exists', current_version, current_row }`.
5. The conflicting mutation is parked as `blocked`, and the system captures a 3-way `ConflictRecord` in one atomic Dexie transaction.

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

- `supabase/migrations/20260928120000_server_concurrency_protocol.sql`, `20261020110000_atomic_idempotent_mutation_rpc.sql`, `20261101100000_expand_sync_protocol_and_projects.sql`, `20261101100100_contract_strict_cas_base_version.sql`
- `src/lib/sync/adapters/{idempotency,projectPushAdapter,documentPushAdapter,systemDesignPushAdapter,folderPushAdapter}.ts`
- Verified by `src/test/sync/concurrencyCAS.test.ts`, `src/test/sync/correctnessMatrix.test.ts` (Scenario C), and `src/test/postgres/backendConcurrencyAndRls.pg.test.ts`.
