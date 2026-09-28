# Artix Local-First Editing & Synchronization — Full Hardening / Architecture Implementation Plan

**Document status:** Proposed target architecture

**Scope:** Artix documents, system designs, workspace folders, local persistence, offline editing, synchronization, conflict handling, multi-tab coordination, and the foundations needed for future GitHub integration.

**Primary goal:** Replace the current hybrid/offline-best-effort implementation with a clean, deterministic, user-scoped local repository architecture in which local editing is authoritative, synchronization is an asynchronous subsystem, and failures are recoverable rather than user-visible hangs.

---

## 0. Executive decision

Artix should be built around one strong invariant:

> **The authenticated user's local IndexedDB repository is the immediate source of truth for workspace state. Every user mutation is committed locally first, atomically with its durable outbox mutation. Supabase synchronization happens asynchronously and never blocks the local user operation.**

The current architecture already contains useful building blocks—Dexie, local repositories, an outbox, sync metadata, a sync engine, conflict records, Realtime, and a tab leader—but these parts are currently bypassed or duplicated by the hooks.

The target is not “make offline mode work.” The target is a system whose behavior remains correct under:

- permanent offline mode
- intermittent network connectivity
- slow or hanging requests
- browser reloads and crashes
- tab duplication
- leader-tab death
- duplicate realtime events
- duplicate network submissions
- server-side concurrent edits
- remote deletes while the client is offline
- offline create/update/delete sequences
- account switching on one browser
- storage quota pressure
- schema migrations
- partial failures during local persistence
- future GitHub synchronization

---

# 1. Problems found in the current implementation

## 1.1 Folder creation is not truly local-first

`src/hooks/useWorkspaceFolders.tsx` currently attempts a Supabase insert before calling `folderRepo.create()`.

That means:

```text
Create Folder
    -> await Supabase
    -> only then persist locally
```

A slow or unavailable request can make the UI appear to be creating the folder forever. `RenameDialog` waits for `onSave`, so the spinner remains active.

### Required correction

Local creation must complete before any network operation is considered:

```text
Create Folder
    -> IndexedDB transaction
    -> outbox mutation
    -> return to UI
    -> background sync
```

---

## 1.2 System design creation persists locally but still blocks on Supabase

`src/hooks/useSystemDesigns.tsx` already creates the local design first, which is better, but it then awaits a direct Supabase insert before the mutation resolves.

Therefore the local record can exist while the UI remains waiting.

### Required correction

Remove the direct remote write from the mutation path. The mutation returns after the local transaction. The SyncEngine performs the remote push later.

---

## 1.3 Folder reads can hide valid offline-created folders

`useWorkspaceFolders` initially prepares local state, then fetches Supabase. If the remote request succeeds, the hook returns the remote list directly.

That means this state is possible:

```text
IndexedDB:      Server:
A              A
B (offline)    
```

The server response succeeds, so the UI returns `A` and effectively hides `B`, even though `B` is safely stored locally and may already have an outbox entry.

### Required correction

All workspace queries should read from local IndexedDB. Remote data should be reconciled into IndexedDB by the synchronization subsystem, never returned directly by the UI query layer.

---

## 1.4 Two competing write paths exist

A representative current flow can become:

```text
UI
├──> local repository
│      └──> outbox
│             └──> SyncEngine -> Supabase
│
└──> direct Supabase mutation
```

This defeats the purpose of having one synchronization architecture.

### Required correction

The UI/hooks must not directly mutate Supabase for syncable workspace entities.

All remote writes go through the SyncEngine.

---

## 1.5 Local entity write and outbox write are not atomic

Current repositories commonly do:

```text
transaction #1: write entity
transaction #2: enqueue outbox
```

A tab crash, browser crash, quota failure, or unexpected exception between the two can leave:

```text
local entity exists
outbox mutation does not exist
```

The data becomes permanently unsynchronized unless some later reconciliation catches it.

### Required correction

Entity mutation + outbox mutation + sync metadata update must be one Dexie transaction.

---

## 1.6 Remote hydration is implemented through normal mutation repositories

The current `skipOutbox` mechanism allows server hydration to call normal create/update methods.

This creates two semantic paths in one API:

```text
create() = user mutation
create(..., { skipOutbox: true }) = remote reconciliation
```

That is dangerous because the API can easily be misused.

### Required correction

Separate these concepts:

```text
mutateLocal()
applyRemoteSnapshot()
```

Remote reconciliation must not look like a user mutation.

---

## 1.7 `navigator.onLine` is not a reliable backend connectivity check

`navigator.onLine` can report `true` while a specific request to Supabase is unreachable, blocked, stalled, or timing out.

### Required correction

The local mutation path must not depend on `navigator.onLine` at all.

`navigator.onLine` should only be a synchronization scheduling hint.

---

## 1.8 The current `SyncEngine` can leave `in_flight` mutations stranded

The outbox tracks `in_flight`, but a crash can occur after marking the entry in-flight and before completion.

Without lease expiration/recovery, a mutation can remain in-flight indefinitely.

### Required correction

Use an explicit lease model:

```text
pending
  -> in_flight (lease owner + lease expiry)
  -> completed

or, after crash/lease expiry:

in_flight
  -> pending
```

Recovery must happen on every SyncEngine startup.

---

## 1.9 The current `SyncMetadata` model is missing the authoritative local baseline

Three-way conflict resolution needs:

```text
BASE + LOCAL + REMOTE
```

The current system has `baseServerVersion`, but it does not consistently store the exact last-server-acknowledged snapshot needed for deterministic merges.

### Required correction

Store an explicit last-synced baseline snapshot or equivalent durable shadow state for every actively synchronized entity.

---

## 1.10 Current conflict detection relies on weak heuristics

`useSystemDesigns` uses `localRevision <= 1` to decide whether a remote snapshot can overwrite local state.

That is not a synchronization rule.

The synchronization decision must depend on explicit state:

```text
synced
pending
syncing
conflict
blocked
```

and server versions.

---

## 1.11 The current conflict merge implementation is too simplistic for production correctness

`ConflictResolver.mergeDocumentText()` is a hand-written line-based algorithm. It is useful as a prototype but should not become the long-term merge engine for arbitrary text edits.

### Required correction

Use a tested three-way diff/merge implementation for documents, and treat structured artifacts such as architecture diagrams differently from plain text.

For system designs, the first production-safe behavior should prefer preservation and explicit conflict copies over unsafe automatic graph merges.

---

## 1.12 Remote deletes can be permanently missed

The server currently performs hard deletes for some entities.

A client that was offline during a remote delete may later fetch current rows and have no way to know that a previously cached row was deleted.

Realtime cannot solve this because realtime notifications are not durable.

### Required correction

Add a durable server change feed/cursor, or retain server tombstones long enough for clients to reconcile missed deletes.

The preferred long-term design is a durable change sequence.

---

## 1.13 Parent/child dependency ordering is not explicit

Workspace entities have dependencies:

```text
Project
  -> Folder
       -> Document / System Design
```

An offline document may reference an offline-created folder. The server must not receive the child mutation before the parent exists if there is an FK.

### Required correction

The outbox must be dependency-aware or use a deterministic FIFO policy with explicit dependency checks.

For the hardened implementation, use explicit mutation dependencies for parent creation and deletion relationships.

---

## 1.14 The query/cache layer is coupled to remote state

React Query is currently used as a mixture of:

- local cache
- remote cache
- synchronization mechanism

This creates invalidation/refetch races.

The local database should be the persistent state layer. React Query should only be a UI read cache over local state.

---

# 2. Target architecture

## 2.1 Core model

```text
                         ARTIX APP
                            │
             ┌──────────────┴──────────────┐
             │                             │
         UI / Hooks                  Sync Runtime
             │                             │
             ▼                             ▼
      Local Repository              Sync Coordinator
             │                             │
             ▼                     ┌───────┴───────┐
         Dexie DB                  │               │
             │                  Push Engine    Pull Engine
             │                     │               │
             │                     ▼               ▼
             └────────────── local changes / remote changes
                                   │
                                   ▼
                              Supabase/Postgres
```

The UI never directly communicates with Supabase for syncable workspace state.

---

# 3. User-scoped local repository

## 3.1 The repository boundary

Create one logical and physical local repository per authenticated user.

Recommended structure:

```text
Browser origin
└── IndexedDB
    ├── ArtixDB_<user-scope-A>
    ├── ArtixDB_<user-scope-B>
    └── ...
```

A database should be scoped to one authenticated user.

This prevents accidental cross-account mixing and makes repository lifecycle explicit.

The existing records may still retain `userId` as defense-in-depth and for migrations, but the database itself is user-scoped.

### Important distinction

This is a **user-local repository**, not a Git repository.

Do not introduce a full local commit DAG, branches, checkout semantics, or Git object database merely to solve offline synchronization.

The initial abstraction is:

```text
UserLocalRepository
├── documents
├── systemDesigns
├── folders
├── projects
├── outbox
├── syncMetadata
├── conflicts
└── repository metadata
```

Git-like versioning can be layered later when GitHub integration becomes a real requirement.

---

## 3.2 Database naming

Avoid putting raw personally meaningful identifiers into the database name when not necessary.

Recommended:

```text
ArtixDB_v2_<stableUserScopeHash>
```

The hash is deterministic for the authenticated user ID.

This is not a security boundary; IndexedDB is still local browser storage and should not be treated as encrypted secret storage.

---

## 3.3 Repository lifecycle

Introduce a single lifecycle service:

```ts
openUserLocalRepository(userId)
closeUserLocalRepository(userId)
getActiveUserLocalRepository()
```

Opening a repository must:

1. Open/create the user-scoped Dexie database.
2. Verify repository metadata matches the current user.
3. Run Dexie schema migrations.
4. Recover stale in-flight outbox leases.
5. Validate repository health.
6. Return immediately with local state available.
7. Start synchronization asynchronously.

Logging out must:

1. Stop realtime.
2. Stop the user's SyncEngine.
3. Remove listeners.
4. Close the user's DB connection.
5. Clear the active repository reference.

Do not share one global repository instance across users.

---

# 4. Repository schema

The local schema should be redesigned around the synchronization protocol rather than around UI queries.

Recommended stores:

```text
projects
folders
Documents
system_designs
outbox
sync_metadata
conflicts
repository_meta
```

A separate change/event log inside IndexedDB is optional and should only be added if debugging/history requires it.

---

## 4.1 Repository metadata

Example:

```ts
interface RepositoryMeta {
  key: 'repository';
  repositoryVersion: number;
  userId: string;
  createdAt: number;
  updatedAt: number;
  serverCursor: string | null;
  lastFullSyncAt: number | null;
  health: 'healthy' | 'degraded' | 'needs_resync';
}
```

The `serverCursor` is the position in the durable server change feed.

---

## 4.2 Local entity model

Keep explicit local state:

```ts
interface LocalSyncFields {
  localRevision: number;
  isDeleted: boolean;
  deletedAt: string | null;
}
```

Synchronization metadata should be separate:

```ts
interface SyncMetadata {
  id: string;
  entityType: EntityType;
  entityId: string;
  userId: string;

  syncState: 'synced' | 'pending' | 'syncing' | 'conflict' | 'blocked';

  localRevision: number;
  serverVersion: string | null;
  serverUpdatedAt: string | null;

  baseSnapshot: unknown | null;
  lastSyncedAt: number | null;

  lastError: {
    code: string;
    message: string;
    at: number;
  } | null;
}
```

`serverVersion` is the authoritative conflict token. `updated_at` is not the conflict token; it is for display and sorting.

---

# 5. Mutation model

## 5.1 One mutation abstraction

Replace loosely typed `payload: unknown` handling with a discriminated mutation union.

Conceptually:

```ts
type OutboxMutation =
  | CreateDocumentMutation
  | UpdateDocumentMutation
  | DeleteDocumentMutation
  | CreateSystemDesignMutation
  | UpdateSystemDesignMutation
  | DeleteSystemDesignMutation
  | CreateFolderMutation
  | UpdateFolderMutation
  | DeleteFolderMutation;
```

Every mutation contains:

```text
mutationId
userId
projectId
entityType
entityId
operation
baseServerVersion
localRevision
payload
dependencies
createdAt
attemptCount
state
lease
```

---

## 5.2 Mutation ID is an idempotency key

Every outbox entry already has an ID. Promote this to a formal protocol concept:

```text
mutationId = durable idempotency key
```

The server should record processed mutation IDs for syncable operations, at least for operations where retry ambiguity matters.

This handles the classic failure:

```text
Client -> server
server applies mutation
network response is lost
client assumes failure
client retries
```

The second attempt should be recognized as the same mutation.

---

# 6. The atomic local write rule

This is one of the most important implementation changes.

A user mutation must atomically update:

```text
entity row
+ outbox row
+ sync metadata
```

inside one Dexie transaction.

Example:

```text
Dexie transaction
├── update documents
├── insert/update outbox
└── update sync_metadata
```

If the transaction commits, all three exist.

If it fails, none of them exist.

This eliminates the “local write succeeded but no outbox entry exists” class of bugs.

---

# 7. Separate local mutation from remote reconciliation

Do not use `skipOutbox` as the public semantic switch between user edits and server hydration.

Create separate APIs.

### User mutation

```ts
repo.documents.create(...)
repo.documents.update(...)
repo.documents.delete(...)
```

These always:

```text
persist locally
+ create/update outbox
+ mark pending
```

### Remote reconciliation

```ts
repo.documents.applyRemoteSnapshot(...)
repo.folders.applyRemoteSnapshot(...)
repo.designs.applyRemoteSnapshot(...)
```

These:

```text
persist server state locally
+ update server baseline
+ update sync metadata
```

They never create an outbound mutation.

This makes illegal states much harder to construct.

---

# 8. Local read architecture

## 8.1 React Query must become a local read cache

The following hooks should stop fetching Supabase from their query functions:

```text
useDocuments
useSystemDesigns
useWorkspaceFolders
```

Their query functions should read only from the user-local repository.

Example:

```text
React Query
    ↓
Local Repository
    ↓
Dexie
```

Not:

```text
React Query
    ├──> Dexie
    └──> Supabase
```

---

## 8.2 Remote data enters through reconciliation

The correct flow becomes:

```text
Supabase
   ↓
Pull Engine
   ↓
Remote Reconciler
   ↓
IndexedDB
   ↓
React Query invalidation / local change event
   ↓
UI
```

This guarantees that the UI always observes one source of persistent truth.

---

## 8.3 Remove the `recentlyCreatedRef` workaround

`ProjectWorkspace.tsx` currently needs `recentlyCreatedRef` to protect against asynchronous cache refetches.

Once local writes are authoritative and queries are local-only, this race should disappear.

Remove this workaround after the new architecture is proven.

If URL canonicalization still needs a guard, base it on actual local repository state rather than an ad-hoc recent-ID set.

---

# 9. Local-first UX contract

Every user-facing mutation must obey these rules:

### Create

```text
Click Create
→ local commit
→ return created entity
→ UI opens/shows it
→ background sync
```

### Update

```text
Edit
→ local commit
→ UI shows new state
→ background sync
```

### Delete

```text
Delete
→ local tombstone
→ UI removes/hides entity
→ background sync
```

### Network failure

```text
local mutation: SUCCESS
sync: PENDING
```

The user should not see “failed to save” when only the network failed.

### Local storage failure

A Dexie transaction failure is different:

```text
local mutation: FAILED
```

That must be surfaced because there is no durable local copy.

---

# 10. Outbox state machine

Use an explicit state machine.

```text
                 ┌──────────────┐
                 │    PENDING   │
                 └──────┬───────┘
                        │ claim
                        ▼
                ┌───────────────┐
                │   IN_FLIGHT   │
                │ lease active  │
                └──────┬────────┘
                       / \
                      /   \
                 success  failure
                    /       \
                   ▼         ▼
              completed     pending
                              │
                              │ permanent failure
                              ▼
                           blocked
```

`failed` should not be a vague permanent state separate from retry behavior.

A retryable failure is simply a pending mutation with retry metadata.

---

## 10.1 Lease fields

Add:

```ts
leaseOwner: string | null;
leaseExpiresAt: number | null;
```

A tab claims an entry by giving itself a short lease.

If the browser crashes:

```text
lease expires
→ entry becomes eligible for retry
```

This makes synchronization crash-safe.

---

## 10.2 Retry policy

Use exponential backoff with jitter:

```text
1s
2s
4s
8s
16s
30s
60s
...
```

Add random jitter to avoid synchronized retries across tabs/devices.

Do not retry permanent validation/authentication errors indefinitely.

---

# 11. Outbox compaction

The current compaction idea is correct and should be retained, but formalized.

Examples:

```text
create + update   -> create with merged final state
create + delete   -> remove both from outbox
update + update   -> update with final state
update + delete   -> delete
```

The critical rule is:

> **Compaction must preserve the original server baseline.**

For example:

```text
server version = 12

local update A
local update B
local update C
```

The final compacted mutation must still mean:

```text
baseServerVersion = 12
final desired state = C
```

It must not silently advance the base version to a local revision.

---

# 12. Parent/child mutation dependencies

Outbox entries should optionally contain:

```ts
dependsOn: string[];
```

Examples:

```text
Create Folder F
Create Document D(folder = F)

D dependsOn F
```

The SyncEngine cannot push D until F has been acknowledged by the server.

Likewise:

```text
Delete Folder F
```

must obey an explicit policy for child documents/designs.

Artix should not rely on accidental database FK side effects for user-facing semantics.

---

# 13. Define folder deletion semantics explicitly

The current UI claims that deleting a folder moves contained resources to Root, but the local repository only soft-deletes the folder.

This must become a real domain rule.

Recommended behavior:

```text
Delete Folder
├── move child documents to root
├── move child system designs to root
├── tombstone folder
└── enqueue the complete mutation set atomically
```

Or define an explicit server-side “delete folder and reparent children” operation.

The choice should be consistent offline and online.

Do not rely on a toast message describing behavior the data layer does not actually implement.

---

# 14. Server concurrency model

## 14.1 Stop using timestamps as the primary conflict token

`updated_at` is not sufficient for safe optimistic concurrency.

Add a monotonic server version to each syncable row:

```text
version bigint NOT NULL
```

Conceptually:

```text
Create: version = 1
Update: version = version + 1
Delete: version = version + 1 (represented in change feed/tombstone)
```

The client stores:

```text
baseServerVersion
```

and updates using compare-and-swap semantics.

---

## 14.2 Compare-and-swap update

Conceptually:

```sql
UPDATE documents
SET
  content = :content,
  version = version + 1,
  updated_at = now()
WHERE id = :id
  AND user_id = authenticated_user
  AND version = :base_version;
```

If zero rows are updated:

```text
CONFLICT
```

If one row is updated:

```text
SUCCESS
```

The same semantics should exist for folders and system designs.

---

# 15. Durable server change feed

## 15.1 Why Realtime is not enough

Realtime is a notification channel, not durable synchronization state.

A browser can be offline for 12 hours and miss hundreds of realtime events.

Therefore the server needs a durable change cursor.

---

## 15.2 Recommended `sync_changes` table

Conceptual schema:

```text
sync_changes
------------
sequence bigint identity primary key
user_id uuid not null
entity_type text not null
entity_id uuid not null
operation text not null
entity_version bigint not null
changed_at timestamptz not null
```

For create/update operations, the pull path can return the current entity snapshot.

For delete operations, the change event itself carries enough identity/version information to tombstone the local row.

The cursor is:

```text
serverCursor
```

stored in `repository_meta`.

---

## 15.3 Pull protocol

Conceptually:

```text
Client cursor = 420

Request:
  changes after 420

Server:
  421 folder update
  422 design delete
  423 document update

Client:
  apply 421
  apply 422
  apply 423
  persist cursor = 423
```

Cursor advancement must be atomic with local application of the batch.

If the browser crashes after 422 but before the cursor commits:

```text
next pull starts at 420
```

The same changes can be replayed safely.

This is intentional.

Idempotent remote application is more important than trying to guarantee exactly-once delivery.

---

# 16. Realtime role after the redesign

Realtime becomes an optimization:

```text
Realtime event received
       ↓
"new remote changes exist"
       ↓
Pull Engine wakes up
       ↓
pull changes after cursor
```

If realtime fails completely:

```text
periodic sync / focus / reconnect
```

still catches up.

Therefore realtime can never be a correctness dependency.

---

# 17. Pull reconciliation algorithm

For every remote change:

### Case A — local entity is clean

```text
local syncState = synced
```

Apply the remote snapshot and advance the baseline.

### Case B — local entity has no local mutation but remote event is stale

If:

```text
remote.version <= local.serverVersion
```

ignore the event.

### Case C — local entity is pending and remote version advanced

This is a concurrent edit.

Run conflict processing:

```text
BASE = last acknowledged snapshot
LOCAL = current local state
REMOTE = current remote state
```

Then apply the entity-specific policy.

### Case D — local entity is deleted locally and remote update arrives

Treat this as a conflict, not an ordinary update.

### Case E — remote delete and local pending edit

Treat this as a conflict requiring preservation of local work.

Never silently throw away local work.

---

# 18. Baseline snapshots

For deterministic conflicts, each syncable entity needs its last server-acknowledged baseline.

Possible storage options:

```text
sync_metadata.baseSnapshot
```

or a dedicated `synced_snapshots` table.

For the current scale, keeping the baseline in `sync_metadata` is acceptable.

For very large documents later, a dedicated snapshot/content store may be preferable.

The important property is:

> The baseline is not reconstructed from guesses about localRevision.

---

# 19. Document conflict strategy

Documents are the one entity where automatic merging is valuable.

Recommended policy:

```text
1. identical local/remote -> no conflict
2. only local changed -> local wins
3. only remote changed -> remote wins
4. both changed -> three-way merge
5. merge conflicts remain -> explicit conflict state
```

Use a tested diff3/three-way merge implementation rather than extending the current hand-written algorithm indefinitely.

Do not automatically mark the document as synced if conflict markers were generated unless the user explicitly resolves the conflict.

---

# 20. System design conflict strategy

System designs are structured graphs rather than plain text.

Do not initially attempt an aggressive automatic graph merge.

Production-safe first strategy:

```text
Concurrent update detected
        ↓
Preserve local version
        ↓
Fetch remote version
        ↓
Create conflict record / conflict copy
        ↓
Keep both payloads
        ↓
User chooses resolution
```

Later, a structural three-way merge can be introduced based on node IDs, edge IDs, and property-level changes.

The key is preserving user data, not maximizing automatic merge rate.

---

# 21. Folder conflict strategy

Folder conflicts are usually simpler but have domain constraints:

```text
same project
same normalized name
```

Define one canonical normalization function and use it everywhere:

```text
Unicode normalization
→ trim
→ canonical case-folding
→ validation
```

The client and server must enforce the same business rule.

When a remote concurrent create violates a uniqueness constraint, never delete or discard the local folder. Move the outbox entry to a conflict/blocked state and present a deterministic resolution path.

---

# 22. Multi-tab synchronization

The current `TabCoordinator` direction is good and should be retained.

Target model:

```text
Tab A = leader
Tab B = standby
Tab C = standby

Only leader talks to Supabase for push/pull.
```

Standby tabs:

- read/write the same local DB
- broadcast local changes
- request sync from leader
- react to local DB changes

---

## 22.1 Leader failure

If the leader tab closes:

```text
Web Lock released
        ↓
standby tab acquires lock
        ↓
starts SyncEngine
        ↓
reclaims stale leases
        ↓
continues pending mutations
```

This should require no user interaction.

---

## 22.2 BroadcastChannel is notification only

BroadcastChannel events should never be the source of truth.

If a tab misses a broadcast:

```text
it can simply re-read IndexedDB
```

This is another reason local DB state must be authoritative.

---

# 23. Per-user Sync Runtime

Replace the current global `getSyncEngine()` singleton with a user-bound runtime.

Recommended concept:

```text
UserSyncRuntime
├── UserLocalRepository
├── SyncEngine
├── RealtimeSyncManager
├── TabCoordinator
└── lifecycle
```

One runtime per authenticated user per browser tab.

The runtime owns the database dependency explicitly.

This removes hidden default-DB usage such as:

```ts
new OutboxRepository()
new SystemDesignRepository()
```

where the underlying DB is implicitly selected.

Instead:

```ts
const repo = getActiveUserRepository();
```

or dependency-inject the repository into hooks.

---

# 24. Dependency injection and type safety

The current sync implementation contains several `any` usages.

Hardening phase should replace them with:

```text
Supabase generated database types
+ typed mutation unions
+ typed sync responses
+ runtime payload schemas
```

Suggested runtime validation library: Zod or an equivalent schema system already accepted by the project.

Every remote response and outbox payload crossing a trust boundary should be validated.

This is especially important for future GitHub and AI-generated structured data.

---

# 25. Sync error taxonomy

Do not treat all errors as “network errors.”

Use explicit categories:

```text
NETWORK_UNAVAILABLE
REQUEST_TIMEOUT
AUTH_EXPIRED
FORBIDDEN
NOT_FOUND
VALIDATION_FAILED
DUPLICATE_NAME
CONFLICT
SERVER_ERROR
STORAGE_QUOTA
SCHEMA_ERROR
UNKNOWN
```

Recommended behavior:

| Error | Action |
|---|---|
| Network unavailable | Retry later |
| Timeout | Retry with backoff |
| Auth expired | Pause sync; require re-auth |
| Forbidden | Block mutation; preserve local state |
| Validation | Block mutation; surface actionable error |
| Conflict | Enter conflict workflow |
| Server 5xx | Retry |
| Storage quota | Stop local mutation and warn user |
| Schema mismatch | Mark repo degraded; migrate/resync |

---

# 26. Request timeouts

Every network request used by synchronization must have a bounded timeout.

Never allow:

```text
await SupabaseRequestForever
```

A timeout converts a hanging connection into an ordinary retryable sync failure.

This also makes tests deterministic.

The local mutation API must not await such requests at all.

---

# 27. Sync scheduling

Sync should run when:

```text
local mutation occurs
browser reconnects
window becomes active
periodic interval fires
Realtime announces a change
user manually requests sync
leader tab becomes active
```

Use a coalesced scheduler so multiple signals result in one sync cycle.

Example:

```text
50 changes in 100ms
       ↓
1 scheduled sync cycle
```

Do not run a complete network sync per keystroke.

---

# 28. Document editing/autosave

Monaco should save locally using the existing debounce strategy.

The correct semantics are:

```text
typing
 ↓
local debounce
 ↓
IndexedDB mutation
 ↓
outbox compaction
 ↓
background network sync when appropriate
```

The editor must never depend on network latency.

For frequent document content updates, outbox coalescing is essential.

---

# 29. Initial startup behavior

The application must not block workspace rendering on a remote fetch.

Recommended sequence:

```text
Authenticate
   ↓
Open user local repository
   ↓
Render local workspace immediately
   ↓
Start Sync Runtime
   ↓
Pull remote changes
   ↓
Reconcile
   ↓
UI updates from local DB
```

The UI can show a subtle sync indicator rather than a full-screen loading state.

---

# 30. Offline startup

When opening Artix while completely offline:

```text
Auth session available
   ↓
Open local repository
   ↓
Show previous workspace state
   ↓
Mark sync = offline
```

No Supabase request should be required for the local workspace to appear.

---

# 31. Account switching

Scenario:

```text
User A logs out
User B logs in
```

The app must never show A's local documents while B's session is active.

Required sequence:

```text
stop A sync runtime
close A DB
open B DB
start B runtime
```

The user-scoped DB is an additional defense against accidental mixing.

---

# 32. Security model

The local repository is not a security boundary.

RLS remains authoritative on the server.

The sync layer must never trust a client-provided `userId` merely because it is present in a payload.

Preferred server model:

```text
authenticated user from JWT
        ↓
server derives user ownership
```

rather than:

```text
client sends arbitrary user_id
```

All sync RPCs/change feeds must enforce ownership.

---

# 33. Storage quota and degraded mode

IndexedDB can fail because of browser storage limits.

The repository must distinguish:

```text
network failure
```
from:

```text
local storage failure
```

Recommended repository behavior:

```text
QuotaExceededError
   ↓
mark repository = degraded
   ↓
stop claiming local success
   ↓
show user storage problem
```

Never acknowledge an edit as saved when it was not durably written.

Use `navigator.storage.estimate()` for diagnostics and optionally request persistent storage where appropriate.

---

# 34. Local cleanup and retention

A long-lived user repository needs cleanup policies.

Potential cleanup targets:

```text
old blocked mutations
old conflict records after resolution
stale metadata for permanently deleted entities
obsolete sync diagnostics
```

Do not aggressively delete baseline snapshots or tombstones until the synchronization protocol guarantees they are no longer needed.

---

# 35. Server-side schema additions

At minimum, the server should gain:

```text
version
updated_at
(optional deleted_at)
```

for syncable entities.

Long-term target:

```text
sync_changes
```

with an increasing cursor.

Add RLS policies ensuring a user can only read their own change feed.

Add indexes around:

```text
(user_id, sequence)
(user_id, entity_id)
```

as appropriate.

---

# 36. Server sync APIs

The cleanest architecture is to expose narrow server operations with predictable semantics.

Possible APIs:

```text
push mutation
pull changes after cursor
acknowledge/resolve conflict
```

They can be implemented with Supabase table operations initially and moved to SQL RPCs where atomicity is easier to guarantee.

The public client-side API should hide those details behind `SyncEngine`.

---

# 37. Remote mutation semantics

For create:

```text
mutationId + entityId
→ idempotent create
→ version = 1
```

For update:

```text
entityId + baseVersion
→ compare-and-swap
→ version + 1
```

For delete:

```text
entityId + baseVersion
→ compare-and-swap delete/tombstone
→ version + 1
```

A stale base version is a conflict, not a generic server error.

---

# 38. Full resynchronization

The repository needs a recovery mode for:

```text
cursor too old
corrupt local DB
schema migration problem
manual recovery
server change retention exceeded
```

Flow:

```text
Mark repo needs_resync
       ↓
Download authoritative user workspace snapshot
       ↓
Reconcile against pending local mutations
       ↓
Rebuild baseline/cursor
       ↓
Resume sync
```

A full resync must preserve unsynced local changes rather than blindly replacing them.

---

# 39. Conflict records as first-class state

A conflict should contain:

```text
conflictId
entityType
entityId
userId
baseSnapshot
localSnapshot
remoteSnapshot
baseVersion
remoteVersion
createdAt
status
resolution
```

Possible resolution states:

```text
unresolved
local_wins
remote_wins
merged
created_conflict_copy
```

The user should never lose access to the conflicting local state while a conflict is unresolved.

---

# 40. UI sync states

The UI should communicate meaningful state without pretending network state equals save state.

Example:

```text
Saved locally
Syncing
Synced
Offline — changes queued
Conflict needs attention
Sync blocked
Storage problem
```

The critical UX distinction is:

```text
Saved locally != synced remotely
```

This should be visible in the product language.

---

# 41. Recommended code/module structure

A target layout could become:

```text
src/lib/local/
  db.ts
  types.ts
  schemas.ts
  repository.ts
  repositoryFactory.ts
  errors.ts

src/lib/local/entities/
  documents.ts
  systemDesigns.ts
  folders.ts
  projects.ts

src/lib/sync/
  syncEngine.ts
  syncRuntime.ts
  pushEngine.ts
  pullEngine.ts
  remoteReconciler.ts
  conflictResolver.ts
  outbox.ts
  syncScheduler.ts
  tabCoordinator.ts
  realtimeSync.ts

src/lib/sync/protocol/
  mutations.ts
  responses.ts
  errors.ts

src/hooks/
  useDocuments.tsx
  useSystemDesigns.tsx
  useWorkspaceFolders.tsx
  useSyncStatus.tsx
```

The exact names are not mandatory. The separation of responsibilities is.

---

# 42. File-level implementation map

## `src/lib/local/db.ts`

Replace the global/default DB pattern with a user-scoped DB factory.

Responsibilities:

- create/open user DB
- schema versions
- close DB
- delete DB when explicitly requested
- storage health helpers

It should not decide synchronization behavior.

---

## `src/lib/local/types.ts`

Add:

- typed mutation unions
- lease fields
- explicit sync metadata
- base snapshot representation
- repository metadata
- typed sync errors

Remove ambiguous `unknown`/`any` where practical.

---

## `src/lib/repositories/documentRepository.ts`

Refactor around atomic user mutations.

Expose:

```text
create
update
delete
applyRemoteSnapshot
get/list
```

User mutations must transact with outbox and metadata.

---

## `src/lib/repositories/systemDesignRepository.ts`

Same model as documents.

Remove the direct-Supabase dependency from this layer.

---

## `src/lib/repositories/folderRepository.ts`

Same model, plus:

- canonical name normalization
- explicit child-resource deletion/reparenting semantics
- server/local uniqueness parity

---

## `src/lib/repositories/outboxRepository.ts`

Turn the outbox into a durable queue/state machine.

Add:

- claim/lease
- release/reclaim
- retry metadata
- dependency checks
- compaction preserving baseline version
- per-user repository isolation

---

## `src/lib/repositories/syncMetadataRepository.ts`

Store:

- current server version
- last server snapshot
- local revision
- sync state
- last error
- last synced timestamp

Avoid using `localRevision` as a proxy for network synchronization correctness.

---

## `src/lib/sync/syncEngine.ts`

Rebuild around two explicit responsibilities:

```text
Push Engine
Pull Engine
```

The top-level engine should coordinate, not contain a giant entity-specific branch if that can be avoided.

Entity-specific remote adapters can own the table/RPC details.

---

## `src/lib/sync/realtimeSync.ts`

Change semantics to:

```text
Realtime -> wake sync
```

not:

```text
Realtime -> synchronization correctness
```

---

## `src/hooks/useDocuments.tsx`

Remove direct Supabase create/update/delete from UI mutations.

Queries read local only.

---

## `src/hooks/useSystemDesigns.tsx`

Same correction.

This file currently contains the direct insert/update/delete duplication that should be removed.

---

## `src/hooks/useWorkspaceFolders.tsx`

This is the highest-priority hook to fix.

Change create, rename, delete, and query behavior to local-only mutations/reads.

---

## `src/pages/ProjectWorkspace.tsx`

After local-first conversion:

- remove `recentlyCreatedRef` workaround
- keep URL state derived from local resources
- open newly created resources immediately
- let sync status be independent of modal state

---

## `src/components/RenameDialog.tsx`

After the local-first architecture is established, the dialog should only wait for the local transaction.

Its spinner should mean:

```text
local persistence in progress
```

not:

```text
network request in progress
```

---

# 43. Migration from the current global `ArtixDB`

The migration must be explicit.

## Phase 1 — introduce v2 DB

Keep legacy DB readable.

On authenticated startup:

```text
open legacy DB
open user-scoped DB
```

Copy only records whose `userId` matches the current user.

Copy:

```text
entities
outbox
sync metadata
conflicts
repository metadata
```

Verify counts/checksums where practical.

---

## Phase 2 — mark migration complete

Store:

```text
migrationVersion
migrationCompletedAt
```

in the new repository.

---

## Phase 3 — stop writing the legacy DB

All new code uses the user-scoped repository.

---

## Phase 4 — legacy cleanup

After the new architecture has been validated in production, delete the old global DB only when safe.

Do not immediately destroy it during the first deployment because it may contain recovery data.

---

# 44. Testing strategy

The sync system needs a much stronger test matrix than a normal CRUD feature.

## Unit tests

Test:

- local repository mutations
- transaction rollback
- outbox compaction
- lease expiry
- retry scheduling
- dependency ordering
- version handling
- conflict detection
- payload validation
- normalization rules

---

## Integration tests with fake IndexedDB

At minimum:

### Test: offline folder create

```text
Supabase never resolves
createFolder()
=> resolves locally
=> IndexedDB contains folder
=> outbox contains mutation
```

### Test: offline system design create

Same expectation.

### Test: offline reload

```text
create offline
reload
read repository
=> entity still exists
=> mutation still pending
```

### Test: local entity + outbox atomicity

Force a transaction failure.

Expected:

```text
entity absent
outbox absent
metadata absent
```

### Test: crash after in-flight claim

Simulate expired lease.

Expected:

```text
in_flight -> pending
```

### Test: local pending + remote query

Remote state must not erase local pending state.

### Test: remote delete while offline

Miss the realtime event, then reconnect.

Expected:

```text
pull cursor
→ receive delete
→ local tombstone
```

### Test: remote concurrent edit

Expected conflict state with both local and remote preserved.

### Test: duplicate server acknowledgement

Retry the same mutation.

Expected idempotent result.

---

# 45. Browser/E2E test matrix

Playwright should explicitly test browser-level offline behavior.

Important scenarios:

```text
a. Go offline
b. Create folder
c. Create design
 d. Edit document
 e. Reload page offline
 f. Verify everything exists
 g. Go online
 h. Verify eventual sync
```

Also test:

```text
open two tabs
kill leader
make edits
bring network back
```

And:

```text
make local mutation
switch account
verify isolation
```

The current conditional E2E patterns should be replaced with strict assertions for features that are expected to exist.

CI should actually execute the relevant Playwright suite rather than relying only on lint/typecheck/unit tests.

---

# 46. Network simulation tests

Use a controllable test transport so the suite can simulate:

```text
instant success
slow response
never-resolving response
timeout
connection reset
HTTP 401
HTTP 403
HTTP 409/conflict
HTTP 422 validation
HTTP 500
```

This is especially important because the current bugs came from timing assumptions rather than just logical data errors.

---

# 47. Observability / debugging tools

Add a development-only sync inspector.

It should show:

```text
Current user
Repository DB
Online/offline state
Leader/standby state
Pending mutations
In-flight mutations
Blocked mutations
Oldest pending mutation
Current server cursor
Last successful sync
Last error
Conflict count
```

For each outbox entry:

```text
mutationId
entity
operation
localRevision
baseVersion
attempts
state
lease
lastError
```

This will dramatically reduce debugging time.

---

# 48. Logging policy

Use structured logs during development:

```text
[sync] mutation_claimed
[sync] mutation_sent
[sync] mutation_acknowledged
[sync] mutation_retry
[sync] conflict_detected
[sync] cursor_advanced
```

Never log sensitive document contents or API keys.

Production logging should be sampled and redacted.

---

# 49. Performance targets

The architecture should be evaluated by user-perceived latency, not network latency.

Target:

```text
Create folder
→ local success immediately
```

```text
Create design
→ local success immediately
```

```text
Typing
→ local persistence remains comfortably below user-perceived latency
```

Remote synchronization may take seconds without blocking editing.

---

# 50. Future GitHub integration compatibility

This architecture should intentionally prepare Artix for a future model like:

```text
                    Artix User Repository
                             │
                ┌────────────┼────────────┐
                │            │            │
             IndexedDB    Supabase     GitHub
                │            │            │
             local       cloud sync    code sync
```

The local repository should remain the user's working context.

Supabase stores collaborative/cloud state.

GitHub eventually stores source-code/version-control state.

Do not couple the first implementation to Git concepts prematurely.

A future GitHub adapter can subscribe to a clean domain mutation/event API rather than reaching into React state or IndexedDB tables directly.

---

# 51. Architecture rules to enforce in code review

These should become explicit project rules.

### Rule 1

UI components/hooks must not mutate Supabase directly for local-first entities.

### Rule 2

Local mutation must not await network synchronization.

### Rule 3

Entity mutation + outbox + sync metadata must be atomic.

### Rule 4

Queries for workspace state read local state only.

### Rule 5

Realtime is an optimization, never a correctness dependency.

### Rule 6

`updated_at` is informational; version/CAS determines concurrency correctness.

### Rule 7

All retryable mutations have durable IDs.

### Rule 8

Every in-flight mutation is recoverable after process death.

### Rule 9

Remote data must never silently overwrite unsynced local data.

### Rule 10

Permanent server failures never delete local work.

### Rule 11

The current user's repository is never shared with another authenticated user.

### Rule 12

`any` is not allowed in synchronization/domain code unless explicitly justified.

---

# 52. Suggested implementation phases

## Phase 0 — Freeze the sync architecture

Do not add more sync features while the current hybrid paths exist.

Create a tracking issue for every direct Supabase mutation inside the workspace hooks.

Goal:

```text
know every current network write path
```

---

## Phase 1 — Immediate bug fixes

Do first because these fixes directly resolve the current infinite-creation symptoms.

1. Make folder creation local-first.
2. Remove direct Supabase create/update/delete from system-design hook mutations.
3. Make folder query local-only.
4. Make design/document queries local-only.
5. Remove `navigator.onLine` from correctness decisions.
6. Add request timeout at SyncEngine transport level.

Definition of done:

```text
network can be unplugged permanently
and create folder/design still returns immediately.
```

---

## Phase 2 — User-scoped local repository

Implement:

```text
UserLocalRepository
```

Move all local entities into the user-scoped DB.

Add lifecycle management and logout isolation.

Definition of done:

```text
User A and User B never use the same active local database instance.
```

---

## Phase 3 — Atomic local mutation architecture

Refactor repositories so every mutation transaction includes:

```text
entity + outbox + metadata
```

Remove the public semantic use of `skipOutbox` for remote hydration.

Definition of done:

```text
there is no code path that can produce a successful local mutation without a durable sync decision.
```

---

## Phase 4 — Sync state machine hardening

Implement:

- leases
- stale in-flight recovery
- retry schedule
- error taxonomy
- dependency ordering
- mutation IDs
- structured push adapters

Definition of done:

```text
browser crash at any point in sync
→ mutations are recoverable.
```

---

## Phase 5 — Server concurrency protocol

Add:

- row versions
- compare-and-swap updates
- deterministic conflict responses
- idempotency support

Definition of done:

```text
two devices updating the same entity cannot silently overwrite each other.
```

---

## Phase 6 — Durable pull/change feed

Add:

- `sync_changes`
- server cursor
- pull endpoint
- durable delete propagation
- cursor-atomic local application

Definition of done:

```text
client can stay offline for an extended period,
miss all realtime events,
then reconnect and converge correctly.
```

---

## Phase 7 — Conflict system

Implement:

- document diff3
- design conflict copies
- folder conflict handling
- conflict UI
- conflict resolution records

Definition of done:

```text
no user-authored local data is silently discarded during concurrent changes.
```

---

## Phase 8 — Multi-tab hardening

Add:

- leader failover tests
- lease recovery
- BroadcastChannel notifications
- duplicate event tolerance
- user runtime lifecycle

Definition of done:

```text
opening/closing/killing tabs does not duplicate or lose mutations.
```

---

## Phase 9 — Test/CI hardening

Add:

- fake IndexedDB integration matrix
- network simulation
- Playwright offline scenarios
- strict E2E expectations
- CI execution of E2E tests

Definition of done:

The offline/sync correctness model is enforced continuously by CI.

---

## Phase 10 — Remove legacy architecture

Only after the new architecture passes the complete test matrix:

- remove global `ArtixDB`
- remove direct Supabase mutations from workspace hooks
- remove obsolete sync utilities
- remove `recentlyCreatedRef`
- remove compatibility paths
- update documentation

---

# 53. Migration order for current Artix files

Recommended order:

```text
1. src/lib/local/types.ts
2. src/lib/local/db.ts
3. new UserLocalRepository / repositoryFactory
4. src/lib/repositories/outboxRepository.ts
5. src/lib/repositories/syncMetadataRepository.ts
6. entity repositories
7. src/lib/sync/syncEngine.ts
8. src/lib/sync/realtimeSync.ts
9. useDocuments
10. useSystemDesigns
11. useWorkspaceFolders
12. ProjectWorkspace
13. sync UI/status
14. tests
15. SQL migrations
```

Do not refactor the UI first while the data contract is still unstable.

---

# 54. Definition of “done”

The local-first architecture is not considered complete because “it works offline once.”

It is done only when all of the following are true:

### Local correctness

- Every accepted edit exists durably in IndexedDB.
- A local mutation always has a durable sync decision.
- Reloading offline preserves the user's work.

### Sync correctness

- Pending work survives reloads and crashes.
- In-flight work is recoverable.
- Retries are bounded and classified.
- Duplicate delivery is safe.
- Remote deletes are durable through the pull protocol.
- Concurrent edits are detected by version, not timestamp guesswork.

### UI correctness

- No create/edit dialog waits for network completion.
- Local state cannot disappear just because the server query is newer or missing a pending entity.
- Sync status is distinct from save status.

### Multi-tab correctness

- Only one leader pushes/pulls.
- Leader death is recoverable.
- Other tabs converge via shared local state.

### Account isolation

- Every authenticated user has a separate active local repository.
- Switching users closes the previous repository before opening the next one.

### Architecture correctness

- Workspace hooks do not write directly to Supabase.
- Repositories do not secretly create two synchronization paths.
- `skipOutbox` is not used as a generic escape hatch.
- Sync code is strongly typed.

### Test correctness

- Offline create/update/delete tests pass.
- Hanging network tests pass.
- Crash/recovery tests pass.
- Multi-tab tests pass.
- Remote conflict tests pass.
- Remote delete recovery passes.
- E2E offline tests run in CI.

---

# 55. Recommended final mental model

The architecture should be explainable in one diagram:

```text
                          USER EDIT
                             │
                             ▼
                    UserLocalRepository
                             │
             ┌───────────────┴───────────────┐
             │                               │
             ▼                               ▼
        IndexedDB                       Outbox + Metadata
             │                               │
             │                               ▼
             │                        Sync Runtime
             │                               │
             │                    ┌──────────┴──────────┐
             │                    │                     │
             │                  PUSH                  PULL
             │                    │                     │
             │                    ▼                     ▼
             │                 Supabase             Change Feed
             │                    │                     │
             │                    └──────────┬──────────┘
             │                               │
             │                         Reconciliation
             │                               │
             └───────────────<───────────────┘
                             │
                             ▼
                            UI
```

And the single most important invariant remains:

> **The user should never have to wait for the network to know whether their local edit was saved.**

The network's job is convergence. The local repository's job is immediate durability. The conflict system's job is preserving user intent when convergence is not automatically possible.

---

# 56. Final architectural recommendation

Do not rewrite Artix into a completely different product architecture.

The existing Dexie + repository + outbox + conflict + leader-tab foundation is salvageable and is actually a good starting point.

The work should be a controlled architectural consolidation:

```text
CURRENT

UI
├── local repository
├── direct Supabase
└── sync engine

TARGET

UI
  ↓
Local Repository
  ↓
Atomic Local Mutation
  ↓
Durable Outbox
  ↓
Sync Runtime
  ├── Push
  ├── Pull
  ├── Conflict handling
  ├── Realtime wakeups
  └── Multi-tab coordination
```

The largest improvement will come from **removing ambiguity**, not from adding more synchronization features.

The target architecture should make it impossible—or at least difficult—for a developer to accidentally introduce another direct network write path six months from now.
