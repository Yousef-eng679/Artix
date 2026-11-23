# Database Migrations & Schema Evolution Guide

> **Status**: `IMPLEMENTED`  
> **Version**: `v2.5.0`  
> **Verified Against**: `src/lib/local/db.ts`, `supabase/migrations/*` (all 25 SQL migrations)

---

## 1. Overview

Artix manages schema evolution across two storage engines:
1. **Client-Side IndexedDB Migrations**: Declaratively versioned in `ArtixDB` (`src/lib/local/db.ts`, `version(1)` through `version(3)`) alongside idempotent user-scoped migration (`migrateLegacyArtixDB`).
2. **Server-Side PostgreSQL Migrations**: 25 immutable timestamped SQL migrations in `supabase/migrations/`, employing an **Expand -> Contract** rollout discipline for zero-downtime protocol upgrades.

---

## 2. Client IndexedDB Migrations (`src/lib/local/db.ts`)

Each authenticated user receives a dedicated IndexedDB database named `ArtixDB_v2_<fnv1aHash(userId)>` (`ArtixDB_v2_anonymous` when unauthenticated). `ArtixDB` defines three cumulative schema versions across **8** object stores:

```typescript
export class ArtixDB extends Dexie {
  projects!: EntityTable<LocalProject, 'id'>;
  documents!: EntityTable<LocalDocument, 'id'>;
  system_designs!: EntityTable<LocalSystemDesign, 'id'>;
  workspace_folders!: EntityTable<LocalWorkspaceFolder, 'id'>;
  outbox!: EntityTable<OutboxEntry, 'id'>;
  sync_metadata!: EntityTable<SyncMetadata, 'id'>;
  conflicts!: EntityTable<ConflictRecord, 'id'>;
  database_meta!: EntityTable<DatabaseMeta, 'key'>;

  constructor(dbName = 'ArtixDB') {
    super(dbName);

    this.version(1).stores({
      documents: 'id, [userId+projectId], userId, projectId, folderId, localRevision, updatedAt, isDeleted',
      system_designs: 'id, [userId+projectId], userId, projectId, folderId, localRevision, updatedAt, isDeleted',
      workspace_folders: 'id, [userId+projectId], userId, projectId, parentFolderId, name, localRevision, updatedAt, isDeleted',
      outbox: 'id, [userId+entityType+entityId], userId, state, createdAt, localRevision',
      sync_metadata: 'id, [userId+entityType], userId, entityId, syncState, localRevision, lastSyncedAt',
      conflicts: 'id, [userId+entityType+entityId], detectedAt',
      database_meta: 'key, updatedAt',
    });

    this.version(2).stores({
      projects: 'id, userId, updatedAt, name',
      documents: 'id, [userId+projectId], userId, projectId, folderId, localRevision, updatedAt, isDeleted',
      system_designs: 'id, [userId+projectId], userId, projectId, folderId, localRevision, updatedAt, isDeleted',
      workspace_folders: 'id, [userId+projectId], userId, projectId, parentFolderId, name, localRevision, updatedAt, isDeleted',
      outbox: 'id, [userId+entityType+entityId], userId, state, createdAt, localRevision',
      sync_metadata: 'id, [userId+entityType], userId, entityId, syncState, localRevision, lastSyncedAt',
      conflicts: 'id, [userId+entityType+entityId], detectedAt',
      database_meta: 'key, updatedAt',
    });

    this.version(3)
      .stores({
        projects: 'id, userId, updatedAt, name, localRevision, isDeleted',
        documents: 'id, [userId+projectId], userId, projectId, folderId, localRevision, updatedAt, isDeleted',
        system_designs: 'id, [userId+projectId], userId, projectId, folderId, localRevision, updatedAt, isDeleted',
        workspace_folders: 'id, [userId+projectId], userId, projectId, parentFolderId, name, localRevision, updatedAt, isDeleted',
        outbox: 'id, [userId+entityType+entityId], userId, state, createdAt, localRevision',
        sync_metadata: 'id, [userId+entityType], userId, entityId, syncState, localRevision, lastSyncedAt',
        conflicts: 'id, [userId+entityType+entityId], detectedAt',
        database_meta: 'key, updatedAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table('projects')
          .toCollection()
          .modify((proj: Record<string, any>) => {
            if (typeof proj.localRevision !== 'number') proj.localRevision = 1;
            if (typeof proj.isDeleted !== 'boolean') proj.isDeleted = false;
          });
      });

    this.on('versionchange', () => {
      this.close();
    });

    this.on('blocked', () => {
      console.warn(`[ArtixDB] Database upgrade for ${dbName} is blocked by another open tab.`);
    });
  }
}
```

### Legacy Database Migration (`migrateLegacyArtixDB`)
When upgrading older clients from the pre-partitioned `'ArtixDB'` database into `ArtixDB_v2_<hash>`:
1. Queries **5** legacy stores filtered strictly by `.where('userId').equals(userId)`: `documents`, `system_designs`, `workspace_folders`, `outbox`, and `sync_metadata`.
2. Checks `targetDb.database_meta.get('legacy_migration')` inside an atomic read-write transaction across those stores plus `database_meta`; exits early if `value === 'completed'`.
3. **Heals missing CAS baselines**: Any legacy `update` or `delete` `outbox` entry lacking a valid positive integer `baseServerVersion` recovers its version from the corresponding `sync_metadata` record (`${entityType}:${entityId}`) so strict server CAS (`p_base_version >= 1`) does not reject migrated mutations.
4. Bulk-upserts all 5 stores and writes `{ key: 'legacy_migration', value: 'completed', updatedAt: Date.now() }` into `database_meta`.
5. Returns a structured `MigrationResult` (`{ success, migrated, recordsCount, error? }`), surfaced on `UserSyncRuntime.getStatus().migration`.

---

## 3. Server-Side PostgreSQL Migrations (`supabase/migrations/`)

All **25** migrations are applied sequentially in UTC timestamp order (verified continuously in CI by `npm run test:pg` against PostgreSQL 17):

| # | Migration File | Primary Schema & Security Changes |
|---|---|---|
| 1 | `20260202130240_55366476-dd84-40bf-a4fe-c7a4d81aec6f.sql` | Initial `public.documents` table, RLS policies, and `update_updated_at_column()` helper. |
| 2 | `20260203132019_be4ee7f2-288e-44a5-aca3-7044bbdc307a.sql` | Created `public.projects` and `public.system_designs` (`board_state JSONB`), plus `documents.project_id` FK and owner RLS. |
| 3 | `20260205164934_be2caf3d-02b9-4496-ba9e-61b6754504ba.sql` | Created `public.profiles` and `auth.users` signup trigger `public.handle_new_user()`. |
| 4 | `20260406004646_2d8d791e-b4b5-4ad4-8ecd-89cd422dd74d.sql` | Hardened `UPDATE` RLS policies with explicit `WITH CHECK (auth.uid() = user_id)` across `projects`, `documents`, `system_designs`, and `profiles`. |
| 5 | `20260617215902_1edd3e83-5ce7-4219-ab48-c63085e9d563.sql` | Created `public.prd_generations` history table and owner RLS policies. |
| 6 | `20260625003102_f3787ca0-c6d4-4304-b0a9-a00c42261766.sql` | Created `public.vibe_generations` history table and owner RLS policies. |
| 7 | `20260627063556_05ad88f8-8403-478f-a60a-deee51c6da31.sql` | Revoked direct `PUBLIC`/`anon`/`authenticated` `EXECUTE` privileges on trigger helper functions. |
| 8 | `20260628005230_7e31f474-3df3-4971-9d64-50d6c73867e4.sql` | Created `public.agentic_workflows` history table and owner RLS policies. |
| 9 | `20260722180000_stripe_billing.sql` | Created `public.subscriptions` (`plan_tier`, `status`, `billing_cycle`, `current_period_end`) and `public.stripe_events` idempotency ledger; updated `handle_new_user()`. |
| 10 | `20260723120000_enforce_tier_limits_trigger.sql` | Added `public.check_plan_tier_limit()` trigger enforcing plan caps on `projects`, `documents`, and `system_designs`. |
| 11 | `20260723130000_grant_admin_pro_tier.sql` | Historical administrative Pro-entitlement helper migration (superseded by RLS-protected `public.manual_grants` in `20261101100300`). |
| 12 | `20260724060000_add_missing_user_fk_constraints.sql` | Added `ON DELETE CASCADE` foreign keys to `auth.users(id)` across user-owned tables. |
| 13 | `20260919082427_add_missing_rls_policies.sql` | Completed `UPDATE`/`DELETE` owner RLS policy coverage across AI generation tables and profiles. |
| 14 | `20260923213000_workspace_folders.sql` | Created `public.workspace_folders`, composite `(folder_id, project_id)` FKs (`ON DELETE SET NULL`), and case-insensitive unique folder name index. |
| 15 | `20260928120000_server_concurrency_protocol.sql` | Added `version INTEGER NOT NULL DEFAULT 1`, `deleted_at TIMESTAMPTZ`, and `increment_entity_version()` triggers to `documents`, `system_designs`, and `workspace_folders`. |
| 16 | `20260928130000_durable_sync_changes.sql` | Created append-only `public.sync_changes` cursor feed and `record_sync_change()` triggers. |
| 17 | `20260928140000_idempotent_mutation_ledger.sql` | Created `public.processed_mutations` (`user_id`, `mutation_id` PK) for idempotent client push retries. |
| 18 | `20261020100000_commit_ordered_sync_changes.sql` | Serialized `record_sync_change()` sequence assignment via `pg_advisory_xact_lock` to eliminate out-of-order cursor visibility gaps (`F-001`). |
| 19 | `20261020110000_atomic_idempotent_mutation_rpc.sql` | Added `workspace_folders.parent_folder_id` and created atomic server CAS + idempotency RPC `public.apply_sync_mutation` (`F-003`). |
| 20 | `20261020120000_serialize_tier_limits_trigger.sql` | Added per-user `pg_advisory_xact_lock` inside `check_plan_tier_limit()` to prevent concurrent insert quota races (`F-006`). |
| 21 | `20261020130000_harden_security_definer_advisors.sql` | Pinned `SET search_path = public` and hardened `REVOKE`/`GRANT` rules on all `SECURITY DEFINER` functions (`SS-01`). |
| 22 | `20261101100000_expand_sync_protocol_and_projects.sql` | **Expand Phase**: Added `projects.version` + `projects.deleted_at` + triggers, added `sync_changes.mutation_id` + `'project'` in `entity_type`, and taught `apply_sync_mutation` to handle `'project'` and stamp root `mutation_id` via `artix.current_mutation_id`. |
| 23 | `20261101100100_contract_strict_cas_base_version.sql` | **Contract Phase**: Enforced strict `p_base_version IS NOT NULL AND p_base_version >= 1` (`ERRCODE '22023'`, `INVALID_CAS_BASELINE`) on all `update` and `delete` calls to `apply_sync_mutation`, returning structured `version_mismatch` / `remote_deleted` / `already_exists` envelopes. |
| 24 | `20261101100200_sync_changes_retention_and_floor.sql` | Created `public.sync_retention_state`, `public.get_sync_feed_bounds()`, and `public.prune_sync_changes()` to bound `sync_changes` growth while exposing `min_retained_sequence`. |
| 25 | `20261101100300_atomic_billing_reconciliation_and_manual_grants.sql` | Extended `subscriptions` (`reconciliation_version`, `last_stripe_event_created`), created RLS-protected `public.manual_grants`, `public.user_has_active_pro_entitlement()`, atomic `public.reconcile_stripe_subscription()`, strict `past_due` fail-closed downgrade, and Free-tier `5/month` AI quota enforcement in `check_plan_tier_limit()`. |

### Zero-Downtime Expand -> Contract Pattern
Migrations `20261101100000` and `20261101100100` exemplify Artix's safe rollout strategy:
1. **Expand (`20261101100000`)**: Adds nullable/defaulted columns (`projects.version`, `projects.deleted_at`, `sync_changes.mutation_id`) and expands `apply_sync_mutation` while remaining backward-compatible with older clients during rollout.
2. **Client Rollout**: Ships `ArtixDB` v3 (`migrateLegacyArtixDB` baseline healing) and updated client push adapters that always supply `baseServerVersion >= 1`.
3. **Contract (`20261101100100`)**: Tightens `apply_sync_mutation` to reject `NULL` or `< 1` `p_base_version` on `update`/`delete` with SQLSTATE `22023`, eliminating unguarded blind overwrites permanently.

### Applying Migrations via Supabase CLI
```bash
# Push pending migrations to remote Supabase project (staging first, then production)
npx supabase db push

# Regenerate TypeScript database types
npx supabase gen types typescript --project-id <project-ref> > src/integrations/supabase/types.ts
```
