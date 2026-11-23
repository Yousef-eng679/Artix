# Artix Code Organization & Module Responsibilities

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/` directory tree and TypeScript strict compilation

---

## 1. Directory Tree Overview

```text
src/
├── components/          # React Presentation & UI Components
│   ├── AI/              # PRDGeneratorDialog, VibeCodingDialog, AgenticWorkflowDialog, ArchitectureGeneratorDialog
│   ├── Editor/          # Monaco editor, monacoSetup.ts (local bundle), MarkdownPreview.tsx
│   ├── ProjectWorkspace/# Workspace shell, sidebar, tabs, dialogs, overview
│   ├── SystemArchitect/ # React Flow canvas, ArchitectNode, AlgorithmNodeTemplates, DrawingCanvas
│   ├── ui/              # Shadcn UI reusable primitives (buttons, dialogs, inputs)
│   ├── ConflictResolutionModal.tsx # ConflictResolutionCenter & 3-way diff3 modal
│   ├── SyncStatusBanner.tsx        # Blocked outbox, quota, unhydrated offline & retry banner
│   ├── UpgradePrompt.tsx           # Stripe Pro checkout trigger dialog
│   ├── PWAInstallPrompt.tsx        # Desktop/mobile PWA install prompt
│   └── ErrorBoundary.tsx           # Crash containment wrapper for React subtrees
│
├── contexts/            # React Context Providers
│   └── UserSyncRuntimeContext.tsx # Context for UserSyncRuntime and active repositories
│
├── hooks/               # Custom React Hooks (Domain & UI state)
│   ├── useAuth.tsx              # Supabase auth session + offline expired-JWT continuity
│   ├── useProjects.tsx          # Project queries and mutations (IndexedDB ProjectRepository)
│   ├── useDocuments.tsx         # Document queries and mutations (IndexedDB DocumentRepository)
│   ├── useSystemDesigns.tsx     # Canvas designs queries and mutations (IndexedDB SystemDesignRepository)
│   ├── useWorkspaceFolders.tsx  # Folder tree queries and moves (IndexedDB FolderRepository)
│   ├── useRecentActivity.tsx    # Local cross-project recent documents & designs feed
│   ├── useWorkspaceTabs.ts      # Multi-tab open/close/switch state management
│   ├── useWorkspaceKeyboard.ts  # Workspace hotkeys (Ctrl+W, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+1..9)
│   ├── useSyncStatus.tsx        # Online, pending/blocked outbox counts, triggerSync, retryBlocked
│   ├── useSubscription.tsx      # Stripe subscription + manual_grants + offline Dexie entitlement cache
│   └── useUsageLimits.tsx       # Online/offline resource creation & monthly AI limit checks
│
├── lib/                 # Core Business Logic & Non-React Utilities
│   ├── ai/              # AI provider adapters, streaming, prompt generation, crypto
│   │   ├── crypto.ts    # PBKDF2 600k (v:2) / 250k (v:1) + AES-GCM 256-bit client key encryption
│   │   ├── registry.ts  # Provider gateway with primary -> backup failover
│   │   ├── storage.ts   # BYOK key settings persistence and sanitization
│   │   ├── streaming.ts # SSE reader for token streaming
│   │   └── refine.ts    # 2-pass prompt critique and expansion engine
│   ├── auth/            # Offline Cold-Start Authentication Helpers
│   │   └── offlineSession.ts # Expired-JWT offline session recovery from localStorage
│   ├── cache/           # Local Crash-Recovery & Debounce Utilities
│   │   ├── debouncedSave.ts  # 1000ms debounced autosave controller
│   │   ├── draftRecovery.ts  # User-scoped localStorage crash-recovery drafts
│   │   ├── saveQueue.ts      # Sequential local save queue
│   │   └── tabCloseGuard.ts  # Strict local-only beforeunload draft flush (zero network calls)
│   ├── local/           # Local Database & Storage Subsystem
│   │   ├── db.ts        # Dexie ArtixDB v3 (8 tables), compound indices, FNV-1a user hashing
│   │   ├── errors.ts    # StorageQuotaError, StaleBufferError, MissingCasBaselineError, UnresolvedConflictMarkersError
│   │   └── types.ts     # TypeScript interfaces for entities, outbox, metadata, conflicts
│   ├── repositories/    # Domain Repository Abstraction Layer
│   │   ├── projectRepository.ts      # Atomic project CRUD, 6-table cascade delete & revisions
│   │   ├── documentRepository.ts     # Atomic document CRUD, expectedLocalRevision & revisions
│   │   ├── systemDesignRepository.ts # Atomic system design CRUD, expectedLocalRevision & revisions
│   │   ├── folderRepository.ts       # Folder DAG, tree hierarchy, 5-table cascade delete
│   │   ├── outboxRepository.ts       # Outbox enqueuing, 30s leaseToken, dispatched flag, causal barrier
│   │   ├── syncMetadataRepository.ts # Sync status tracking and baseline server versions
│   │   └── conflictRepository.ts     # 3-way conflict storage and atomic resolution
│   ├── sync/            # Distributed Synchronization Engine
│   │   ├── adapters/    # Project, Document, SystemDesign, WorkspaceFolder adapters + idempotency.ts
│   │   ├── syncEngine.ts             # Outbox drainer, pre-push CAS reconciler, leaseToken fencing, retry timer
│   │   ├── pullEngine.ts             # Change feed puller, bootstrapHydrateAll, resnapshotAll, self-echo guard
│   │   ├── tabCoordinator.ts         # Web Locks API leader election & BroadcastChannel
│   │   ├── userSyncRuntime.ts        # Runtime lifecycle manager (binds to Auth user)
│   │   ├── tombstoneManager.ts       # Soft-delete lifecycle and 30-day 6-table purge
│   │   ├── conflictResolver.ts       # LCS-aligned 3-way diff3 merge & conflict-marker guard
│   │   ├── dependencyOrder.ts        # Topological Kahn's DAG push sorter
│   │   ├── errorTaxonomy.ts          # 17 SyncErrorCode classifier, 429 Retry-After, TIER_LIMIT_EXCEEDED
│   │   ├── transportTimeout.ts       # Shared 30s withTimeout helper (acyclic sync imports)
│   │   └── realtimeSync.ts           # Supabase Realtime channel listener (50ms leading+trailing debounce)
│   └── workspace/       # Workspace UI Helpers
│       ├── resourceAdapter.ts        # Pure 4-tier AdaptableResource view model
│       ├── tabPersistence.ts         # User-scoped tab session serialization to localStorage
│       ├── workspaceTabs.ts          # Pure tab state transitions (open, close, select)
│       ├── dirtyTracker.ts           # Unsaved change tracking per tab
│       └── groupResourcesByFolder.ts # Recursive folder DAG tree builder
│
├── pages/               # Top-Level Page Route Components
│   ├── Index.tsx            # Public landing page
│   ├── ProjectWorkspace.tsx # Primary application workspace
│   ├── Dashboard.tsx        # Project list, recent items, and analytics
│   ├── Auth.tsx             # Sign in, sign up, and password reset
│   ├── Pricing.tsx          # Public tier pricing and feature comparison
│   ├── CheckoutSuccess.tsx  # Post-checkout subscription confirmation view
│   ├── Settings.tsx         # Account, BYOK AI keys, billing portal, and preferences
│   └── NotFound.tsx         # 404 route fallback
│
├── test/                # 107 Vitest Suites (698 Tests) + Layer 3 PostgreSQL Suite
│   ├── architecture/    # Network boundary isolation tests (networkBoundary.test.ts)
│   ├── billing/         # Stripe webhook, price allowlist, and offline entitlement tests
│   ├── components/      # UI component rendering and stale-buffer tests
│   ├── hooks/           # React hook behavior tests
│   ├── local/           # Dexie v3 database, user scoping, and repository tests
│   ├── postgres/        # Layer 3 real PostgreSQL 17 / PGlite concurrency, CAS, billing & RLS suite
│   ├── repositories/    # Atomic transaction mutation tests
│   ├── sync/            # 40 sync protocol, fault-injection, retention-floor, and correctness suites
│   └── workspace/       # Tabs, folder tree, and navigation tests
│
└── integrations/
    └── supabase/        # Cloud Backend Client & Generated DB Types
        ├── client.ts    # Initialized Supabase JavaScript client (PKCE auth)
        └── types.ts     # Generated TypeScript definitions for public schema
```

*(End-to-end Playwright specs reside at top-level `tests/e2e/{auth,features,security,offlineColdStartAndSyncMatrix}.spec.ts`.)*

---

## 2. Layering & Import Rules

To preserve architectural integrity, Artix enforces strict module boundary rules verified continuously by `src/test/architecture/networkBoundary.test.ts` and `src/test/sync/circularImportsDiff3AndCryptoV2.test.ts`:

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

### Prohibited Import & Network Paths
- **Rule 1 (Zero Direct Cloud Mutations on Synced Entities)**: No file outside `src/lib/sync/adapters/` may execute `.insert`, `.update`, `.delete`, or `.upsert` on `projects`, `documents`, `system_designs`, or `workspace_folders`, and no file outside `src/lib/sync/adapters/idempotency.ts` may invoke `.rpc('apply_sync_mutation')`.
- **Rule 2 (Pure Local Workspace Resource Hooks)**: `useDocuments.tsx`, `useSystemDesigns.tsx`, and `useWorkspaceFolders.tsx` must NEVER import `@/integrations/supabase/client`. `useProjects.tsx`, `useSubscription.tsx`, and `useUsageLimits.tsx` read from local Dexie once hydrated/cached and only access Supabase for online pre-hydration fallback or Edge Function checkout/portal sessions.
- **Rule 3 (No Legacy `/api/save` or `sendBeacon`)**: `tabCloseGuard.ts` flushes crash-recovery drafts strictly to user-scoped `localStorage`; `/api/save` and `navigator.sendBeacon` are banned across `src/`.
- **Rule 4 (No Reverse or Circular Sync Dependencies)**: `src/lib/repositories/` and `src/lib/sync/` never import React hooks or components, and `syncEngine.ts` / `pullEngine.ts` share `transportTimeout.ts` with zero circular imports.
