# Artix Offline-First Infrastructure & Synchronization Architecture Plan

> **Purpose:** Define the architecture and implementation roadmap for transforming Artix into a robust offline-first application built around IndexedDB, with a durable synchronization system against Supabase.
>
> **Primary goal:** Deliver an offline editing experience that feels immediate and reliable while making synchronization resilient to disconnects, retries, crashes, conflicts, multiple tabs, authentication changes, deletes, and other real-world edge cases.

---

## 1. Executive Summary

The existing Artix architecture has a strong foundation for moving toward an offline-first model:

- Project Workspace architecture
- Normalized document/design resources
- Workspace folders
- Tabs
- Autosave
- Draft recovery
- Save queues
- Supabase persistence
- React Query caching
- Existing optimistic concurrency checks

However, the current persistence model is still primarily network-oriented.

The target architecture should instead make the local database the immediate source of truth:

```text
                     ┌──────────────────────┐
                     │       Artix UI       │
                     │ Editors / Workspace  │
                     └──────────┬───────────┘
                                │
                         Local Repository
                                │
                    ┌───────────┴───────────┐
                    │                       │
               Local State              Sync State
                    │                       │
                IndexedDB                Outbox
                    │                       │
                    └───────────┬───────────┘
                                │
                          Sync Engine
                                │
                 ┌──────────────┴──────────────┐
                 │                             │
          Pull / Reconcile                Push / Retry
                 │                             │
                 └──────────────┬──────────────┘
                                │
                           Supabase
                                │
                         Realtime Events
```

The central principle is:

> **A user's local transaction is the save. Cloud synchronization is a separate process.**

The UI should never need to wait for Supabase to determine whether an edit has been saved.

---

# 2. Current Artix Architecture Assessment

The plan below is based on inspection of the current `feat/project-workspace-ux` codebase and its existing persistence architecture.

## 2.1 Current Document Persistence

The current document flow is approximately:

```text
React
  ↓
useDocuments
  ↓
Supabase
```

`useDocuments.tsx` currently owns network persistence operations such as:

- SELECT
- INSERT
- UPDATE
- DELETE
- React Query cache updates/invalidation

The current update path already contains an optimistic concurrency check using `updated_at`.

Conceptually:

```text
UPDATE document
WHERE id = X
AND updated_at = expectedUpdatedAt
```

This is useful for detecting stale writes, but it is not sufficient as the complete synchronization protocol.

---

## 2.2 Current System Design Persistence

System designs similarly persist through Supabase.

The important workspace entity contains fields such as:

```text
id
project_id
user_id
name
board_state
folder_id
created_at
updated_at
```

The `board_state` contains structured design data such as:

```text
nodes
edges
strokes
```

This makes system designs a particularly important test case for the future local database because their state can be significantly larger and more structured than a normal document.

---

## 2.3 Existing Autosave Infrastructure

Artix already contains persistence-related infrastructure including:

```text
autosave.ts
debouncedSave.ts
saveQueue.ts
draftRecovery.ts
tabCloseGuard.ts
tabSync.ts
```

These are valuable because they already encode several concerns that the new architecture needs to formalize:

- debouncing
- serial saves
- draft durability
- recovery
- dirty state
- tab coordination
- close protection

They should therefore be treated as migration references rather than immediately deleted.

---

## 2.4 Existing Workspace Architecture

The current workspace already provides a normalized resource layer for documents and designs.

Conceptually:

```text
Document
Design
   ↓
resourceAdapter
   ↓
WorkspaceResource
   ↓
Workspace
```

This gives the offline-first implementation a natural abstraction boundary.

The new persistence architecture should not be built separately for every UI component.

Instead:

```text
useDocuments
      │
      ▼
DocumentRepository
      │
      ▼
LocalDatabase
```

and:

```text
useSystemDesigns
      │
      ▼
SystemDesignRepository
      │
      ▼
LocalDatabase
```

The UI should not need to know whether data is currently offline, synchronizing, reconnecting, or resolving a conflict.

---

# 3. Core Architectural Principles

These principles should be treated as architectural constraints.

## 3.1 Local State Is the Immediate Source of Truth

```text
UI
 ↓
IndexedDB
```

is the immediate persistence path.

Supabase becomes the cloud synchronization authority rather than the UI's direct persistence dependency.

## 3.2 Synchronization Is Independent From Editing

Editing should work without the network.

```text
User edits
   ↓
Local transaction
   ↓
Durable
   ↓
Outbox marked pending
```

Separately:

```text
Outbox
   ↓
Sync Engine
   ↓
Supabase
```

## 3.3 Realtime Is an Accelerator, Not the Reliability Layer

Supabase Realtime should not be treated as the authoritative synchronization mechanism.

A disconnected client can miss Realtime events.

Therefore:

```text
Realtime ≠ synchronization
```

Instead:

```text
Realtime = synchronization accelerator
```

Realtime can tell the client:

> Something changed.

The synchronization engine must then perform an authoritative reconciliation/pull.

## 3.4 Never Silently Destroy Concurrent Edits

The initial synchronization system should not blindly implement:

```text
remote wins
```

or:

```text
local wins
```

for all conflicts.

Conflicts should be explicitly detected and preserved.

## 3.5 Timestamps Are Not Causality

Do not use local wall-clock timestamps as the authoritative ordering mechanism.

Use:

```text
localRevision
```

for local ordering and:

```text
serverVersion / serverRevision
```

for server ordering.

Timestamps remain useful metadata, but they should not be treated as proof of causal ordering.

---

# 4. IndexedDB Architecture

IndexedDB is the storage mechanism, not the application architecture.

Artix should expose repository abstractions above the database:

```text
Artix
  ↓
Repository API
  ↓
Local Database
  ↓
IndexedDB
```

A library such as Dexie is a strong candidate for simplifying:

- transactions
- schema migrations
- indexes
- async queries
- error handling
- multi-tab behavior
- reactive access

However, Artix should not expose Dexie directly throughout the application.

Recommended boundary:

```text
Artix
  ↓
DocumentRepository
  ↓
LocalDatabase
  ↓
Dexie
  ↓
IndexedDB
```

This keeps the application independent of the underlying IndexedDB wrapper.

---

# 5. Local Database Schema

Recommended stores:

```text
ArtixDB
│
├── documents
├── system_designs
├── workspace_folders
│
├── outbox
├── sync_metadata
│
├── conflicts
└── database_meta
```

## 5.1 Domain Stores

### `documents`

Contains locally authoritative document state.

### `system_designs`

Contains locally authoritative design state.

### `workspace_folders`

Contains locally authoritative folder state.

Domain records should primarily contain domain information rather than synchronization machinery.

## 5.2 `sync_metadata`

Synchronization metadata should be separate from domain state.

Example:

```ts
interface SyncMetadata {
  entityType: EntityType
  entityId: string

  serverVersion: string | null
  serverUpdatedAt: string | null

  localRevision: number

  syncState:
    | 'synced'
    | 'pending'
    | 'syncing'
    | 'conflict'
    | 'error'

  lastSyncedAt: number | null
}
```

## 5.3 `conflicts`

A conflict record should preserve enough information to prevent accidental data destruction.

At minimum, preserve:

```text
Base
Local
Remote
```

along with affected entity and synchronization metadata.

## 5.4 `database_meta`

Used for local database-level information such as:

```text
schemaVersion
databaseInstanceId
lastMigration
```

---

# 6. Entity Identity

Offline creation requires entities to have IDs before they reach the server.

Use client-generated UUIDs where compatible with the existing Supabase schema:

```ts
const id = crypto.randomUUID()
```

This enables:

```text
Offline
  ↓
Create document
  ↓
Document immediately receives an ID
  ↓
Document can be edited, opened, renamed, moved, and deleted
  ↓
Synchronization happens later
```

---

# 7. Revision Model

Every locally changed entity should have a monotonically increasing local revision.

Example:

```text
Document X

localRevision:
184
185
186
187
```

The revision represents local state progression.

Server-side versions should be treated separately:

```text
localRevision = 187
serverVersion = 91
```

---

# 8. Outbox Architecture

The outbox records synchronization work rather than becoming the source of truth for domain data.

Recommended conceptual structure:

```ts
interface OutboxEntry {
  id: string

  entityType:
    | 'document'
    | 'system_design'
    | 'workspace_folder'

  entityId: string

  operation:
    | 'create'
    | 'update'
    | 'delete'

  baseServerVersion: string | null

  localRevision: number

  payload: unknown

  state:
    | 'pending'
    | 'in_flight'
    | 'blocked'
    | 'failed'

  attemptCount: number

  createdAt: number
  updatedAt: number

  lastError?: {
    code: string
    message: string
    at: number
  }
}
```

The exact schema should be finalized during the synchronization-contract phase.

---

# 9. Outbox Coalescing

The system must not create one network mutation per keystroke.

For example:

```text
H
He
Hel
Hell
Hello
```

should not result in:

```text
UPDATE H
UPDATE He
UPDATE Hel
UPDATE Hell
UPDATE Hello
```

Instead, the local entity changes immediately while the outbox represents the minimum synchronization work needed.

---

# 10. Mutation Compaction

The sync layer should compact compatible pending mutations.

### Create → Update → Update

Can generally become:

```text
CREATE(final state)
```

### Create → Update → Delete

Can become:

```text
nothing
```

because the entity never needs to exist remotely.

### Update → Update → Update

Can become:

```text
UPDATE(latest local state)
```

---

# 11. Synchronization State Machine

Recommended states:

```text
idle
offline
syncing
blocked
conflict
error
```

Example:

```text
             ┌───────────┐
             │   idle    │
             └─────┬─────┘
                   │
              local changes
                   │
                   ▼
             ┌───────────┐
             │  pending  │
             └─────┬─────┘
                   │
                network
                   │
                   ▼
             ┌───────────┐
             │ syncing   │
             └─────┬─────┘
              ┌────┼─────┐
              │    │     │
              ▼    ▼     ▼
           synced conflict error
```

---

# 12. Reconnect Algorithm

Recommended flow:

```text
OFFLINE
  │
  │ local edits
  ▼
IndexedDB
  │
  │ outbox grows
  ▼
NETWORK RETURNS
  │
  ▼
Sync Engine wakes
  │
  ├── Pull remote changes
  │
  ├── Reconcile local state
  │
  ├── Detect conflicts
  │
  ├── Push safe mutations
  │
  ├── Confirm server versions
  │
  └── Advance sync checkpoint
  │
  ▼
SYNCED
```

The exact push/pull ordering must be finalized in the synchronization protocol because it affects conflict semantics.

---

# 13. Durable Pull Synchronization

The client needs an authoritative way to discover remote changes after being offline.

Do not rely exclusively on:

```text
updated_at > lastSync
```

because deletes cannot be discovered once the row disappears.

The server side therefore needs a durable change/deletion strategy.

---

# 14. Tombstones and Deletions

Deletion is one of the most important synchronization problems.

Example:

```text
Client A
offline
Document X → DELETE
```

Meanwhile:

```text
Client B
online
Document X → UPDATE
```

The system needs explicit semantics for the resulting conflict.

Additionally, an offline client must be able to learn that a remote resource was deleted.

Possible strategy:

```text
documents
 ├── deleted_at
```

or a dedicated server-side deletion/change log.

The final design should guarantee that deletions remain discoverable long enough for relevant clients to reconcile them.

---

# 15. Conflict Detection

Example:

```text
Server
  Version 10
      │
      ├──── Client A goes offline
      │          ↓
      │       Local edit
      │
      └──── Client B
                 ↓
              Server Version 11
```

Client A reconnects with:

```text
baseVersion = 10
```

while the server is:

```text
version = 11
```

This is a real conflict.

The existing `updated_at` conditional update can help detect it, but the new sync protocol needs a complete conflict lifecycle.

---

# 16. Conflict Preservation

When a conflict is detected, preserve:

```text
Base
Local
Remote
```

Then:

```text
Conflict
   ↓
Conflict Resolver
   ↓
Automatic merge where safe
   ↓
Manual resolution where necessary
```

Never silently overwrite one side.

---

# 17. Document Conflict Resolution

Documents can potentially use a three-way merge:

```text
Base
Local
Remote
 ↓
3-way merge
 ↓
automatically resolved sections
 ↓
manual conflict sections
```

The exact merge algorithm should be chosen and tested separately from the synchronization engine.

---

# 18. System Design Conflict Resolution

System design state contains structured JSON such as:

```text
nodes
edges
strokes
```

Arbitrary JSON should not automatically be treated as safely mergeable.

The initial design should favor conservative preservation:

```text
Local version
Remote version
Conflict copy / resolution workflow
```

rather than silently attempting unsafe structural merges.

---

# 19. Idempotency

The synchronization engine must handle requests where the server successfully commits an operation but the client never receives the response.

Example:

```text
Client
   │
   │ UPDATE
   ▼
Server
   │
   │ commit succeeds
   X
network response lost
```

The client may retry.

Every mutation should therefore have a unique:

```text
mutationId
```

and server processing must make retrying the same operation safe.

---

# 20. Duplicate Delivery

A remote update can potentially be observed through:

```text
REST pull
Realtime
reconnect reconciliation
```

Applying the same remote version multiple times must be harmless.

Remote versions/revisions should provide deterministic deduplication.

---

# 21. Out-of-Order Remote Changes

The client must not assume every synchronization path delivers:

```text
Version 12
Version 13
Version 14
```

in perfect order.

If the client already has:

```text
Version 14
```

and receives:

```text
Version 12
```

the older state must not overwrite the newer state.

---

# 22. Realtime Design

Realtime should operate as an acceleration path:

```text
Supabase Realtime
       ↓
"Something changed"
       ↓
Sync Engine
       ↓
Pull / reconcile
```

It should not directly become:

```text
Realtime event
       ↓
blindly overwrite IndexedDB
```

This keeps synchronization reliable even when Realtime disconnects or events are missed.

---

# 23. Multi-Tab Architecture

Multiple Artix tabs should share the same local database.

Conceptually:

```text
                 IndexedDB
                    ▲
                    │
          ┌─────────┴─────────┐
          │                   │
        Tab A               Tab B
          │                   │
          └──── BroadcastChannel ────┘
                    │
             Sync Coordinator
```

BroadcastChannel should be a notification/coordination mechanism, not the source of truth.

When Tab B receives a notification, it should re-read the authoritative record from IndexedDB.

---

# 24. Sync Leadership

Only one tab should normally perform network synchronization work at a time.

Preferred mechanism:

```text
Web Locks API
```

where available.

A carefully designed lease fallback may be required where Web Locks is unavailable.

The system must avoid a permanent state where multiple tabs believe they independently own the sync worker.

---

# 25. Browser Crash Recovery

Consider:

```text
Outbox entry
    ↓
in_flight
    ↓
Browser crashes
```

The entry must not become permanently stuck.

Use lease-like information:

```text
leaseId
leaseExpiresAt
attemptCount
```

After the lease expires:

```text
in_flight
    ↓
pending
```

and the mutation can safely be retried.

---

# 26. Network Failure During Requests

The system must distinguish:

```text
request failed before server commit
```

from:

```text
server committed but response was lost
```

The second case is why idempotency is mandatory.

A retry should be safe in either case.

---

# 27. Authentication Boundaries

Consider:

```text
User A
offline
edits document
```

then:

```text
logout
login as User B
```

The application must never send User A's pending mutations using User B's credentials.

The local database should therefore be user/project scoped.

Conceptually:

```text
ArtixDB
├── user A
│   ├── project X
│   └── project Y
│
└── user B
    └── project Z
```

On logout:

```text
stop sync
stop timers
stop subscriptions
freeze old user's outbox
clear sensitive session state
```

---

# 28. Authorization Changes

A local record may exist even after the server no longer permits the user to modify it.

The sync engine must distinguish:

```text
Network unavailable
```

from:

```text
Server rejected mutation
```

For example:

```text
401 / 403 / RLS rejection
       ↓
authorization_error
```

This should not be treated as a temporary network retry.

---

# 29. Storage Quota

IndexedDB storage is finite.

The system must explicitly handle:

```text
QuotaExceededError
```

Recommended observable storage states:

```text
healthy
warning
critical
failed
```

The application should never silently lose a local write because the browser's storage quota was exhausted.

---

# 30. IndexedDB Schema Migration

IndexedDB version upgrades introduce multi-tab edge cases.

Example:

```text
Tab A → DB v4
Tab B → DB v4

New Artix version → DB v5
```

The older tab may block the upgrade.

The application should detect:

```text
versionchange
blocked
```

and provide a controlled recovery flow.

Conceptually:

```text
New version detected
       ↓
Notify old tabs
       ↓
Request graceful DB close
       ↓
Upgrade database
```

If necessary, show a user-facing message requesting that another Artix tab be refreshed.

---

# 31. Offline Editing UX

The editor should behave like:

```text
User types
   ↓
React state
   ↓
IndexedDB transaction
   ↓
local revision++
   ↓
outbox marked pending
   ↓
UI immediately shows:
"Saved locally"
```

The network should not block the editor.

---

# 32. Save-State UX

Recommended states:

```text
Saved locally
Syncing…
Synced
Offline — saved locally
Sync delayed
Sync conflict
Sync failed
```

Example:

```text
● Saved locally
↻ Syncing…
✓ Synced
⚡ Offline — saved locally
⚠ Sync conflict
✕ Sync failed
```

Core principle:

> **A network failure must not feel like a document-save failure.**

---

# 33. React Query's Future Role

React Query does not necessarily need to be removed immediately.

The future architecture can initially be:

```text
IndexedDB
   ↓
Local Repository
   ↓
React Query
   ↓
UI
```

The important change is that React Query is no longer the durable persistence authority.

IndexedDB becomes durable state.

React Query can remain as a UI/query orchestration layer during migration.

---

# 34. Migration of Existing Persistence Utilities

Existing utilities should be migrated gradually.

Important existing files include:

```text
autosave.ts
debouncedSave.ts
saveQueue.ts
draftRecovery.ts
tabCloseGuard.ts
tabSync.ts
```

Do not delete these immediately.

Map each responsibility into the new architecture first:

```text
Old debounce
   ↓
local write scheduling

Old save queue
   ↓
outbox

Old draft recovery
   ↓
durable IndexedDB local state

Old tabSync
   ↓
BroadcastChannel + sync coordination

Old tab close guard
   ↓
dirty state + local persistence guarantees
```

After migration and validation, legacy code can be removed.

---

# 35. Recommended Project Structure

Eventually:

```text
src/
│
├── lib/
│   │
│   ├── local/
│   │   ├── db.ts
│   │   ├── schema.ts
│   │   ├── migrations.ts
│   │   ├── errors.ts
│   │   └── types.ts
│   │
│   ├── repositories/
│   │   ├── documentRepository.ts
│   │   ├── systemDesignRepository.ts
│   │   └── workspaceFolderRepository.ts
│   │
│   ├── sync/
│   │   ├── syncEngine.ts
│   │   ├── outbox.ts
│   │   ├── mutationCompactor.ts
│   │   ├── retryPolicy.ts
│   │   ├── conflictDetector.ts
│   │   ├── conflictResolver.ts
│   │   ├── checkpoint.ts
│   │   ├── coordinator.ts
│   │   └── syncState.ts
│   │
│   └── workspace/
│
├── hooks/
│   ├── useDocuments.ts
│   ├── useSystemDesigns.ts
│   └── ...
│
└── components/
```

Exact filenames should be adjusted to current Artix conventions during implementation.

---

# 36. Implementation Roadmap

## Phase 0 — Synchronization Contract

Create:

```text
docs/OFFLINE_FIRST_ARCHITECTURE.md
docs/SYNC_PROTOCOL.md
```

Define:

- entity identity
- local revisions
- server versions
- mutation IDs
- outbox semantics
- mutation compaction
- conflict states
- conflict preservation
- deletion/tombstone semantics
- synchronization checkpoints
- retry behavior
- idempotency
- authentication boundaries
- multi-tab coordination
- Realtime responsibilities

### Exit condition

The team can explain exactly what happens when a user:

- edits offline
- deletes offline
- reconnects
- edits on two devices
- crashes during synchronization
- logs out with pending mutations
- receives duplicate events

without inventing behavior during implementation.

---

## Phase 1 — IndexedDB Foundation

Create:

```text
src/lib/local/
├── db.ts
├── schema.ts
├── migrations.ts
├── errors.ts
└── types.ts
```

Then:

```text
src/lib/repositories/
├── documentRepository.ts
├── systemDesignRepository.ts
└── workspaceFolderRepository.ts
```

Do not implement full cloud synchronization yet.

### Goal

Artix can read and write project data entirely locally.

---

## Phase 2 — Local-First Documents

Migrate:

```text
Editor
   ↓
useDocuments
   ↓
DocumentRepository
   ↓
IndexedDB
```

Critical property:

```text
edit
 ↓
local transaction
 ↓
durable
 ↓
UI updates
```

Then separately:

```text
outbox
 ↓
pending
```

### Milestone

Turn off the network.

The user should still be able to:

- open documents
- edit documents
- close/reopen Artix
- recover edits
- navigate workspace
- use tabs

---

## Phase 3 — Local-First System Architect

Migrate:

```text
system_designs
```

Test large and complex board states:

```text
nodes
edges
strokes
```

---

## Phase 4 — Durable Outbox

Implement:

```text
src/lib/sync/
├── syncEngine.ts
├── outbox.ts
├── retryPolicy.ts
├── mutationCompactor.ts
└── syncState.ts
```

Requirements:

- mutation IDs
- retries
- exponential backoff
- jitter
- idempotency
- optimistic concurrency
- acknowledgements
- stale mutation detection
- crash recovery

---

## Phase 5 — Push Synchronization

Implement:

```text
IndexedDB
    ↓
Outbox
    ↓
Supabase
```

Handle:

- successful push
- failed push
- timeout
- duplicate retry
- lost response
- server rejection
- authorization rejection
- conflict detection

---

## Phase 6 — Pull/Reconciliation

Implement:

```text
Supabase
    ↓
Pull/Reconciliation
    ↓
IndexedDB
```

Solve:

- remote updates
- remote deletes
- missed changes
- synchronization checkpoints
- duplicate events
- out-of-order events
- stale local state

---

## Phase 7 — Realtime Acceleration

Only after reliable pull/push synchronization works:

```text
Supabase Realtime
        ↓
"Something changed"
        ↓
Sync Engine
        ↓
Pull/reconcile
```

Realtime should reduce latency, not provide the durability guarantee.

---

## Phase 8 — Multi-Tab Synchronization

Implement:

```text
BroadcastChannel
+
Sync leadership
+
IndexedDB observation
```

Test:

```text
Tab A edits
Tab B sees update

Tab A offline
Tab B online

Tab A closes
Tab B becomes sync leader

Tab A and Tab B edit the same resource
```

---

## Phase 9 — Conflict UX

After conflict detection is reliable, implement user-facing resolution.

For documents:

```text
Local
Remote
Base
 ↓
3-way merge
 ↓
automatic resolution
 ↓
manual resolution
```

For designs:

```text
Local board
Remote board
 ↓
preserve both when uncertain
 ↓
board-specific resolution later
```

---

## Phase 10 — Legacy Persistence Removal

Only after the new architecture passes the complete test matrix should old persistence paths be removed or deprecated.

---

# 37. Synchronization Test Strategy

A synchronization system this important requires more than ordinary component tests.

Create a deterministic sync simulator:

```text
FakeNetwork
FakeServer
LocalDatabase
SyncEngine
```

The simulator should inject:

```text
online
offline
timeout
disconnect
reconnect
duplicate response
lost response
server conflict
remote delete
local delete
crash
multi-tab
auth change
quota error
```

---

# 38. Required Sync Test Matrix

## Basic

- edit online
- edit offline
- reconnect
- reload while offline
- browser restart
- tab close while offline
- multiple edits before reconnect

## Outbox

- create offline
- create → update
- create → update → delete
- update → delete
- repeated updates
- retry after failure
- duplicate mutation
- lost response
- crashed in-flight mutation

## Conflicts

- local edit vs remote edit
- local delete vs remote edit
- local edit vs remote delete
- rename vs rename
- folder move vs remote folder deletion
- same document edited on two devices

## Network

- offline during push
- network disappears during request
- server 500
- server 429
- timeout
- reconnect
- Realtime disconnect
- Realtime reconnect
- missed Realtime events

## Multi-Tab

- Tab A edits, Tab B observes
- Tab A offline, Tab B online
- leader tab closes
- second tab becomes leader
- simultaneous local edits
- duplicate notifications

## Storage

- quota exceeded
- IndexedDB unavailable
- corrupt local record
- schema migration
- migration blocked
- old tab running previous DB version

## Authentication

- logout with pending outbox
- login as another user
- token refresh during sync
- revoked project access
- project deleted remotely

---

# 39. Failure Classification

The sync engine should never reduce every failure to "network error."

At minimum, distinguish:

```text
offline
network_error
timeout
server_error
rate_limited
authorization_error
validation_error
conflict
storage_error
migration_error
unknown_error
```

Different classes require different recovery strategies.

```text
network_error
    → retry

rate_limited
    → delayed retry

authorization_error
    → stop and require auth resolution

conflict
    → preserve and resolve

storage_error
    → surface immediately

validation_error
    → block mutation and show actionable error
```

---

# 40. Recommended Milestones

## M0 — Contract

> Synchronization semantics are formally defined.

## M1 — Local Database

> Artix can persist workspace data entirely offline.

## M2 — Offline Editing

> Kill the network and user edits survive.

## M3 — Durable Outbox

> Every local mutation has a deterministic path to the server.

## M4 — Reliable Synchronization

> Disconnect/reconnect/crash/retry does not lose or duplicate changes.

## M5 — Conflict Safety

> Concurrent edits are detected and never silently destroyed.

## M6 — Multi-Tab

> Multiple Artix tabs share one coherent local workspace.

## M7 — Realtime Acceleration

> Realtime makes synchronization fast without becoming a reliability dependency.

## M8 — Legacy Removal

> Old network-first/localStorage persistence paths are removed.

---

# 41. Final Target Architecture

```text
                    ┌─────────────────┐
                    │     SUPABASE    │
                    │                 │
                    │ Server authority│
                    └────────┬────────┘
                             │
                       synchronization
                             │
                             ▼
                    ┌─────────────────┐
                    │   INDEXED DB    │
                    │                 │
                    │ Local authority │
                    └────────┬────────┘
                             │
                        immediate
                       reads / writes
                             │
                             ▼
                    ┌─────────────────┐
                    │       UI        │
                    └─────────────────┘
```

Expanded:

```text
                    Artix UI
                       │
                       ▼
                    Hooks
                       │
                       ▼
                 Repositories
                       │
              ┌────────┴────────┐
              ▼                 ▼
          IndexedDB         Sync Engine
                                │
                       ┌────────┴────────┐
                       ▼                 ▼
                    Supabase         Realtime
```

The synchronization engine becomes the boundary between the local-first application and the cloud.

---

# 42. Non-Negotiable Architectural Rule

> **The UI should never wait for Supabase to know whether a user's edit is saved.**

The local transaction is the save.

Synchronization is separate.

This separation is what allows Artix to provide a genuinely offline-first editing experience rather than simply adding a cache and an offline request queue.

---

# 43. External Research & Best-Practice References

The architecture was compared against public engineering material around local-first storage and synchronization.

## Supabase

Supabase Realtime/Postgres Changes should not be treated as a durable synchronization mechanism for disconnected clients. Missed events during disconnect/reconnect require a separate reconciliation strategy.

Reference:

- https://github.com/supabase/supabase/blob/db2242e223be1bad917577d786b053ecef5f1660/apps/www/_blog/2026-05-05-realtime-or-pipelines-how-to-choose-the-right-tool.mdx

## RxDB

RxDB provides useful architectural references for:

- offline-first data models
- replication
- conflict handling
- browser storage
- multi-tab behavior
- synchronization edge cases

Reference:

- https://github.com/pubkey/rxdb

The goal is not to copy RxDB's architecture wholesale. Artix already has a specific Supabase schema, workspace model, resource model, RLS environment, and editor architecture.

Instead, these systems should be used as references for identifying failure modes and best practices.

---

# 44. Artix-Specific Design Philosophy

The synchronization system should be designed around Artix rather than around generic CRUD synchronization.

Artix has:

```text
Projects
  ↓
Folders
  ↓
Documents / Designs
  ↓
Editors
  ↓
Tabs
  ↓
Autosave
  ↓
AI Context
  ↓
Future Agent Workflows
```

Therefore offline-first infrastructure is not merely a persistence optimization.

It becomes infrastructure for the future Artix development environment.

The long-term model is:

```text
Project
   │
   ├── Resources
   ├── Folders
   ├── Workspace state
   ├── Local drafts
   ├── AI context
   ├── Sync state
   └── Agent state
            │
            ▼
       Local Repository
            │
            ▼
         Sync Engine
            │
            ▼
          Cloud
```

This is why the synchronization layer should be treated as a first-class architectural subsystem rather than as another autosave utility.

---

# 45. Immediate Next Step

The recommended first implementation milestone is **M0 → M1**.

Do not begin by adding IndexedDB calls throughout the existing hooks.

First formalize:

1. entity identity
2. local revisions
3. server versions
4. mutation IDs
5. outbox semantics
6. mutation compaction
7. deletion/tombstone behavior
8. synchronization checkpoints
9. conflict lifecycle
10. retry semantics
11. idempotency
12. authentication boundaries
13. multi-tab coordination
14. Realtime responsibilities

Then implement the IndexedDB + repository foundation independently.

The first code milestone should be:

```text
React UI
   ↓
Repository API
   ↓
IndexedDB
```

with the existing cloud synchronization temporarily outside the new local persistence path.

The success criterion is:

> **Disable the network completely. Artix should still behave like a real application, not like a website that happens to have cached data.**
