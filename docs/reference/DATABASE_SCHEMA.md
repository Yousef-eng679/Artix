# Comprehensive Database Schema Reference

> **Status**: `IMPLEMENTED`  
> **Target**: Post-C12 Schema Definitions (Supabase PostgreSQL + Client IndexedDB)

---

## 1. Cloud PostgreSQL DDL (Supabase)

### 1.1 Core Tables
```sql
-- Projects
CREATE TABLE public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Workspace Folders
CREATE TABLE public.workspace_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
  parent_folder_id UUID REFERENCES public.workspace_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
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
  format TEXT NOT NULL DEFAULT 'markdown',
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- System Designs
CREATE TABLE public.system_designs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES public.workspace_folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT 'Untitled System Design',
  board_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 1.2 Replication & Idempotency Tables
```sql
-- Append-Only Change Feed Log
CREATE TABLE public.sync_changes (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('document', 'system_design', 'workspace_folder')),
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  entity_version BIGINT NOT NULL,
  payload JSONB,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sync_changes_user_seq ON public.sync_changes (user_id, sequence ASC);

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

---

## 2. Client IndexedDB Schemas (`ArtixDB`)

```typescript
// Local Documents Table
interface LocalDocument {
  id: string;                       // Primary Key (UUID)
  projectId: string | null;         // Container Project
  userId: string;                   // Owning user
  folderId: string | null;          // Parent folder
  title: string;                    // Document title
  content: string;                  // Full text payload
  format: 'markdown' | 'xml' | 'plaintext';
  createdAt: string;                // ISO 8601
  updatedAt: string;                // ISO 8601
  localRevision: number;            // Local monotonic revision (1, 2, 3...)
  isDeleted: boolean;               // Soft-delete flag
  deletedAt?: string | null;        // Deletion timestamp
}

// Outbox Table
interface OutboxEntry {
  id: string;                       // Primary Key (UUID)
  mutationId: string;               // Durable idempotency UUID sent to server
  entityType: 'document' | 'system_design' | 'workspace_folder';
  entityId: string;
  userId: string;
  projectId: string | null;
  operation: 'create' | 'update' | 'delete';
  payload: Record<string, any>;
  baseServerVersion?: string;       // CAS concurrency version
  localRevision: number;
  state: 'pending' | 'in_flight' | 'blocked' | 'failed';
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
}
```
