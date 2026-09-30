# Artix Code Organization & Module Responsibilities

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/` directory tree and TypeScript strict compilation

---

## 1. Directory Tree Overview

```text
src/
├── components/          # React Presentation & UI Components
│   ├── Editor/          # Monaco editor, preview toggle, markdown/xml renderers
│   ├── ProjectWorkspace/# Workspace shell, sidebar, tabs, dialogs, overview
│   ├── SystemArchitect/ # React Flow canvas, architectural node types, edge renderers
│   ├── ui/              # Shadcn UI reusable primitives (buttons, dialogs, inputs)
│   └── ErrorBoundary.tsx# Crash containment wrapper for React subtrees
│
├── contexts/            # React Context Providers
│   └── UserSyncRuntimeContext.tsx # Context for UserSyncRuntime and active repositories
│
├── hooks/               # Custom React Hooks (Domain & UI state)
│   ├── useAuth.tsx              # Supabase authentication session hook
│   ├── useDocuments.tsx         # Document queries and mutations (IndexedDB)
│   ├── useSystemDesigns.tsx     # Canvas designs queries and mutations (IndexedDB)
│   ├── useWorkspaceFolders.tsx  # Folder tree queries and moves (IndexedDB)
│   ├── useWorkspaceTabs.ts      # Multi-tab open/close/switch state management
│   ├── useWorkspaceKeyboard.ts  # Workspace hotkeys (Ctrl+W, Ctrl+Tab, Ctrl+S)
│   ├── useSyncStatus.tsx        # Online, pending outbox count, and sync state
│   ├── useSubscription.ts       # Stripe subscription tier and limits
│   └── useUsageLimits.ts        # Resource creation limit checks
│
├── lib/                 # Core Business Logic & Non-React Utilities
│   ├── ai/              # AI provider adapters, streaming, prompt generation, crypto
│   │   ├── crypto.ts    # PBKDF2 100k + AES-GCM 256-bit client-side key encryption
│   │   ├── storage.ts   # BYOK key settings persistence and sanitization
│   │   ├── streaming.ts # SSE reader for token streaming
│   │   └── refine.ts    # 2-pass prompt critique and expansion engine
│   ├── local/           # Local Database & Storage Subsystem
│   │   ├── db.ts        # Dexie ArtixDB class, compound indices, FNV-1a user hashing
│   │   ├── errors.ts    # Storage error taxonomy and quota exception helpers
│   │   └── types.ts     # TypeScript interfaces for entities, outbox, metadata
│   ├── repositories/    # Domain Repository Abstraction Layer
│   │   ├── documentRepository.ts     # Atomic document CRUD & revisions
│   │   ├── systemDesignRepository.ts # Atomic system design CRUD & revisions
│   │   ├── folderRepository.ts       # Folder DAG, tree hierarchy, cascade deletes
│   │   ├── outboxRepository.ts       # Outbox enqueuing, leases, compaction
│   │   ├── syncMetadataRepository.ts # Sync status tracking and baseline versions
│   │   └── conflictRepository.ts     # 3-way conflict storage and listing
│   ├── sync/            # Distributed Synchronization Engine
│   │   ├── adapters/    # Entity-specific push adapters (documents, designs, folders)
│   │   ├── syncEngine.ts             # Outbox drainer, leader worker, exponential backoff
│   │   ├── pullEngine.ts             # Change feed puller, cursor tracking, pending guard
│   │   ├── tabCoordinator.ts         # Web Locks API leader election & BroadcastChannel
│   │   ├── userSyncRuntime.ts        # Runtime lifecycle manager (binds to Auth user)
│   │   ├── tombstoneManager.ts       # Soft-delete lifecycle and 30-day purge
│   │   ├── conflictResolver.ts       # Diff3 3-way line merge for markdown documents
│   │   ├── dependencyOrder.ts        # Topological DAG push sorter
│   │   ├── errorTaxonomy.ts          # Network vs HTTP vs CAS conflict classification
│   │   └── realtimeSync.ts           # Supabase Realtime channel listener (150ms debounce)
│   └── workspace/       # Workspace UI Helpers
│       ├── resourceAdapter.ts        # Pure 4-tier AdaptableResource view model
│       ├── tabPersistence.ts         # Tab session serialization to localStorage
│       ├── workspaceTabs.ts          # Pure tab state transitions (open, close, select)
│       ├── dirtyTracker.ts           # Unsaved change tracking per tab
│       └── groupResourcesByFolder.ts # Recursive folder DAG tree builder
│
├── pages/               # Top-Level Page Route Components
│   ├── ProjectWorkspace.tsx # Primary application workspace
│   ├── Dashboard.tsx        # Project list, recent items, and analytics
│   ├── Auth.tsx             # Sign in, sign up, and password reset
│   ├── Pricing.tsx          # Public tier pricing and feature comparison
│   ├── Settings.tsx         # Account, BYOK AI keys, and preferences
│   ├── PRDGenerator.tsx     # Dedicated Sprint PRD generation tool
│   ├── VibeCoding.tsx       # Dedicated AI coding prompt compiler
│   └── AgenticWorkflow.tsx  # Multi-agent architectural designer
│
├── test/                # 81 Vitest Test Suites (566 Tests)
│   ├── architecture/    # Network boundary isolation tests
│   ├── components/      # UI component rendering and interaction tests
│   ├── hooks/           # React hook behavior tests
│   ├── local/           # Dexie database, user scoping, and repository tests
│   ├── repositories/    # Atomic transaction mutation tests
│   ├── sync/            # Sync engine, pull, CAS, leader, and correctness matrix
│   └── workspace/       # Tabs, folder tree, and navigation tests
│
└── integrations/
    └── supabase/        # Cloud Backend Client & Generated DB Types
        ├── client.ts    # Initialized Supabase JavaScript client
        └── types.ts     # Generated TypeScript definitions for public schema
```

---

## 2. Layering & Import Rules

To preserve architectural integrity, Artix enforces strict module boundary rules:

```text
Presentation Layer (pages, components)
           │
           │ (Allowed to import: hooks, contexts, types, ui)
           ▼
Application State & Contexts (hooks, contexts)
           │
           │ (Allowed to import: repositories, sync runtime, types)
           ▼
Domain Repositories (lib/repositories)
           │
           │ (Allowed to import: lib/local/db, types, outbox, metadata)
           ▼
Storage & Sync Engine (lib/local, lib/sync)
           │
           │ (Allowed to import: supabase client, adapters, dexie)
           ▼
Database & Cloud Infrastructure (supabase)
```

### Prohibited Import Paths
- **Rule 1 (Zero Cloud in UI)**: Files under `src/components/` and `src/pages/` must NEVER import `@/integrations/supabase/client` or perform direct REST updates. All mutations must pass through local repositories via React hooks.
- **Rule 2 (No Reverse Dependencies)**: `src/lib/repositories/` and `src/lib/sync/` must NEVER import React hooks or React components. They are headless, pure TypeScript classes.
- **Rule 3 (Local Storage Decoupling)**: Repositories interact exclusively with Dexie IndexedDB tables. They do not initiate HTTP calls directly; background sync engines handle replication out-of-band.
