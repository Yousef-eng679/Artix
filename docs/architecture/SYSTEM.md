# Artix System Architecture & Runtime Structure

> **Status**: `IMPLEMENTED`  
> **Verified Against**: Post-C12 Synchronization Hardening (`a48c979`)

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
│   │  [useDocuments]   [useSystemDesigns]   [useWorkspaceFolders]   [Auth]   │   │
│   └────────────────────────────────────┬────────────────────────────────────┘   │
│                                        │ Local Repository API                   │
│                                        ▼                                        │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                         Local Repository Layer                          │   │
│   │                                                                         │   │
│   │   DocumentRepo    SystemDesignRepo    FolderRepo    ConflictRepo        │   │
│   └────────────────────────────────────┬────────────────────────────────────┘   │
│                                        │ Atomic Dexie Transaction               │
│                                        ▼                                        │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                     User-Scoped Dexie IndexedDB                         │   │
│   │                     (`ArtixDB_v2_<user_hash>`)                          │   │
│   │                                                                         │   │
│   │   ┌───────────────┐     ┌───────────────────┐    ┌──────────────────┐   │   │
│   │   │ Entity Tables │     │  Outbox Mutations │    │  Sync Metadata   │   │   │
│   │   │ docs/designs  │     │  leases / DAG     │    │  revisions / CAS │   │   │
│   │   └───────────────┘     └─────────┬─────────┘    └──────────────────┘   │   │
│   └───────────────────────────────────┼─────────────────────────────────────┘   │
│                                       │ Drain / Catchup                         │
│                                       ▼                                         │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                      UserSyncRuntime Orchestration                      │   │
│   │                                                                         │   │
│   │   ┌───────────────────────────┐       ┌─────────────────────────────┐   │   │
│   │   │        SyncEngine         │       │         PullEngine          │   │   │
│   │   │  - Outbox Draining        │       │  - Cursor Range Queries     │   │   │
│   │   │  - Topological DAG Sort   │       │  - Pending-State Guard      │   │   │
│   │   │  - Exponential Backoff    │       │  - 3-Way Conflict Capture   │   │   │
│   │   └─────────────┬─────────────┘       └──────────────▲──────────────┘   │   │
│   │                 │ Push                               │ Pull             │   │
│   │                 ▼                                    │                  │   │
│   │   ┌───────────────────────────┐       ┌──────────────┴──────────────┐   │   │
│   │   │       Push Adapters       │       │     RealtimeSyncManager     │   │   │
│   │   │  - CAS Version Verification│      │  - 150ms Burst Debouncing   │   │   │
│   │   │  - Idempotency Ledger     │       │  - Reconnect Catchup Trigger│   │   │
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
│                                 SUPABASE CLOUD                                  │
│                                                                                 │
│   ┌────────────────────────────┐    ┌───────────────────────────────────────┐   │
│   │    Entity Tables (CAS)     │    │        Append-Only Replication        │   │
│   │                            │    │                                       │   │
│   │  - public.documents        │    │  - public.sync_changes                │   │
│   │  - public.system_designs   │    │    (BIGINT sequence identity)         │   │
│   │  - public.workspace_folders│    │                                       │   │
│   │  - version INTEGER trigger │    │  - public.processed_mutations         │   │
│   │  - Row Level Security (UID)│    │    (mutation_id idempotency ledger)   │   │
│   └────────────────────────────┘    └───────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Subsystem Breakdown

### 3.1 Unidirectional Presentation Layer
The presentation layer (React components in `src/components/` and `src/pages/`) adheres to one invariant:
- **No Direct Cloud Imports**: Components never import `@/integrations/supabase/client` or perform remote fetches.
- **Hook Data Source**: Components consume custom React hooks (`useDocuments`, `useSystemDesigns`, `useWorkspaceFolders`, `useWorkspaceTabs`).
- **Optimistic Rendering**: State is read directly from IndexedDB via live queries and cached React state.

### 3.2 Repository Layer (`src/lib/repositories/`)
Repositories abstract all persistent operations into strongly typed domains:
- `DocumentRepository`: Handles document creation, updates, soft-deletions, and project listings.
- `SystemDesignRepository`: Handles canvas node/edge state serialization and updates.
- `WorkspaceFolderRepository`: Manages hierarchical folder trees, moves, and cascading deletes.
- `OutboxRepository`: Manages pending mutation queueing, in-flight leases, and outbox compaction.
- `SyncMetadataRepository`: Tracks entity synchronization status (`synced`, `pending`, `syncing`, `conflict`, `error`) and baseline server versions.
- `ConflictRepository`: Stores structured 3-way conflict records (`base`, `local`, `remote`).

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
- **Transport**: HTTPS REST queries via Supabase client, and WSS for Realtime channels.
- **Push Payload**: Outbox entry payload + `baseServerVersion` + `mutationId`.
- **Pull Payload**: Array of change events from `public.sync_changes` (`sequence`, `entity_type`, `entity_id`, `operation`, `entity_version`, `payload`).
- **Idempotency Check**: Look up `processed_mutations` using UUID v4 `mutationId`.
- **Concurrency Check**: Optimistic SQL filter `WHERE id = :id AND version = :baseServerVersion`.

---

## 5. Security & Isolation Model

```text
┌────────────────────────────────────────────────────────┐
│                   Browser Sandbox                      │
│                                                        │
│  User A Session               User B Session           │
│  ┌──────────────────────┐     ┌──────────────────────┐ │
│  │ ArtixDB_v2_<hash_A>  │     │ ArtixDB_v2_<hash_B>  │ │
│  │ Local Outbox / State │     │ Local Outbox / State │ │
│  └──────────────────────┘     └──────────────────────┘ │
└───────────────────────────┬────────────────────────────┘
                            │ Authorization: Bearer <JWT>
                            ▼
┌────────────────────────────────────────────────────────┐
│                 PostgreSQL RLS Engine                  │
│                                                        │
│  POLICY: auth.uid() = user_id                          │
│  - documents, system_designs, workspace_folders        │
│  - sync_changes, processed_mutations                   │
└────────────────────────────────────────────────────────┘
```

1. **Storage Separation**: User sessions access disjoint IndexedDB databases. Logging out completely closes and disposes of the active database instance.
2. **PostgreSQL RLS**: Cloud queries enforce `auth.uid() = user_id`. Even if a client crafts a malicious REST call, Supabase database policies reject cross-tenant reads and writes.
3. **Client Key Encryption**: User-supplied third-party AI keys are encrypted in `localStorage` with AES-GCM 256-bit and a PBKDF2-derived key (100,000 iterations). Plaintext keys are never sent to Artix servers.
