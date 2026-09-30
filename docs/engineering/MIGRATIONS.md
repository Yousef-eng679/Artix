# Database Migrations & Schema Evolution Guide

> **Status**: `IMPLEMENTED`  
> **Target**: Post-C12 Migration Architecture

---

## 1. Overview

Artix manages migrations across two disparate storage engines:
1. **Client-Side Schema Migrations**: Managed via Dexie.js versioning and `migrateLegacyArtixDB` in browser IndexedDB.
2. **Server-Side Schema Migrations**: Managed via versioned SQL migration scripts applied to Supabase PostgreSQL.

---

## 2. Client IndexedDB Migrations (`src/lib/local/db.ts`)

Dexie handles local schema upgrades declaratively:

```typescript
export class ArtixDB extends Dexie {
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

    this.on('versionchange', () => {
      console.warn(`[ArtixDB] Database schema version change detected for ${dbName}. Closing connection.`);
      this.close();
    });
  }
}
```

### Legacy Database Migration (`migrateLegacyArtixDB`)
When upgrading older clients from the early unpartitioned `ArtixDB` to `ArtixDB_v2_<hash>`:
1. Detects presence of legacy database.
2. Opens legacy store in read-only transaction.
3. Migrates documents, designs, and folders matching the current user's ID into the new user-scoped database.
4. Marks `legacy_migration_completed` in `database_meta` to prevent re-execution.
5. Safely handles errors without swallowing database exceptions.

---

## 3. Server-Side Supabase Migrations (`supabase/migrations/`)

Server migrations are immutable SQL files named with UTC timestamps (`YYYYMMDDHHMMSS_description.sql`):

| Migration Version | Name | Primary Changes |
|---|---|---|
| `20260722180000` | `stripe_billing` | Subscriptions table, Stripe customer ID, status enums. |
| `20260723120000` | `enforce_tier_limits_trigger` | Database trigger checking user plan tier on project/document creation. |
| `20260919082427` | `add_missing_rls_policies` | Complete RLS lockdown across all tables with `auth.uid() = user_id`. |
| `20260923213000` | `workspace_folders` | Hierarchy tables, `parent_folder_id` foreign keys, folder cascade delete rules. |
| `20260928120000` | `server_concurrency_protocol` | Added `version INTEGER` and `deleted_at`, version increment triggers. |
| `20260928130000` | `durable_sync_changes` | Append-only change feed log (`public.sync_changes`) and replication triggers. |
| `20260928140000` | `idempotent_mutation_ledger`| Created `public.processed_mutations` for durable mutationId idempotency. |

### Applying Migrations via Supabase CLI
```bash
# Push local migrations to remote Supabase project
npx supabase db push

# Generate TypeScript types from active database schema
npx supabase gen types typescript --project-id ldhbjeustealybjffadn > src/integrations/supabase/types.ts
```
