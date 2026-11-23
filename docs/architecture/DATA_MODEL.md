# Artix Data Model & State Machine Specifications

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/local/types.ts`, `src/lib/local/db.ts`, and `supabase/migrations/`

---

## 1. Overview

Artix maintains dual, synchronized data models:
1. **Local Schema (Client IndexedDB)**: Optimized for fast UI queries, transactional consistency, and offline resilience.
2. **Cloud Schema (Supabase PostgreSQL)**: Optimized for multi-tenant isolation, version increment triggers, append-only replication, and idempotency tracking.

---

## 2. Local Database Schema (`ArtixDB`)

Defined in `src/lib/local/db.ts` using Dexie.js v4:

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
}
```

### Table Definitions & Compound Indices (`ArtixDB` Schema v3)

| Table Name | Primary Key | Indexed Fields | Purpose |
|---|---|---|---|
| `projects` | `id` (UUID) | `id`, `userId`, `updatedAt`, `name`, `localRevision`, `isDeleted` | Local authority store for user projects (promoted to full Outbox-synced entity in v3). |
| `documents` | `id` (UUID) | `[userId+projectId]`, `userId`, `projectId`, `folderId`, `localRevision`, `updatedAt`, `isDeleted` | Local authority store for technical documentation specifications (`markdown`, `xml`, `text`). |
| `system_designs` | `id` (UUID) | `[userId+projectId]`, `userId`, `projectId`, `folderId`, `localRevision`, `updatedAt`, `isDeleted` | Local authority store for visual architecture canvases (React Flow node graphs). |
| `workspace_folders` | `id` (UUID) | `[userId+projectId]`, `userId`, `projectId`, `parentFolderId`, `name`, `localRevision`, `updatedAt`, `isDeleted` | Hierarchical folder tree nodes for resource organization. |
| `outbox` | `id` (UUID) | `[userId+entityType+entityId]`, `userId`, `state`, `createdAt`, `localRevision` | Transactional mutation queue (`dispatched`, `leaseToken`, `nextRetryAt`, `lastError`) awaiting cloud sync. |
| `sync_metadata` | `id` (`${entityType}:${entityId}`) | `[userId+entityType]`, `userId`, `entityId`, `syncState`, `localRevision`, `lastSyncedAt` | Tracks per-entity `syncState`, `serverVersion`, `serverUpdatedAt`, and `lastAckedMutationId`. |
| `conflicts` | `id` (UUID) | `[userId+entityType+entityId]`, `detectedAt` | Storage of 3-way conflict records (`basePayload`, `localPayload`, `remotePayload`, `reason`, `remoteVersion`, `resolvedAt`). |
| `database_meta` | `key` (string) | `updatedAt` | Key-value runtime metadata: `'server_cursor'`, `'hydration_complete'`, `'legacy_migration'`, `'cached_subscription'`, `'cached_ai_generations'`. |

---

## 3. Cloud Database Schema (Supabase PostgreSQL 17)

### Core Synced Entity Tables

```sql
-- Projects (promoted to CAS-versioned syncable entity in 20261101100000)
CREATE TABLE public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Untitled Project',
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Documents
CREATE TABLE public.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES public.workspace_folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'Untitled Document',
  content TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'xml', 'text')),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- System Designs
CREATE TABLE public.system_designs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES public.workspace_folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT 'System Design',
  board_state JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Workspace Folders
CREATE TABLE public.workspace_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  parent_folder_id UUID REFERENCES public.workspace_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Server Concurrency Trigger
On every entity update across `projects`, `documents`, `system_designs`, and `workspace_folders`, a PostgreSQL trigger advances `version` and refreshes `updated_at`:
```sql
CREATE OR REPLACE FUNCTION public.increment_entity_version()
RETURNS TRIGGER AS $$
BEGIN
  NEW.version = OLD.version + 1;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### Append-Only Replication, Idempotency & Retention Tables

```sql
-- Durable Commit-Ordered Change Feed Log
CREATE TABLE public.sync_changes (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('project', 'document', 'system_design', 'workspace_folder')),
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  entity_version BIGINT NOT NULL,
  mutation_id UUID NULL,
  payload JSONB,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sync_changes_user_seq ON public.sync_changes (user_id, sequence ASC);
CREATE INDEX idx_sync_changes_user_mutation ON public.sync_changes (user_id, mutation_id) WHERE mutation_id IS NOT NULL;
CREATE INDEX idx_sync_changes_changed_at_seq ON public.sync_changes (changed_at ASC, sequence ASC);

-- Monotonic Pruned Sequence Floor (20261101100200)
CREATE TABLE public.sync_retention_state (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  min_retained_sequence BIGINT NOT NULL DEFAULT 0 CHECK (min_retained_sequence >= 0),
  last_pruned_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Durable Idempotency Ledger
CREATE TABLE public.processed_mutations (
  mutation_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  version BIGINT NULL,
  updated_at TIMESTAMPTZ NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

*(For billing, entitlement, and AI generation tables — `public.subscriptions`, `public.stripe_events`, `public.manual_grants`, `public.profiles`, `public.prd_generations`, `public.vibe_generations`, `public.agentic_workflows` — and server RPCs `apply_sync_mutation`, `get_sync_feed_bounds`, `prune_sync_changes`, `reconcile_stripe_subscription`, see [`DATABASE_SCHEMA.md`](../reference/DATABASE_SCHEMA.md).)*

---

## 4. State Machines & Formal Lifecycle Models

### 4.1 Local Entity Synchronization State (`SyncState`)
Defined in `src/lib/local/types.ts`:
```typescript
export type SyncState = 
  | 'synced' 
  | 'pending' 
  | 'syncing' 
  | 'conflict' 
  | 'error' 
  | 'deleted_pending' 
  | 'deleted_synced';
```

```text
               User Local Edit
             ┌─────────────────┐
             │                 │
             ▼                 │
       ┌───────────┐           │
       │  PENDING  │◄──────────┤ (Push Fails / Network Offline)
       └─────┬─────┘           │
             │                 │
             │ (Lease Acquired / Push Started)
             ▼
       ┌───────────┐
       │  SYNCING  │
       └─────┬─────┘
             │
             ├─── (200 OK & Revision Match) ────► ┌──────────┐
             │                                    │  SYNCED  │
             │                                    └──────────┘
             ├─── (409 CAS Mismatch) ───────────► ┌──────────┐
             │                                    │ CONFLICT │ (Outbox Blocked)
             │                                    └──────────┘
             └─── (Fatal / Malformed Error) ────► ┌──────────┐
                                                  │  ERROR   │
                                                  └──────────┘
```

#### State Invariants
- `synced`: The local entity content matches the latest acknowledged server snapshot. `localRevision == serverRevision`.
- `pending`: The local entity has unpushed modifications. `localRevision > serverRevision`.
- `syncing`: An outbox mutation for this entity has been claimed by the leader tab and is actively in flight over HTTPS.
- `conflict`: The server rejected the push due to a CAS version mismatch (`409 CONFLICT`), or a concurrent remote snapshot arrived while an edit was pending. Requires resolution.
- `deleted_pending`: The entity was deleted locally while offline. A delete mutation is queued in the outbox.
- `deleted_synced`: The delete mutation was acknowledged by the server or arrived via remote change feed. The entity is retained as a soft tombstone.

---

### 4.2 Outbox State Machine (`OutboxState`)
Defined in `src/lib/local/types.ts`:
```typescript
export type OutboxState = 'pending' | 'in_flight' | 'blocked' | 'failed';
```

```text
             ┌───────────┐
             │  PENDING  │◄────────────────────────┐
             └─────┬─────┘                         │
                   │ (Leader Claims Lease)         │ (Transient Timeout / Network Down)
                   ▼                               │
             ┌───────────┐                         │
             │ IN_FLIGHT ├─────────────────────────┘
             └─────┬─────┘
                   │
                   ├── (Server 200 OK / Idempotent Match) ──► [ DRAINED (Row Deleted) ]
                   │
                   ├── (409 CAS Conflict) ─────────────────► ┌───────────┐
                   │                                         │  BLOCKED  │
                   └── (Non-Retryable / Quota / Retries >= 5)►└───────────┘
```

#### In-Flight Lease & Fencing Contract
When an entry transitions from `pending` to `in_flight` (`markInFlight`):
- `leaseOwner`: String identifier of the leader tab (`tabId`).
- `leaseExpiresAt`: Epoch timestamp (`Date.now() + 30000`, 30-second TTL).
- `leaseToken`: Fresh UUID v4 verified inside atomic `[outbox, sync_metadata]` ack/fail transactions so stale zombie completions are ignored.
- `dispatched`: Set permanently to `true` so subsequent local edits append as a new causal outbox entry rather than mutating the in-flight entry.
- If the leader crashes, standby tabs or restart cycles detect `leaseExpiresAt < Date.now()` and reclaim the entry back to `pending`.

---

### 4.3 Tombstone Lifecycle State Model
Managed by `TombstoneManager` (`src/lib/sync/tombstoneManager.ts`):

```text
User Deletes Entity (Offline/Online)
               │
               ▼
   ┌──────────────────────┐
   │ LOCAL_PENDING_DELETE │ ──► Entity marked isDeleted: true
   └──────────┬───────────┘     Delete mutation queued in outbox
              │
              │ (Server Acknowledged CAS Delete)
              ▼
   ┌──────────────────────┐
   │    DELETED_SYNCED    │ ──► Soft tombstone retained in IndexedDB
   └──────────┬───────────┘     Prevents remote resurrection
              │
              │ (TTL Exceeds 30 Days)
              ▼
   ┌──────────────────────┐
   │   PURGED (Deleted)   │ ──► Row permanently deleted from local IndexedDB
   └──────────────────────┘

Remote Delete Arrives via Pull Change Feed
               │
               ▼
   ┌────────────────────────┐
   │ REMOTE_CONFIRMED_DELETE│ ──► Entity marked isDeleted: true locally
   └────────────────────────┘     NO delete mutation enqueued in outbox!
```

---

### 4.4 Remote Pull Cursor Progression Model

```text
Remote Change Batch Received
             │
             ▼
     Validate Schema
             │
             ▼
Check Pending-Local Guard (Outbox conflict check)
             │
             ▼
Apply Mutation to Local IndexedDB Entity Table
             │
             ▼
Atomic Local Commit Succeeds
             │
             ▼
Advance Persistent Cursor (`database_meta['server_cursor']`) in the SAME Dexie Transaction
```

> **Invariant**: The pull cursor (`database_meta['server_cursor']`) is written inside the same 8-table atomic Dexie transaction as the batch's entity writes, and UI listeners are notified only after the transaction commits.
