# Artix Dependency Boundaries & Isolation Invariants

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/test/architecture/networkBoundary.test.ts` (Phase C4)

---

## 1. Overview

A critical objective of the Phase C4 synchronization hardening was the complete elimination of hook-level and component-level remote reads. In naive architectures, client components frequently interleave local state updates with direct cloud requests, resulting in race conditions, UI blocking during network drops, and corrupted offline states.

Artix enforces strict, test-verified isolation boundaries between:
1. The **User Interface Layer**
2. The **Local Repository Layer**
3. The **Synchronization Layer**
4. The **Cloud Network Boundary**

---

## 2. Formal Boundary Definitions

```text
┌────────────────────────────────────────────────────────┐
│                   PRESENTATION BOUNDARY                │
│                                                        │
│  UI Components ──► Domain Hooks (useDocuments, etc)    │
│  Constraint: ZERO direct network calls                 │
└───────────────────────────┬────────────────────────────┘
                            │ Method Invocations
                            ▼
┌────────────────────────────────────────────────────────┐
│                    REPOSITORY BOUNDARY                 │
│                                                        │
│  Repositories ──► Local Dexie IndexedDB                │
│  Constraint: Atomic 3-table Dexie transactions         │
│              ZERO direct push/pull network calls       │
└───────────────────────────┬────────────────────────────┘
                            │ Outbox Mutation Enqueue
                            ▼
┌────────────────────────────────────────────────────────┐
│                   SYNCHRONIZATION BOUNDARY             │
│                                                        │
│  SyncEngine / PullEngine ──► Web Locks TabCoordinator  │
│  Constraint: Only elected leader tab communicates      │
│              with Supabase cloud                       │
└───────────────────────────┬────────────────────────────┘
                            │ HTTPS REST / WSS
                            ▼
┌────────────────────────────────────────────────────────┐
│                     NETWORK BOUNDARY                   │
│                                                        │
│  Supabase Cloud (PostgreSQL RLS, sync_changes)         │
│  Constraint: CAS version verification on all updates   │
│              Idempotency check via processed_mutations │
└────────────────────────────────────────────────────────┘
```

---

## 3. Boundary Invariants

### Invariant 1: Unidirectional Local-First Read Invariant
- **Rule**: All UI data fetching queries strictly read from the local IndexedDB database.
- **Verification**: `src/test/architecture/networkBoundary.test.ts` scans all hook files (`src/hooks/useDocuments.tsx`, `useSystemDesigns.tsx`, `useWorkspaceFolders.tsx`). Any import of `@/integrations/supabase/client` or direct `.from('documents').select(...)` throws a test failure.

### Invariant 2: Atomic Local Mutation Invariant
- **Rule**: Every user-initiated change must write the entity state, enqueue the outbox entry, and update sync metadata in a single atomic Dexie transaction:
  ```typescript
  await db.transaction('rw', [db.documents, db.outbox, db.sync_metadata], async () => { ... });
  ```
- **Consequence**: An entity can never be modified locally without a corresponding outbox record being scheduled. Partial failures are impossible.

### Invariant 3: Single-Leader Push Invariant
- **Rule**: Only the tab holding the `artix_sync_leader_lock` Web Lock can communicate with Supabase for outbox draining.
- **Standby Tabs**: Standby tabs enqueue mutations locally and notify the leader over `BroadcastChannel`. They never open direct HTTP push requests, preventing concurrent duplicate writes.

### Invariant 4: CAS Baseline Version Invariant
- **Rule**: Every outbox update and delete mutation MUST carry the `baseServerVersion` that was active when the local edit began.
- **Consequence**: The server will reject any update if the row was modified remotely by another device in the interim, preventing silent Lost Updates.

### Invariant 5: Safe Remote Application Invariant
- **Rule**: `PullEngine` must inspect the outbox before applying any remote snapshot. If an entity has local unpushed edits, the remote snapshot must NOT overwrite local memory; instead, a 3-way conflict is recorded and the outbox entry is marked `blocked`.

---

## 4. Automated Architecture Boundary Tests

These invariants are continuously guarded by automated Vitest suites:

```text
src/test/architecture/networkBoundary.test.ts
✓ useDocuments does not import or invoke supabase client directly
✓ useSystemDesigns does not import or invoke supabase client directly
✓ useWorkspaceFolders does not import or invoke supabase client directly
✓ Workspace components do not perform direct cloud mutations
```
