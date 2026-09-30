# Artix — Technical Specifications & Architecture Model

> **Status**: `RECONCILED`  
> **Target Release**: v2.3.0 (Post-C12 Architecture)

---

## 1. Cloud Database Schema (Supabase PostgreSQL)

All database tables reside in Supabase PostgreSQL (`public` schema) and are protected by Row Level Security policies requiring authenticated JWT sessions (`auth.uid() = user_id`).

```sql
-- 1. Projects Table
CREATE TABLE public.projects (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Untitled Project',
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Workspace Folders Table (Hierarchy & DAG)
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

-- 3. Documents Table (Technical Specifications)
CREATE TABLE public.documents (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES public.workspace_folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'Untitled Document',
  content TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'xml', 'plaintext', 'text')),
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. System Designs Table (Visual Node Graph Canvas)
CREATE TABLE public.system_designs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES public.workspace_folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT 'System Design',
  board_state JSONB NOT NULL DEFAULT '{"nodes": [], "edges": []}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Subscriptions Table (Stripe Billing Integration)
CREATE TABLE public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  plan_tier TEXT NOT NULL DEFAULT 'free' CHECK (plan_tier IN ('free', 'pro')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'canceled', 'incomplete')),
  billing_cycle TEXT CHECK (billing_cycle IN ('monthly', 'annual')),
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Durable Change Feed Log (Append-Only Replication)
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

-- 7. Processed Mutations Table (Idempotency Ledger)
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

## 2. Client Persistence Tier (Dexie.js IndexedDB)

- **Database Name**: `ArtixDB_v2_<hash>` where `<hash>` is derived from 32-bit FNV-1a hashing of `auth.uid()`.
- **Primary Authority**: All read queries and write mutations occur against local IndexedDB tables with 0ms latency.
- **Atomic 3-Table Mutations**: Updates write to `[entities, outbox, sync_metadata]` in a single transaction.
- **Single-Leader Multi-Tab Worker**: Web Locks API (`navigator.locks`) elects one tab to drain the outbox to PostgreSQL.

---

## 3. Technology Stack Reference

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| **Core UI Runtime** | React | `^18.3.1` | Declarative component UI and context state. |
| **Language** | TypeScript | `^5.5.3` | Strict type safety across client and server. |
| **Bundler & PWA** | Vite | `^5.4.21` | Hot module replacement, build packaging, and Service Worker. |
| **Local Database** | Dexie.js | `^4.0.11` | Reactive IndexedDB wrapper with compound indexing. |
| **Code Editor** | Monaco Editor | `^4.6.0` | High-performance technical code and markdown editing. |
| **Visual Canvas** | React Flow | `^12.4.4` | Node graph architecture diagramming engine. |
| **Styling** | Tailwind CSS | `^3.4.17` | Utility-first responsive styling and dark mode. |
| **Backend & Auth** | Supabase | `^2.49.1` | PostgreSQL database, Auth PKCE, and Realtime channels. |
| **Testing** | Vitest | `^3.2.7` | Fast unit, integration, and distributed failure simulation suite. |
