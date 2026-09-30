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
│  [Repository Layer: DocumentRepo, SystemDesignRepo]    │
│                           │                            │
│                           ▼ (Atomic Dexie Transaction) │
│  [Local Database: ArtixDB_v2_<hash> on IndexedDB]      │
│  - Entities (documents, system_designs, folders)       │
│  - Outbox (transactional mutation queue)               │
│  - Sync Metadata (revisions, syncState, cursors)       │
│                           │                            │
│                           ▼ (Background Sync Workers)  │
│  [Sync Runtime: SyncEngine (Push), PullEngine (Pull)]  │
└───────────────────────────┬────────────────────────────┘
                            │ HTTPS / TLS (Async REST & WebSocket)
                            ▼
┌────────────────────────────────────────────────────────┐
│                      Supabase Cloud                    │
│                                                        │
│  [PostgreSQL 15 Database]                              │
│  - Row Level Security (RLS) enforcement                │
│  - CAS Version Triggers (increment_entity_version)     │
│  - Append-Only Change Feed (sync_changes)              │
│  - Idempotency Ledger (processed_mutations)            │
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
4. **Append-Only Replication Feed**:
   - Remote changes stream through an ordered sequence log (`public.sync_changes`).
   - Clients maintain monotonic cursors, preventing dropped events during network reconnects.
5. **Session-Scoped Lifecycle**:
   - Storage instances and synchronization workers are strictly bounded by user authentication. Switching accounts closes databases with zero memory or disk leaks.

---

## 3. Subsystem Architecture Map

- **[System Architecture & Runtime Topology](./SYSTEM.md)**: Detailed breakdown of presentation, repository, storage, and cloud layers.
- **[Data Model & State Machines](./DATA_MODEL.md)**: Formal schemas, table structures, and lifecycle state machines.
- **[Application & Session Lifecycle](./APPLICATION_LIFECYCLE.md)**: Startup, login, logout, account switching, and crash recovery.
- **[Code Organization & Module Responsibilities](./CODE_ORGANIZATION.md)**: Directory layout and module boundaries.
- **[Dependency Boundaries & Isolation Invariants](./DEPENDENCY_BOUNDARIES.md)**: Architectural constraints preventing direct cloud reads from UI components.
