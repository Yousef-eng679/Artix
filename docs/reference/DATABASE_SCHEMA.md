# Comprehensive Database Schema Reference

> **Status**: `IMPLEMENTED`  
> **Target**: Productionized Schema Definitions (`v2.5.0` — Supabase PostgreSQL 17 across 25 Migrations + Client Dexie `ArtixDB` v3)

---

## 1. Cloud PostgreSQL 17 DDL (Supabase — 14 `public` Tables)

### 1.1 Core Synced Workspace Entity Tables
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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, project_id)
);

-- Documents
CREATE TABLE public.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
  folder_id UUID NULL,
  title TEXT NOT NULL DEFAULT 'Untitled Document',
  content TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'xml', 'text')),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT documents_folder_project_fk
    FOREIGN KEY (folder_id, project_id)
    REFERENCES public.workspace_folders(id, project_id)
    ON DELETE SET NULL
);

-- System Designs
CREATE TABLE public.system_designs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  folder_id UUID NULL,
  name TEXT NOT NULL DEFAULT 'System Design',
  board_state JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT system_designs_folder_project_fk
    FOREIGN KEY (folder_id, project_id)
    REFERENCES public.workspace_folders(id, project_id)
    ON DELETE SET NULL
);
```

### 1.2 Replication, Idempotency & Retention Tables
```sql
-- Append-Only Commit-Ordered Change Feed Log
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

-- Monotonic Pruned Sequence Floor Watermark (20261101100200)
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

### 1.3 Profiles, Billing, Entitlements & AI Generation History Tables
```sql
-- User Profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stripe Subscriptions (with atomic reconciliation metadata from 20261101100300)
CREATE TABLE public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  plan_tier TEXT NOT NULL DEFAULT 'free' CHECK (plan_tier IN ('free', 'pro')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'canceled', 'incomplete')),
  billing_cycle TEXT CHECK (billing_cycle IN ('monthly', 'annual')),
  current_period_end TIMESTAMPTZ,
  reconciliation_version BIGINT NOT NULL DEFAULT 0,
  last_stripe_event_created BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stripe Webhook Event Deduplication Ledger (service_role only)
CREATE TABLE public.stripe_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Non-Stripe Administrative Pro Overrides (RLS-protected, 20261101100300)
CREATE TABLE public.manual_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_tier TEXT NOT NULL DEFAULT 'pro' CHECK (plan_tier IN ('free', 'pro')),
  reason TEXT NOT NULL DEFAULT '',
  granted_by TEXT NOT NULL DEFAULT 'service_role',
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AI Generation History Tables (guarded by check_plan_tier_limit() 5/month Free cap)
CREATE TABLE public.prd_generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  template TEXT NOT NULL,
  output_markdown TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.vibe_generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  target TEXT NOT NULL,
  scope TEXT NOT NULL,
  output_markdown TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.agentic_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  pattern TEXT NOT NULL,
  agent_count INTEGER NOT NULL DEFAULT 3,
  output_markdown TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 1.4 Authoritative PostgreSQL RPCs & Trigger Functions
- `public.apply_sync_mutation(...)` (`SECURITY INVOKER`, `authenticated`): Advisory-locked idempotency check (`processed_mutations`) + strict CAS mutation (`p_base_version >= 1` on `update`/`delete`) + GUC-correlated `sync_changes` event in 1 transaction.
- `public.get_sync_feed_bounds()` (`SECURITY INVOKER`, `authenticated`): Returns `{ min_retained_sequence, max_sequence }`.
- `public.prune_sync_changes(p_retention, p_batch_limit)` (`SECURITY DEFINER`, `service_role`): Advances `sync_retention_state.min_retained_sequence` monotonically and batch-deletes expired `sync_changes` rows.
- `public.reconcile_stripe_subscription(...)` (`SECURITY DEFINER`, `service_role`): Advisory-locked atomic reconciliation of `subscriptions` + `stripe_events` with strict fail-closed `past_due -> free` policy.
- `public.user_has_active_pro_entitlement(p_user_id)` & `public.check_plan_tier_limit()` (`SECURITY DEFINER`, internal/service_role): Serialized per-user tier quota trigger enforcing 3 projects / 10 docs / 3 designs / 5 monthly AI generations on Free and 100 projects on Pro.

---

## 2. Client IndexedDB Schemas (`ArtixDB` v3 — 8 Object Stores in `src/lib/local/types.ts`)

```typescript
export type EntityType = 'project' | 'document' | 'system_design' | 'workspace_folder';
export type DocumentFormat = 'markdown' | 'xml' | 'text';

export interface LocalProject {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  localRevision: number;
  isDeleted: boolean;
}

export interface LocalDocument {
  id: string;
  projectId: string | null;
  userId: string;
  folderId: string | null;
  title: string;
  content: string;
  format: DocumentFormat;
  createdAt: string;
  updatedAt: string;
  localRevision: number;
  isDeleted: boolean;
}

export interface LocalSystemDesign {
  id: string;
  projectId: string;
  userId: string;
  folderId: string | null;
  name: string;
  boardState: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  localRevision: number;
  isDeleted: boolean;
}

export interface LocalWorkspaceFolder {
  id: string;
  projectId: string;
  userId: string;
  parentFolderId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
  localRevision: number;
  isDeleted: boolean;
}

export interface OutboxEntry {
  id: string;
  mutationId: string;
  entityType: EntityType;
  entityId: string;
  userId: string;
  projectId: string | null;
  operation: 'create' | 'update' | 'delete';
  payload: Record<string, any>;
  baseServerVersion: string | null;
  localRevision: number;
  state: 'pending' | 'in_flight' | 'blocked' | 'failed';
  dispatched?: boolean;
  dispatchedAt?: number | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  leaseToken?: string | null;
  attemptCount: number;
  nextRetryAt?: number | null;
  lastError?: { code: string; message: string; at: number } | null;
  createdAt: number;
  updatedAt: number;
}

export interface SyncMetadata {
  id: string; // `${entityType}:${entityId}`
  entityType: EntityType;
  entityId: string;
  userId: string;
  syncState: 'synced' | 'pending' | 'syncing' | 'conflict' | 'error' | 'deleted_pending' | 'deleted_synced';
  localRevision: number;
  serverVersion: string | null;
  serverUpdatedAt: string | null;
  lastAckedMutationId?: string | null;
  lastSyncedAt: number | null;
  baseSnapshot?: Record<string, any> | null;
}

export interface ConflictRecord {
  id: string;
  entityType: EntityType;
  entityId: string;
  userId: string;
  basePayload: Record<string, any> | null;
  localPayload: Record<string, any>;
  remotePayload: Record<string, any> | null;
  reason?: 'version_mismatch' | 'remote_deleted' | 'already_exists' | string | null;
  remoteVersion?: string | null;
  detectedAt: number;
  resolvedAt?: number | null;
}

export interface DatabaseMeta {
  key: 'server_cursor' | 'hydration_complete' | 'legacy_migration' | 'cached_subscription' | 'cached_ai_generations' | string;
  value: any;
  updatedAt: number;
}
```
