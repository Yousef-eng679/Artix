# Artix System Architecture & Runtime Structure

> **Status**: `IMPLEMENTED`  
> **Verified Against**: Productionized Billing, Strict CAS & True Offline-First Architecture (`v2.5.0`)

---

## 1. Architectural Philosophy

Artix is built upon a **Local-First, Cloud-Synchronized** architectural foundation. Unlike conventional web applications where client state is a transient cache of a remote REST or GraphQL endpoint, in Artix:

1. **Client Storage is Authoritative**: The local IndexedDB database is the primary source of truth for user interactions.
2. **Mutations are Synchronous and Local**: Every create, edit, or delete commits immediately to disk with zero network blocking.
3. **Synchronization is Asynchronous and Symmetrical**: Background workers reconcile local state with PostgreSQL via push and pull pipelines.
4. **Decoupled Architecture**: UI components possess zero knowledge of cloud endpoints, network retry semantics, or remote version numbers.

---

## 2. Complete Runtime Component Topology

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                CLIENT WORKSPACE RUNTIME                         │
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                         Presentation Layer                              │   │
│   │                                                                         │   │
│   │   [Monaco Editor]   [React Flow Canvas]   [AI Generators]   [Tab Bar]   │   │
│   └────────────────────────────────────┬────────────────────────────────────┘   │
│                                        │ React Hook Queries / Mutations         │
│                                        ▼                                        │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                      Unidirectional Hooks & Context                     │   │
│   │                                                                         │   │
│   │ [useProjects] [useDocuments] [useSystemDesigns] [useWorkspaceFolders]   │   │
│   └────────────────────────────────────┬────────────────────────────────────┘   │
│                                        │ Local Repository API                   │
│                                        ▼                                        │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                         Local Repository Layer                          │   │
│   │                                                                         │   │
│   │  ProjectRepo   DocumentRepo   SystemDesignRepo   FolderRepo   Conflict  │   │
│   └────────────────────────────────────┬────────────────────────────────────┘   │
│                                        │ Atomic Dexie Transaction               │
│                                        ▼                                        │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                   User-Scoped Dexie IndexedDB (v3, 8 Tables)            │   │
│   │                     (`ArtixDB_v2_<user_hash>`)                          │   │
│   │                                                                         │   │
│   │   ┌───────────────┐     ┌───────────────────┐    ┌──────────────────┐   │   │
│   │   │ Entity Tables │     │  Outbox Mutations │    │ Meta & Conflicts │   │   │
│   │   │ 4 Synced Types│     │  leaseToken / DAG │    │ cursor/hydration │   │   │
│   │   └───────────────┘     └─────────┬─────────┘    └──────────────────┘   │   │
│   └───────────────────────────────────┼─────────────────────────────────────┘   │
│                                       │ Drain / Catchup                         │
│                                       ▼                                         │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                      UserSyncRuntime Orchestration                      │   │
│   │                                                                         │   │
│   │   ┌───────────────────────────┐       ┌─────────────────────────────┐   │   │
│   │   │        SyncEngine         │       │         PullEngine          │   │   │
│   │   │  - Outbox Draining        │       │  - Bootstrap / Resnapshot   │   │   │
│   │   │  - Topological DAG Sort   │       │  - Cursor Range Queries     │   │   │
│   │   │  - Lease-Token Fencing    │       │  - Self-Echo & Pending Guard│   │   │
│   │   └─────────────┬─────────────┘       └──────────────▲──────────────┘   │   │
│   │                 │ Push                               │ Pull             │   │
│   │                 ▼                                    │                  │   │
│   │   ┌───────────────────────────┐       ┌──────────────┴──────────────┐   │   │
│   │   │       Push Adapters       │       │     RealtimeSyncManager     │   │   │
│   │   │  - apply_sync_mutation RPC│       │  - 50ms Burst Debouncing    │   │   │
│   │   │  - Strict CAS & Ledger    │       │  - Reconnect Catchup Trigger│   │   │
│   │   └─────────────┬─────────────┘       └──────────────▲──────────────┘   │   │
│   └─────────────────┼────────────────────────────────────┼──────────────────┘   │
│                     │ Web Locks Single-Leader Gate       │                      │
│                     ▼                                    │                      │
│   ┌──────────────────────────────────────────────────────┴──────────────────┐   │
│   │                       TabCoordinator (Web Locks)                        │   │
│   │            BroadcastChannel Event Bus (`ENTITY_CHANGED`)                │   │
│   └─────────────────────────────────┬───────────────────────────────────────┘   │
└─────────────────────────────────────┼───────────────────────────────────────────┘
                                      │ HTTPS / WebSocket (TLS)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                             SUPABASE CLOUD (PostgreSQL 17)                      │
│                                                                                 │
│   ┌────────────────────────────┐    ┌───────────────────────────────────────┐   │
│   │    Entity Tables (CAS)     │    │   Atomic RPC, Change Feed & Billing   │   │
│   │                            │    │                                       │   │
│   │  - public.projects         │    │  - public.apply_sync_mutation()       │   │
│   │  - public.documents        │    │  - public.sync_changes (commit-order) │   │
│   │  - public.system_designs   │    │  - public.processed_mutations         │   │
│   │  - public.workspace_folders│    │  - public.sync_retention_state        │   │
│   │  - version INTEGER trigger │    │  - public.reconcile_stripe_sub...()   │   │
│   │  - Row Level Security (UID)│    │  - public.manual_grants               │   │
│   └────────────────────────────┘    └───────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Subsystem Breakdown

### 3.1 Unidirectional Presentation Layer
The presentation layer (React components in `src/components/` and `src/pages/`) adheres to strict boundaries:
- **No Direct Cloud Mutations on Synced Entities**: Workspace components never mutate `projects`, `documents`, `system_designs`, or `workspace_folders` via Supabase REST; all changes flow through local repositories.
- **Hook Data Source**: Components consume custom React hooks (`useProjects`, `useDocuments`, `useSystemDesigns`, `useWorkspaceFolders`, `useWorkspaceTabs`).
- **Stale-Buffer & Conflict UX**: `Editor.tsx` and `SystemArchitect.tsx` pass `expectedLocalRevision` on save to guard against stale-buffer overwrites (`StaleBufferError`), while `Dashboard.tsx` and `ProjectWorkspaceLayout.tsx` mount `ConflictResolutionCenter` and `SyncStatusBanner`.

### 3.2 Repository Layer (`src/lib/repositories/`)
Repositories abstract all persistent operations into strongly typed domains:
- `ProjectRepository` (`projectRepository.ts`): Handles project creation, rename/update, and 6-table cascading soft-deletes.
- `DocumentRepository` (`documentRepository.ts`): Handles document creation, `expectedLocalRevision`-guarded updates, soft-deletions, and project listings.
- `SystemDesignRepository` (`systemDesignRepository.ts`): Handles canvas node/edge/stroke state serialization and `expectedLocalRevision`-guarded updates.
- `FolderRepository` (`folderRepository.ts`): Manages hierarchical folder trees, moves, and 5-table cascading deletes.
- `OutboxRepository` (`outboxRepository.ts`): Manages pending mutation queueing, 30s `leaseToken` fencing, `dispatched` immutability, per-entity causal barrier, and 7-case compaction.
- `SyncMetadataRepository` (`syncMetadataRepository.ts`): Tracks entity synchronization status (`synced`, `pending`, `syncing`, `conflict`, `error`, `deleted_pending`, `deleted_synced`), `serverVersion`, and `lastAckedMutationId`.
- `ConflictRepository` (`conflictRepository.ts`): Stores structured 3-way conflict records (`basePayload`, `localPayload`, `remotePayload`, `reason`, `remoteVersion`) and executes atomic resolution transactions.

Every state mutation executes as an **atomic 3-table Dexie transaction**:
```typescript
await db.transaction('rw', [db.documents, db.outbox, db.sync_metadata], async () => {
  await db.documents.update(id, localDoc);
  await outboxRepo.enqueue(outboxEntry);
  await syncMetadataRepo.markPending(id, 'document', revision);
});
```

### 3.3 Storage Engine (`src/lib/local/db.ts`)
- **Engine**: Dexie.js v4 on top of browser IndexedDB.
- **Database Partitioning**: Scoped by user ID using a deterministic FNV-1a 32-bit hash (`ArtixDB_v2_<hash>`).
- **Compound Indices**: Optimized for high-throughput queries:
  - `[userId+projectId]` on entity tables.
  - `[userId+entityType+entityId]` on outbox, sync_metadata, and conflicts.
- **Connection Lifecycle Safety**: Subscribes to IndexedDB `versionchange` and `blocked` events, closing idle connections to permit seamless schema upgrades across multiple tabs without crashing.

### 3.4 Synchronization Runtime (`src/lib/sync/`)
- **`UserSyncRuntime`**: Controls the lifecycle of the sync subsystems, tying them to user authentication.
- **`SyncEngine`**: Push pipeline that acquires leases, topologically sorts mutations, and invokes push adapters.
- **`PullEngine`**: Pull pipeline that fetches new rows from `public.sync_changes` using a durable sequence cursor.
- **`TabCoordinator`**: Controls multi-tab execution using the Web Locks API, guaranteeing that exactly one tab acts as the push leader.
- **`RealtimeSyncManager`**: Subscribes to Supabase Realtime channels, debouncing burst notifications and waking up the `PullEngine`.

---

## 4. Cross-Boundary Communication Protocols

### 4.1 UI to Storage (Local Memory Boundary)
- **Transport**: In-memory direct asynchronous method invocation on repository classes.
- **Data Format**: Strongly typed TypeScript objects (`LocalDocument`, `LocalSystemDesign`, `LocalWorkspaceFolder`).
- **Timing**: Immediate (0ms - 2ms).

### 4.2 Tab to Tab (Browser Process Boundary)
- **Transport**: `BroadcastChannel` (`artix_cross_tab_sync_<userScope>`).
- **Event Types**:
  - `ENTITY_CHANGED`: Sent when a local repository commits an update. Peer tabs receive this and refresh active queries.
  - `REQUEST_SYNC`: Sent by standby tabs to notify the leader tab that new outbox entries are queued.
- **Filter**: 3000ms recent-event deduplication cache prevents echo storms.

### 4.3 Client to Cloud (Network Boundary)
- **Transport**: HTTPS RPC/REST queries via Supabase client (wrapped in 30s `withTimeout`), and WSS for Realtime channels (50ms debounce).
- **Push Protocol**: Single-transaction `public.apply_sync_mutation` RPC carrying `p_mutation_id`, `p_entity_type`, `p_entity_id`, `p_operation`, `p_payload`, and `p_base_version` (`>= 1` required on `update` and `delete`). Atomically checks/inserts `public.processed_mutations`, executes `WHERE id = p_entity_id AND user_id = p_user_id AND version = p_base_version`, and stamps `mutation_id` onto `public.sync_changes`.
- **Pull Protocol**: Queries `public.get_sync_feed_bounds()` (`min_retained_sequence`, `max_sequence`) and streams batches of 50 from `public.sync_changes` (`sequence`, `entity_type`, `entity_id`, `operation`, `entity_version`, `mutation_id`, `payload`), automatically executing `bootstrapHydrateAll()` on cold start or `resnapshotAll()` when behind the retention floor.

---

## 5. Security & Isolation Model

```text
┌────────────────────────────────────────────────────────┐
│                   Browser Sandbox                      │
│                                                        │
│  User A Session               User B Session           │
│  ┌──────────────────────┐     ┌──────────────────────┐ │
│  │ ArtixDB_v2_<hash_A>  │     │ ArtixDB_v2_<hash_B>  │ │
│  │ Scoped Drafts & Tabs │     │ Scoped Drafts & Tabs │ │
│  └──────────────────────┘     └──────────────────────┘ │
└───────────────────────────┬────────────────────────────┘
                            │ Authorization: Bearer <JWT>
                            ▼
┌────────────────────────────────────────────────────────┐
│                 PostgreSQL RLS Engine                  │
│                                                        │
│  POLICY: auth.uid() = user_id                          │
│  - projects, documents, system_designs, folders        │
│  - sync_changes, processed_mutations, manual_grants    │
└────────────────────────────────────────────────────────┘
```

1. **Storage & Cache Separation**: User sessions access disjoint IndexedDB databases (`ArtixDB_v2_<hash>`) and user-scoped `localStorage` draft/tab keys. Logging out or switching accounts closes the database, evicts `TabCoordinator` and `SyncEngine` singletons, clears `QueryClient` and `dirtyTracker`, and runs `clearSensitiveBrowserCaches()`.
2. **PostgreSQL RLS**: All 14 `public` tables enforce RLS (`auth.uid() = user_id` on user-owned tables; `service_role`-only writes on `subscriptions`, `stripe_events`, `manual_grants`, and `sync_retention_state`).
3. **Client Key Encryption**: User-supplied third-party AI keys are encrypted in `localStorage` with AES-GCM 256-bit and a PBKDF2-derived key (600,000 iterations `v: 2`; legacy `v: 1` 250,000 supported for decryption). Plaintext keys are never sent to Artix servers.
