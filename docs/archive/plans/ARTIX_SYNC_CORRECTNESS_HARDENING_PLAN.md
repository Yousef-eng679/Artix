
# GEMINI EXECUTION DIRECTIVE

This document is the **target correctness architecture**, not a script to execute blindly.

Before implementing anything, you MUST:

1. **Read this entire document first.**
2. **Inspect the current repository implementation** relevant to the affected phase, including source code, tests, and Supabase migrations.
3. Compare the documented target state against the actual implementation and identify:

   * what already exists,
   * what is partially implemented,
   * what is missing,
   * what conflicts with the current architecture,
   * and what must be changed to preserve existing data and behavior.
4. Produce a **phase-specific implementation plan** for the current phase only. Do not generate one giant implementation plan for the entire document.
5. Implement only that phase.
6. Run the relevant tests, type checks, lint/build checks, and failure-oriented tests required by that phase.
7. Perform a **post-implementation audit** against the phase's invariants and the overall correctness goals.
8. Only after the phase passes its verification gate, inspect the updated repository and derive the plan for the next phase.

## Execution principles

* **Repository reality outranks this document.** Never assume the current code matches the plan.
* **Correctness outranks feature velocity.**
* Do not introduce parallel sync/write paths.
* Do not weaken existing invariants merely to make a phase easier to implement.
* Prefer small, reviewable changes over broad rewrites.
* Preserve backward compatibility and existing user data whenever possible.
* Treat ambiguous network outcomes, retries, crashes, multi-tab races, stale remote state, and concurrent edits as first-class failure cases.
* Do not declare a phase complete because tests pass if the underlying invariant is still violated.
* Do not update the major architecture documentation during this correctness pass. Documentation will be rebuilt after the correctness architecture is finalized.

## Required output before each phase

Before modifying code, provide:

```text
PHASE
CURRENT IMPLEMENTATION
GAPS FOUND
TARGET INVARIANTS
IMPLEMENTATION PLAN
FILES AFFECTED
MIGRATIONS AFFECTED
TEST PLAN
RISKS
VERIFICATION GATE
```

## Hard stops

Stop and report the issue instead of improvising if you discover:

* a fundamental contradiction in the target architecture,
* a migration that could cause data loss,
* an invariant that cannot be enforced with the current design,
* or an ambiguity that makes correctness unverifiable.

After resolving the issue, continue from the updated repository state.

**The goal is not merely to make synchronization work. The goal is to make its behavior deterministic, durable, recoverable, and explainable under failure.**

# Artix Local-First Synchronization — Correctness & Protocol Hardening Plan

**Document status:** Proposed correctness pass after the Phase 0–10 hardening merge  
**Scope:** Local-first persistence, outbox durability, CAS/versioning, idempotency, remote pull, conflict detection, multi-tab coordination, user lifecycle, realtime lifecycle, and correctness-focused testing  
**Primary goal:** Move Artix from a largely implemented synchronization architecture to a **protocol-level correct, failure-resilient, auditable, and extensible local-first system**.

---

# 0. Executive decision

The previous hardening pass established the major architecture:

```text
UI
 ↓
Local Repository
 ↓
IndexedDB + Outbox + Sync Metadata
 ↓
Sync Runtime
 ├── Pull
 ├── Push
 ├── Conflict Handling
 └── Multi-Tab Coordination
 ↓
Supabase
```

That architecture is directionally correct.

The remaining work is not another broad rewrite. It is a **correctness pass** that verifies every protocol boundary and removes places where the implementation can still violate the architecture.

The target invariant is now:

> **Every committed local mutation is durable, every remote mutation is idempotent, every server write is concurrency-checked, every remote change is recoverable even when Realtime is missed, and no stale remote observation can overwrite local unacknowledged work.**

The system must remain correct when:

- a request hangs forever
- a request succeeds but its response is lost
- a tab crashes after claiming work
- a second tab becomes leader
- Realtime events are duplicated or missed
- a remote edit arrives while local work is pending
- the user logs out or switches accounts while synchronization is active
- IndexedDB is upgraded or unavailable
- Supabase returns stale/partial data
- a user creates dependent entities offline
- the same mutation is retried multiple times

---

# 1. Current correctness gaps found after the Phase 0–10 implementation

## 1.1 CAS infrastructure exists, but the client baseline is not consistently wired

The server now exposes a monotonic `version`, and push adapters can apply a conditional update using `baseServerVersion`.

However, local mutation creation does not consistently capture the authoritative last-server version into the outbox entry.

This creates a dangerous state:

```text
Server version = 12
Local baseline = 12
User edits locally
Outbox.baseServerVersion = null
```

The push adapter can then fall back to:

```text
UPDATE ... WHERE id = X
```

instead of:

```text
UPDATE ... WHERE id = X AND version = 12
```

### Required correction

Every mutation that depends on an existing remote record MUST carry the exact last acknowledged server version.

Creation of a brand-new local entity has a null/absent baseline until the server acknowledges creation.

Updates and deletes MUST use the last acknowledged server version as their CAS base.

---

## 1.2 Mutation identity is not consistently propagated end-to-end

The database contains `processed_mutations`, but the client protocol does not yet consistently identify a mutation with a durable mutation ID sent to the server.

This leaves the classic distributed-systems ambiguity:

```text
Client → POST mutation
Server commits successfully
Network response is lost
Client times out
Client retries
```

Without idempotent server handling, the retry can be interpreted as a new mutation.

### Required correction

Every outbox entry must have a stable `mutationId`.

The same mutation ID must be sent to the server on every retry.

The server must make processing idempotent:

```text
first arrival:
  apply mutation
  record mutationId

retry:
  recognize mutationId
  return the same logical acknowledgement
  do not apply the mutation again
```

The acknowledgement contract must be explicit.

---

## 1.3 Direct hook-level remote reconciliation still exists

The current hooks still fetch Supabase directly during React Query reads.

That creates a second synchronization boundary:

```text
UI query
 ├── IndexedDB
 └── Supabase
```

The target architecture is:

```text
UI query
 ↓
IndexedDB only

Sync Runtime
 ↓
PullEngine
 ↓
IndexedDB
```

### Required correction

React hooks must become local read adapters only.

Remote reads must belong to the synchronization subsystem.

This eliminates competing notions of which remote snapshot is authoritative.

---

## 1.4 Folder remote reconciliation can overwrite pending local intent

The folder path has weaker protection than the pull engine.

A stale remote folder snapshot can potentially be applied to local IndexedDB while a local rename or move is still pending.

Example:

```text
Server: "Backend Services"
Local:  "Backend"
Outbox: pending rename
Remote snapshot arrives
        ↓
unsafe hydration
        ↓
local "Backend" can be overwritten
```

### Required correction

Remote application must inspect synchronization state and pending mutations for the entity.

A remote snapshot MUST NOT overwrite local unacknowledged intent.

---

## 1.5 UserSyncRuntime exists but is not yet the single application lifecycle owner

The runtime abstraction exists, but hooks still construct their own user-scoped DB/repository/coordinator objects.

This creates an architectural split:

```text
Auth
 ↓
??? runtime lifecycle

Hooks
 ├── getUserArtixDB()
 ├── new Repository()
 ├── new OutboxRepository()
 └── getTabCoordinator()
```

### Required correction

Authenticated session lifecycle must explicitly own:

```text
UserSyncRuntime
 ├── database
 ├── repositories
 ├── outbox
 ├── metadata
 ├── pull engine
 ├── sync engine
 ├── conflict repository
 ├── tab coordinator
 └── realtime subscription
```

Hooks should consume the runtime/repository context instead of independently constructing synchronization infrastructure.

---

## 1.6 Realtime lifecycle is not clearly attached to authentication lifecycle

The Realtime manager exists, but runtime startup/shutdown must guarantee:

```text
SIGNED_IN
 → start runtime
 → start Realtime

SIGNED_OUT
 → stop Realtime
 → stop runtime
 → close DB
```

There must be no orphan channel for a previous account.

---

## 1.7 User database naming is isolation-oriented, not cryptographic

The database name uses a deterministic FNV-1a hash.

That is acceptable as a naming/partitioning mechanism, but it must not be described as cryptographic security.

### Required correction

Use precise terminology:

- user-scoped partitioning
- deterministic database naming
- application/RLS authorization provides security

If a stronger opaque identifier is useful, use a collision-resistant encoding, but do not imply that the database name itself is a security boundary.

---

## 1.8 Remote delete and tombstone semantics need explicit protocol guarantees

The server change feed records deletes, but local application needs deterministic tombstone handling.

A delete must not be lost because:

```text
remote deletes row
 ↓
client was offline
 ↓
client misses Realtime
 ↓
pull sees delete
 ↓
local entity disappears
```

The local protocol must retain enough metadata to distinguish:

- never existed locally
- remotely deleted
- locally deleted but not yet acknowledged
- conflict between update and delete

---

## 1.9 A successful remote push can race a newer local edit

Example:

```text
localRevision 10 → push started
localRevision 11 → user edits again
push 10 succeeds
```

The acknowledgement must NOT blindly mark the entity as fully synchronized if revision 11 is already pending.

### Required correction

Sync acknowledgement must be conditional on the acknowledged local revision still matching the mutation being acknowledged.

If the entity has advanced locally:

```text
server ack mutation revision 10
local revision = 11
```

then the local entity remains pending for revision 11.

---

## 1.10 Outbox compaction needs explicit semantic guarantees

Compaction is useful, but generic payload merging is unsafe for all operations.

The system must explicitly distinguish:

```text
safe state coalescing
```

from:

```text
order-sensitive mutations
```

Examples requiring careful handling:

- create → update
- create → delete
- update → update
- update → delete
- delete → restore/update
- folder move → folder delete

### Required correction

Document and test the mutation algebra for every entity type.

---

# 2. Correctness principles

These rules override convenience.

## 2.1 Local commit is the user operation

A local create/update/delete is complete when the atomic IndexedDB transaction commits.

Network success is a synchronization event, not a prerequisite for user-visible success.

---

## 2.2 Every remote mutation is idempotent

Retried network requests must be safe.

Timeouts are ambiguous outcomes and must be assumed to mean:

```text
"The server may have accepted this mutation."
```

Never assume timeout means the mutation did not happen.

---

## 2.3 Every update/delete is concurrency guarded

For an existing entity:

```text
baseServerVersion = last acknowledged server version
```

The server must reject stale mutations deterministically.

---

## 2.4 Local pending intent has precedence over stale observations

A remote read can never overwrite an entity merely because the remote request happened later.

Synchronization must reason about:

```text
remote version
+
local pending state
+
local baseline
```

---

## 2.5 Realtime is acceleration, not correctness

Missing Realtime must never cause permanent divergence.

The change feed is the recovery path.

---

## 2.6 React Query is presentation state

React Query may cache the local result for rendering, but it must not decide synchronization correctness.

---

## 2.7 User runtime owns synchronization lifecycle

There must be exactly one synchronization runtime for the active authenticated user in a tab.

---

# 3. Correctness hardening phases

---

# PHASE C0 — Protocol Specification Freeze

## Objective

Formalize the synchronization protocol before changing implementation.

## Deliverables

Create:

```text
/docs/SYNC_PROTOCOL.md
/docs/SYNC_STATE_MACHINE.md
/docs/SYNC_FAILURE_MODES.md
```

Define:

- mutation identity
- server version semantics
- local revision semantics
- server cursor semantics
- outbox state transitions
- acknowledgement semantics
- conflict semantics
- tombstone semantics
- user runtime lifecycle
- retry semantics
- idempotency semantics

## Acceptance criteria

Every synchronization scenario can be described without reference to specific React components.

---

# PHASE C1 — Mutation Identity & Idempotent Server Protocol

## Objective

Make retries safe under ambiguous network outcomes.

## Changes

### Client

Extend the outbox model with a durable mutation identity:

```ts
interface OutboxEntry {
  mutationId: string;
  ...
}
```

The mutation ID must be stable for the lifetime of that logical mutation.

### Server

Use `processed_mutations` as a true idempotency ledger.

Prefer a transactional server mutation boundary where:

```text
mutationId
 ↓
check processed_mutations
 ↓
if processed:
    return prior acknowledgement
 ↓
apply CAS mutation
 ↓
record processed mutation
 ↓
return acknowledgement
```

Do not implement this as a race-prone check-then-insert sequence.

## Tests

Simulate:

```text
success + lost response
retry
retry again
concurrent same mutation from duplicate worker
```

## Acceptance criteria

The same mutation ID can be submitted multiple times with no duplicate logical effect.

---

# PHASE C2 — Correct CAS Baseline Propagation

## Objective

Ensure every update/delete carries the actual last acknowledged server version.

## Changes

When remote state is applied:

```text
syncMetadata.serverVersion = server.version
syncMetadata.baseSnapshot = exact remote snapshot
```

When a user edits an entity:

```text
outbox.baseServerVersion = syncMetadata.serverVersion
```

For a newly created unsynced entity:

```text
baseServerVersion = null
```

When creation is acknowledged:

```text
serverVersion = returned version
baseSnapshot = acknowledged server representation
```

## Critical invariant

If local revision 12 was based on server version 7, the outbox mutation for that edit MUST carry:

```text
baseServerVersion = 7
```

and never silently fall back to null.

## Tests

- edit after remote version 5
- edit after reconnect
- two clients edit from version 5
- stale client tries version 5 after server is version 6
- delete against stale version

## Acceptance criteria

No update/delete path can reach Supabase without a valid CAS baseline when one should exist.

---

# PHASE C3 — Revision-Safe Acknowledgements

## Objective

Prevent an old server acknowledgement from clearing newer local work.

Example:

```text
Local revision 10
push 10

Local revision 11
push 10 still in flight

Server acknowledges 10
```

The client must NOT conclude that revision 11 is synced.

## Required acknowledgement rule

An acknowledgement may mark an entity synced only if:

```text
ack.localRevision === current.localRevision
```

Otherwise:

```text
acknowledge server version
keep entity pending
create/retain next mutation
```

## Tests

Force controlled interleavings between:

- local edit
- push
- acknowledgement
- second local edit

---

# PHASE C4 — Remove Hook-Level Remote Reads

## Objective

Establish a single synchronization ownership model.

## Target

Hooks become:

```text
React Query → IndexedDB repository
```

No direct Supabase hydration in:

```text
useDocuments
useSystemDesigns
useWorkspaceFolders
```

## Remote reads

Move all remote reconciliation to:

```text
PullEngine
```

or a dedicated synchronization data-access layer.

## Acceptance criteria

A search/static audit finds no direct Supabase workspace reads in UI hooks for synchronized entities.

---

# PHASE C5 — Pending-State-Safe Remote Application

## Objective

Ensure remote observations cannot overwrite local pending intent.

## Remote application algorithm

For every incoming remote snapshot:

```text
read local entity
read sync metadata
read outbox state

if local pending mutation exists:
    compare remote version with baseline
    preserve local intent
    create conflict if required
else:
    apply remote snapshot
```

The same rule must apply to:

- document
- system design
- folder
- rename
- move
- delete

## Acceptance criteria

A stale remote snapshot cannot overwrite a pending local mutation.

---

# PHASE C6 — UserSyncRuntime as the Single Lifecycle Owner

## Objective

Make synchronization lifecycle explicit and deterministic.

## Architecture

```text
AuthProvider
    ↓
UserSyncRuntimeProvider / lifecycle hook
    ↓
UserSyncRuntime
    ├── DB
    ├── repositories
    ├── outbox
    ├── PullEngine
    ├── SyncEngine
    ├── ConflictRepository
    ├── TabCoordinator
    └── Realtime
```

## Rules

On sign-in:

```text
open DB
migrate if necessary
recover leases
initialize runtime
start realtime
start background synchronization
```

On sign-out:

```text
stop realtime
stop sync
release leader coordination
close DB
release runtime
```

On account switch:

```text
user A runtime fully stops
↓
user B runtime starts
```

## Acceptance criteria

Hooks no longer construct independent synchronization runtimes.

---

# PHASE C7 — Realtime Lifecycle & Recovery

## Objective

Attach Realtime to the runtime lifecycle and treat it as a wake-up mechanism.

## Rules

Realtime event:

```text
remote change signal
 ↓
leader schedules PullEngine
```

It must NOT:

- directly mutate UI state
- directly overwrite entities
- be required for correctness

## Tests

- Realtime unavailable
- Realtime disconnects
- duplicate event
- missed event
- reconnect after long offline period

## Acceptance criteria

Disabling Realtime entirely does not prevent eventual synchronization through cursor-based pull.

---

# PHASE C8 — Tombstones & Remote Delete Correctness

## Objective

Make deletes first-class synchronization state.

## Rules

Maintain explicit tombstone semantics for local reconciliation.

Distinguish:

```text
LOCAL_PENDING_DELETE
REMOTE_CONFIRMED_DELETE
REMOTE_DELETE_CONFLICT
PURGED_TOMBSTONE
```

Do not immediately hard-delete local metadata that is needed to recognize an old remote change.

Define safe garbage collection rules only after the server version/cursor history makes purging safe.

## Tests

- remote delete while offline
- local delete while offline
- local update vs remote delete
- local delete vs remote update
- repeated delete
- reconnect after long offline period

---

# PHASE C9 — Outbox Mutation Algebra & Dependency Correctness

## Objective

Make compaction formally correct.

Define a transition table for every entity:

| Existing | Incoming | Result |
|---|---|---|
| create | update | create with latest desired state |
| create | delete | cancel |
| update | update | coalesce safely |
| update | delete | delete |
| delete | restore/update | explicit restore/update semantics |
| delete | delete | no-op |

Add dependency rules for:

```text
folder → document
folder → system design
```

and verify topological ordering cannot produce references to nonexistent server entities.

## Acceptance criteria

The mutation algebra is documented and covered by tests.

---

# PHASE C10 — Concurrent Worker / Leader Correctness

## Objective

Ensure only one tab owns remote execution while all tabs retain local write independence.

## Rules

Any tab can:

```text
write entity locally
enqueue mutation
```

Only the current leader can push to Supabase.

Leader change must not lose work.

## Hard scenarios

```text
leader crashes after claiming mutation
standby becomes leader
mutation still recoverable
```

```text
leader crashes after server commit but before acknowledgement
new leader retries same mutationId
server returns idempotent acknowledgement
```

## Acceptance criteria

Exactly-once logical effect, even though physical requests may occur multiple times.

---

# PHASE C11 — Storage, Migration & Runtime Safety

## Objective

Harden browser persistence lifecycle.

## Cases

- IndexedDB unavailable
- quota exceeded
- schema upgrade blocked
- old ArtixDB migration
- user changes while migration is running
- multiple tabs open during upgrade
- database closed while sync request is in progress

## Rules

Do not silently swallow database corruption/migration errors.

Return actionable runtime state.

---

# PHASE C12 — Correctness Test Matrix

## Objective

Build tests that target distributed failure modes rather than only functions.

## Required scenarios

### A. Local durability

```text
create offline
edit offline
reload
restart
```

### B. Ambiguous remote result

```text
request sent
server applies mutation
response lost
client retries
```

### C. Concurrent edit

```text
Device A version 10
Device B version 10
A writes version 11
B writes version 10
```

### D. Local edit during push

```text
push revision 10
edit revision 11
ack revision 10
```

### E. Remote stale snapshot

```text
local pending
remote old version arrives
```

### F. Remote delete

```text
client offline
server deletes
client reconnects
```

### G. Leader crash

```text
leader claims
leader dies
standby takes over
```

### H. Account switch

```text
user A active
sync running
logout
login user B
```

### I. Realtime failure

```text
Realtime disabled
cursor pull still converges
```

### J. Duplicate event

```text
same server change delivered repeatedly
```

---

# 4. Formal state models

## 4.1 Local entity state

Recommended conceptual state:

```text
LOCAL_ONLY
PENDING
SYNCING
SYNCED
CONFLICT
BLOCKED
DELETED_PENDING
DELETED_SYNCED
```

Avoid redundant states that mean the same thing.

---

## 4.2 Outbox state

```text
PENDING
   ↓
IN_FLIGHT
   ├── ACKNOWLEDGED
   ├── RETRY
   ├── CONFLICT
   └── BLOCKED
```

`IN_FLIGHT` must always have:

```text
leaseOwner
leaseExpiresAt
```

---

## 4.3 Remote cursor

The cursor can advance only after:

```text
remote change
 ↓
validated
 ↓
locally applied/reconciled
 ↓
transaction committed
 ↓
cursor advanced in same local transaction
```

Never advance the cursor first.

---

# 5. Data contract improvements

## OutboxEntry

Target shape should include at minimum:

```ts
interface OutboxEntry {
  id: string;
  mutationId: string;
  entityType: EntityType;
  entityId: string;
  userId: string;
  projectId: string | null;
  operation: OutboxOperation;
  baseServerVersion: string | null;
  localRevision: number;
  payload: unknown;
  state: OutboxState;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  nextRetryAt?: number | null;
  lastError?: SyncError;
}
```

## SyncMetadata

It must capture:

```text
last acknowledged server version
last acknowledged server snapshot
current local revision
sync state
last synced timestamp
```

## ConflictRecord

It should identify:

```text
mutationId if available
base snapshot
local snapshot
remote snapshot
remote version
local revision
resolution state
```

---

# 6. Server protocol requirements

The server side must provide:

## Versioning

Every synchronized entity has a monotonic version.

## CAS

Updates/deletes are conditional on expected version.

## Idempotency

Mutation IDs are durable and replay-safe.

## Change feed

Every committed create/update/delete becomes a durable ordered change event.

## RLS

The authenticated user can only read/process their own synchronization data.

## Atomic acknowledgement

The server must define precisely what constitutes a successful mutation acknowledgement.

---

# 7. Required code ownership boundaries

## UI/hooks

Responsible for:

- invoking local commands
- subscribing to local data
- displaying sync state

Not responsible for:

- Supabase mutation
- conflict detection
- retry policy
- remote hydration

## Local repositories

Responsible for:

- IndexedDB reads/writes
- atomic entity/outbox/metadata mutations
- local invariants

Not responsible for:

- network requests

## SyncEngine

Responsible for:

- outbox execution
- retry policy
- idempotent push
- server acknowledgement
- invoking pull

## PullEngine

Responsible for:

- remote change feed
- cursor
- remote reconciliation
- tombstones

## ConflictResolver

Responsible for:

- base/local/remote reasoning
- conflict materialization
- resolution strategy

## UserSyncRuntime

Responsible for:

- lifecycle
- dependencies
- user scoping
- realtime
- runtime shutdown

---

# 8. Static architecture audits

Add CI checks that prevent architectural regression.

Examples:

## UI mutation boundary

Fail CI if synchronized UI hooks contain direct:

```text
insert
update
delete
upsert
```

against synchronized Supabase tables.

## Network ownership

Fail CI if local repositories import network clients.

## Runtime ownership

Fail CI if hooks instantiate independent `SyncEngine`, `PullEngine`, or realtime managers.

## Mutation identity

Fail tests if an outbox mutation is created without a stable mutation ID.

## CAS

Fail tests if an update/delete mutation for an existing remote entity has no baseline version.

---

# 9. Phase-by-phase execution protocol for Gemini

Gemini must implement this plan incrementally.

For each phase:

```text
1. Inspect actual current code.
2. Produce a repository-derived phase implementation plan.
3. List invariants.
4. Implement.
5. Add failure-oriented tests.
6. Run targeted tests.
7. Run typecheck.
8. Run lint.
9. Run build when appropriate.
10. Perform static architecture audit.
11. Report remaining risks.
12. Re-analyze before starting the next phase.
```

Do NOT execute all phases in one uncontrolled refactor.

Do NOT assume the previous Phase 0–10 implementation is correct merely because its test suite passed.

Do NOT weaken correctness requirements to preserve old behavior.

Do NOT add compatibility paths that create a second synchronization architecture.

---

# 10. Completion criteria

The correctness pass is complete only when all of these are demonstrably true.

## Local-first

Create/update/delete never waits for network.

## Atomicity

Entity + outbox + metadata commit together.

## Idempotency

Retrying the same mutation has one logical effect.

## CAS

Every existing-record update/delete uses the correct acknowledged server version.

## Revision safety

A stale acknowledgement cannot erase newer local work.

## Pull correctness

Remote changes are applied without overwriting pending local intent.

## Cursor safety

Cursor advances only with successful local application.

## Tombstones

Remote deletes cannot be permanently missed.

## Multi-tab safety

Leader crashes are recoverable.

## Account lifecycle

Runtime and local DB ownership follow authentication lifecycle exactly.

## Realtime independence

The system converges without Realtime.

## Observability

Every stuck mutation can be explained from local state.

## Architectural cleanliness

There is one obvious path for:

```text
local mutation
remote push
remote pull
conflict resolution
runtime lifecycle
```

---

# 11. Final architecture target

The final system should look like:

```text
                         ARTIX
                           │
                    Authenticated User
                           │
                           ▼
                  ┌──────────────────┐
                  │ UserSyncRuntime  │
                  └────────┬─────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
     Local DB           Sync Engine       Realtime
        │                  │                  │
        │            ┌─────┴─────┐            │
        │            ▼           ▼            │
        │          Outbox      PullEngine ◄───┘
        │            │           │
        │            ▼           ▼
        │          Push        Change Feed
        │            │           │
        └────────────┼───────────┘
                     ▼
                  Supabase
                     │
          ┌──────────┼───────────┐
          ▼          ▼           ▼
      Versioning   Idempotency  RLS
          │          │           │
          └──────────┼───────────┘
                     ▼
               Deterministic
              Local Convergence
```

The end state is not merely "offline editing works."

It is:

> **A local-first distributed state engine whose failure modes are explicit, recoverable, testable, and resistant to stale writes, duplicate requests, lost acknowledgements, missed realtime events, crashes, and account transitions.**

That is the correctness bar for Artix before adding major future synchronization surfaces such as GitHub-backed project state.
