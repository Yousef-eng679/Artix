# Artix — Technical Specifications & Architecture Model

> **Status**: `RECONCILED`  
> **Target Release**: v2.5.0 (Productionized Billing, Strict CAS & True Offline-First Architecture)

---

## 1. Cloud Database Schema (Supabase PostgreSQL 17)

All database tables reside in Supabase PostgreSQL (`public` schema) and are protected by Row Level Security policies requiring authenticated JWT sessions (`auth.uid() = user_id`).

```sql
-- 1. Projects Table (CAS-versioned syncable entity)
CREATE TABLE public.projects (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Untitled Project',
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Workspace Folders Table (Hierarchy & DAG)
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

-- 3. Documents Table (Technical Specifications)
CREATE TABLE public.documents (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES public.workspace_folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'Untitled Document',
  content TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'xml', 'text')),
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

-- 5. Subscriptions & Manual Grants Tables (Stripe Billing & Entitlements)
CREATE TABLE public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
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

CREATE TABLE public.manual_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  plan_tier TEXT NOT NULL DEFAULT 'pro' CHECK (plan_tier IN ('free', 'pro')),
  reason TEXT NOT NULL DEFAULT '',
  granted_by TEXT NOT NULL DEFAULT 'service_role',
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Durable Change Feed Log & Retention Floor
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

CREATE TABLE public.sync_retention_state (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  min_retained_sequence BIGINT NOT NULL DEFAULT 0 CHECK (min_retained_sequence >= 0),
  last_pruned_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

## 2. Client Persistence Tier (`ArtixDB` v3 on Dexie.js IndexedDB)

- **Database Name**: `ArtixDB_v2_<hash>` where `<hash>` is derived from 32-bit FNV-1a hashing of `auth.uid()`.
- **8 Object Stores**: `projects`, `documents`, `system_designs`, `workspace_folders`, `outbox`, `sync_metadata`, `conflicts`, `database_meta` (`server_cursor`, `hydration_complete`, `legacy_migration`, `cached_subscription`, `cached_ai_generations`).
- **Primary Authority**: All read queries and write mutations occur against local IndexedDB tables with 0ms latency, including offline cold starts with an expired JWT (`src/lib/auth/offlineSession.ts`).
- **Atomic Multi-Table Mutations**: Standard CRUD writes `[entity, outbox, sync_metadata]` in a single transaction; folder deletes span 5 tables; project cascade deletes span 6 tables.
- **Single-Leader Multi-Tab Worker**: Web Locks API (`navigator.locks`) elects one tab to drain the outbox to PostgreSQL via `public.apply_sync_mutation` with 30s `leaseToken` fencing.

---

## 3. Technology Stack Reference (`package.json`)

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| **Core UI Runtime** | React | `^18.3.1` | Declarative component UI and context state. |
| **Language** | TypeScript | `^5.8.3` | Strict type safety across client and server. |
| **Bundler & PWA** | Vite + `vite-plugin-pwa` | `^5.4.20` / `^1.2.0` | Build packaging and Workbox Service Worker (`clientsClaim`, `skipWaiting`). |
| **Local Database** | Dexie.js | `^4.4.6` | Reactive IndexedDB wrapper (`ArtixDB` v3, 8 tables). |
| **Code Editor** | `monaco-editor` + `@monaco-editor/react` | `^0.57.0` / `^4.7.0` | Locally bundled code/markdown/xml editor and worker (zero CDN). |
| **Visual Canvas** | React Flow + Dagre | `^12.10.0` / `^3.0.0` | Node graph architecture diagramming and auto-layout engine. |
| **Typography & Styling** | Tailwind CSS + `@fontsource/*` | `^3.4.17` / `^5.3.0` | Utility-first styling with self-hosted Inter & JetBrains Mono fonts. |
| **Backend & Auth** | `@supabase/supabase-js` | `^2.93.3` | PostgreSQL 17 database, Auth PKCE, Edge Functions, and Realtime. |
| **Testing** | Vitest + PGlite + Playwright | `^3.2.6` / `^0.5.15` / `^1.64.1` | 4-layer unit, fault-injection, real PostgreSQL concurrency/RLS, and PWA E2E suite. |
