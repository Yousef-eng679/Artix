# Artix Architecture Overview & High-Level Design

> **Status**: `IMPLEMENTED`  
> **Architecture Paradigm**: Local-First IndexedDB Authority with Asynchronous Cloud Sync

---

## 1. Executive Summary

Artix is architected as an **authoritative client application** with cloud backup and synchronization, rather than a thin client connecting to a server API.

```text
┌────────────────────────────────────────────────────────┐
│                      Client Device                     │
│                                                        │
│  [UI Layer: React 18, Monaco Editor, React Flow]       │
│                           │                            │
│                           ▼ (Local Method Calls)       │
│  [Repository Layer: Project, Folder, Document, Design] │
│                           │                            │
│                           ▼ (Atomic Dexie Transaction) │
│  [Local Database: ArtixDB_v2_<hash> on IndexedDB (v3)] │
│  - Entities (projects, folders, documents, designs)    │
│  - Outbox (transactional mutation queue + leaseToken)  │
│  - Sync Metadata (revisions, syncState, serverVersion) │
│  - Database Meta (server_cursor, hydration, caches)    │
│                           │                            │
│                           ▼ (Background Sync Workers)  │
│  [Sync Runtime: SyncEngine (Push), PullEngine (Pull)]  │
└───────────────────────────┬────────────────────────────┘
                            │ HTTPS / TLS (Async RPC, REST & WebSocket)
                            ▼
┌────────────────────────────────────────────────────────┐
│                      Supabase Cloud                    │
│                                                        │
│  [PostgreSQL 17 Database]                              │
│  - Row Level Security (RLS) enforcement                │
│  - Atomic CAS & Idempotency RPC (apply_sync_mutation)  │
│  - Commit-Ordered Change Feed (sync_changes)           │
│  - Retention Floor Watermark (sync_retention_state)    │
│  - Atomic Billing Reconciliation & manual_grants       │
└────────────────────────────────────────────────────────┘
```

---

## 2. Core Architectural Pillars

1. **Local-First Authority**:
   - IndexedDB is the primary database. The application never waits for the network to render UI, save drafts, or delete folders.
   - Offline sessions are first-class citizens.
2. **Deterministic Concurrency Control**:
   - Compare-and-Swap (CAS) version predicates prevent concurrent devices from overwriting changes.
   - Concurrency conflicts halt outbox processing and trigger automated 3-way line diffing (`diff3`).
3. **Single-Leader Multi-Tab Coordination**:
   - The browser's native Web Locks API (`navigator.locks`) elects exactly one leader tab to drain the outbox to Supabase.
   - Standby tabs write to IndexedDB and coordinate via `BroadcastChannel`.
4. **Append-Only Replication Feed & Retention Floor Recovery**:
   - Remote changes stream through a commit-ordered sequence log (`public.sync_changes` with `mutation_id` self-echo correlation).
   - Clients maintain monotonic cursors (`database_meta['server_cursor']`), bootstrap on first login (`bootstrapHydrateAll`), and automatically re-snapshot (`resnapshotAll`) if offline longer than the `sync_retention_state` pruning window.
5. **Session-Scoped Lifecycle & Offline Cold-Start Continuity**:
   - Storage instances, `QueryClient`, `TabCoordinator`, and `localStorage` draft/tab namespaces are strictly partitioned per user. Booting offline with an expired JWT preserves local workspace access via `recoverOfflineSessionFromStorage()` while pausing cloud sync until token refresh succeeds.

---

## 3. Subsystem Architecture Map

- **[System Architecture & Runtime Topology](./SYSTEM.md)**: Detailed breakdown of presentation, repository, storage, and cloud layers.
- **[Data Model & State Machines](./DATA_MODEL.md)**: Formal schemas, table structures, and lifecycle state machines.
- **[Application & Session Lifecycle](./APPLICATION_LIFECYCLE.md)**: Startup, login, logout, account switching, and crash recovery.
- **[Code Organization & Module Responsibilities](./CODE_ORGANIZATION.md)**: Directory layout and module boundaries.
- **[Dependency Boundaries & Isolation Invariants](./DEPENDENCY_BOUNDARIES.md)**: Architectural constraints preventing direct cloud reads from UI components.
