# Artix Documentation Recovery & Technical Redocumentation Plan
## Post-C12 Repository + 35+ Local Artifact Corpus

**Target repository:** `Yousef-eng679/Artix`
**Target branch:** `main`
**Documentation phase:** begins after Sync Correctness Hardening C0–C12
**Primary goal:** establish a single, accurate, architecture-first documentation system without losing the knowledge contained in the 35+ local artifacts.

---

## 0. DOCUMENT STATUS

This is an **execution plan for the documentation phase**.

It is not a substitute for repository inspection. Before editing any canonical document, inspect the actual repository, migrations, tests, and all available local artifacts.

### Current truth boundary

The repository has completed the C0–C12 synchronization correctness pass. The documentation phase must therefore describe the **post-C12 implementation**, not the architecture that existed before the correctness pass.

The current repository already contains substantial synchronization documentation, including:

- `docs/SYNC_PROTOCOL.md`
- `docs/SYNC_FAILURE_MODES.md`
- `docs/SYNC_STATE_MACHINE.md`
- `docs/LOCAL_FIRST_ARCHITECTURE_SHIFT.md`
- `docs/SYNC_NETWORK_INVENTORY.md`
- `docs/PROJECT_FILE_STRUCTURE.md`
- `docs/TESTING.md`
- `docs/API.md`
- `prd/*`
- root `README.md`, `DOCS.md`, and `SECURITY.md`

The current implementation also contains explicit synchronization subsystems such as:

- user-scoped IndexedDB persistence
- repositories and atomic local mutation pipelines
- outbox persistence and mutation compaction
- `SyncEngine`
- `PullEngine`
- entity-specific push adapters
- idempotency tracking
- CAS/version baselines
- conflict resolution
- tombstone management
- `TabCoordinator`
- `RealtimeSyncManager`
- `UserSyncRuntime`
- Supabase migrations for server concurrency and durable change tracking

These are the material the new canonical documentation must explain.

---

# 1. CORE DOCUMENTATION PRINCIPLE

Artix documentation must become a **system of connected canonical documents**, not a pile of descriptions and historical plans.

The documentation should answer four questions clearly:

1. **What is Artix?** — product and engineering model.
2. **How does Artix work today?** — current implementation.
3. **Why is it designed this way?** — durable architectural decisions.
4. **What is planned but not implemented?** — future architecture.

Never mix these four categories without explicit status labels.

---

# 2. SOURCE-OF-TRUTH HIERARCHY

When sources disagree, use this authority order:

```text
CODE + DATABASE MIGRATIONS + TESTS
            ↓
CURRENT ARCHITECTURE DOCUMENTATION
            ↓
ARCHITECTURAL DECISIONS / ADRs
            ↓
PRD / PRODUCT INTENT
            ↓
LOCAL DESIGN NOTES / HISTORICAL ARTIFACTS
            ↓
OLD PLANS / AI-GENERATED EXECUTION NOTES
```

### Interpretation rule

A local artifact can contain valuable knowledge without being current truth.

For every statement extracted from local artifacts, classify it as one of:

- `IMPLEMENTED`
- `PLANNED`
- `PROPOSED`
- `HISTORICAL`
- `SUPERSEDED`
- `UNVERIFIED`

Never promote a historical or planned statement into an implemented claim merely because it is technically detailed.

---

# 3. THE 35+ LOCAL ARTIFACTS ARE A KNOWLEDGE CORPUS

The 35+ local files that are not on GitHub must be treated as a **documentation corpus**.

Do NOT begin by moving them into the repository.

Do NOT delete them.

Do NOT automatically place them under `docs/archive/`.

First perform a corpus analysis.

## 3.1 Build an artifact registry

For every local artifact, record:

| Field | Meaning |
|---|---|
| Artifact | filename/path |
| Type | architecture / PRD / plan / ADR / research / changelog / prompt / notes |
| Era | approximate date or development stage |
| Scope | product / frontend / sync / database / AI / security / billing / UX / etc. |
| Authority | product intent / current design / implementation plan / historical |
| Current status | implemented / planned / superseded / unknown |
| Related repo files | files or subsystems referenced |
| Useful knowledge | what should survive |
| Duplicate of | canonical or other artifact, if applicable |
| Final action | extract / merge / archive / discard |

The registry should become the map of the entire documentation corpus.

## 3.2 Cluster the corpus

Group artifacts by subject rather than filename.

Recommended clusters:

```text
PRODUCT
ARCHITECTURE
LOCAL-FIRST / SYNC
DATABASE / SUPABASE
EDITOR / WORKSPACE
SYSTEM DESIGN / CANVAS
AI / PROMPT GENERATION
AUTH / SECURITY
BILLING
PWA / OFFLINE
TESTING
UI / UX
DEPLOYMENT
HISTORICAL PLANS
MISCELLANEOUS
```

## 3.3 Extract knowledge instead of copying files

For each cluster, identify:

- facts still true in code
- useful design rationale
- architectural decisions
- unresolved questions
- future ideas
- obsolete assumptions
- duplicate descriptions

The output should be **normalized knowledge**, not 35+ slightly different Markdown copies.

---

# 4. DOCUMENTATION GOVERNANCE

Artix must have explicit document boundaries from this phase onward.

## 4.1 Canonical locations

```text
README.md
    Public technical entry point

prd/
    Product intent and requirements

docs/
    Current technical documentation

docs/architecture/
    System architecture and runtime structure

docs/algorithms/
    Non-trivial algorithms and synchronization mechanics

docs/subsystems/
    Feature/subsystem implementation documentation

docs/security/
    Security model and trust boundaries

docs/engineering/
    Development, testing, migrations, observability

docs/reference/
    API/schema/environment/reference material

docs/decisions/
    Durable architectural decisions / ADRs

docs/archive/
    Superseded plans and historical material
```

The exact number of files may be reduced when two documents naturally belong together. Avoid creating tiny documents purely to satisfy a taxonomy.

## 4.2 Temporary AI work

Temporary execution plans, agent scratchpads, audit notes, intermediate generated files, and one-off analysis must not become canonical documentation.

Preferred local-only areas:

```text
.artix/
├── plans/
├── execution/
├── scratch/
└── artifact-registry/
```

These should normally be ignored by Git unless a specific artifact has permanent value and is intentionally promoted.

---

# 5. MANDATORY PRE-EDIT AUDIT

Before rewriting any document, inspect the post-C12 repository.

Minimum inspection targets:

### Application entry/lifecycle

- `src/main.tsx`
- `App` / routing
- authentication provider/runtime context
- `UserSyncRuntime`

### Local persistence

- `src/lib/local/*`
- IndexedDB/Dexie database definition
- user-scoping
- migrations
- local entity types

### Repositories

- document repository
- system design repository
- folder repository
- outbox repository
- sync metadata repository
- conflict repository

### Synchronization

- `SyncEngine`
- `PullEngine`
- push adapters
- idempotency helpers
- dependency ordering
- conflict resolver
- tombstone manager
- realtime manager
- tab coordinator
- transport timeout/error taxonomy

### Database

Inspect all relevant Supabase migrations, especially:

- concurrency/versioning
- durable `sync_changes`
- idempotency ledger
- workspace folders
- RLS/auth constraints
- deletion behavior
- triggers/functions

### Tests

Inspect tests covering:

- local-first behavior
- outbox behavior
- CAS
- idempotency
- conflict handling
- lifecycle
- multi-tab behavior
- realtime
- tombstones
- distributed failure scenarios

### Product systems

Also inspect the actual implementation of:

- editor/workspace
- system design/canvas
- AI generation pipeline
- authentication
- BYOK/key storage
- billing
- PWA/service worker
- exports
- deployment configuration

---

# 6. ACCURACY AUDIT OF EXISTING DOCUMENTS

The current documentation should be treated as an existing knowledge base that needs reconciliation, not as a clean foundation.

The audit must explicitly search for contradictions such as:

### A. Leader/heartbeat claims

Some current documentation describes heartbeat-based leader recovery, while the current `TabCoordinator` implementation primarily uses the Web Locks API and leadership-change callbacks. Documentation must describe the mechanism actually implemented.

Do not document heartbeat behavior unless it exists in code and tests.

### B. Server version type

Some documentation describes server entity versions as `BIGINT`, while the current server concurrency migration adds `INTEGER` versions and later idempotency metadata includes `BIGINT` fields. The final documentation must reflect the actual schema and clearly identify any schema inconsistency that remains.

### C. Delete semantics

Some protocol text describes durable cloud soft deletes/tombstones, while entity push adapters currently perform delete operations against the entity tables. The final documentation must distinguish:

- local tombstone behavior
- cloud deletion behavior
- change-feed deletion records
- garbage collection

Do not collapse these into one generic "soft delete" statement.

### D. Outbox state names

Compare every state name in Markdown against the actual TypeScript union and runtime transitions. Do not preserve outdated states such as `ACKNOWLEDGED` or `RETRY` merely because they appear in older prose if the implementation represents them differently.

### E. Exactly-once language

Idempotency is implemented as a durable mutation-ID ledger pattern, but the client-side mutation and ledger-recording calls are not one server-side atomic transaction. Documentation must not claim strict database-level exactly-once execution unless the implementation actually provides it.

Use precise language such as:

> duplicate retries are detected through durable mutation identity when the mutation has been recorded in the server ledger.

### F. Realtime semantics

Realtime is an acceleration/wakeup mechanism. Durable change-feed cursor processing remains the correctness path for missed events.

Do not describe Realtime as the sole synchronization source.

### G. Security terminology

Do not describe a user-scope hash or database naming convention as a cryptographic security boundary. Security guarantees must be attributed to actual isolation mechanisms such as authenticated user IDs, RLS, scoped runtime lifecycle, and storage separation.

---

# 7. TARGET DOCUMENTATION ARCHITECTURE

Use the following as the default canonical structure.

```text
README.md

prd/
└── ARTIX_PRODUCT_REQUIREMENTS_DOCUMENT.md

# Existing PRD/technical-spec files may remain when they serve distinct purposes.

docs/
├── README.md
│
├── architecture/
│   ├── OVERVIEW.md
│   ├── SYSTEM.md
│   ├── DATA_MODEL.md
│   ├── APPLICATION_LIFECYCLE.md
│   ├── CODE_ORGANIZATION.md
│   └── DEPENDENCY_BOUNDARIES.md
│
├── algorithms/
│   ├── LOCAL_FIRST_SYNC.md
│   ├── OUTBOX.md
│   ├── PULL_ENGINE.md
│   ├── PUSH_ENGINE.md
│   ├── CONFLICT_RESOLUTION.md
│   ├── CHANGE_FEED.md
│   ├── MULTI_TAB_COORDINATION.md
│   ├── OUTBOX_COMPACTION.md
│   └── TOMBSTONES.md
│
├── subsystems/
│   ├── EDITOR.md
│   ├── WORKSPACE.md
│   ├── SYSTEM_DESIGN.md
│   ├── AI_PIPELINE.md
│   ├── AUTHENTICATION.md
│   ├── BILLING.md
│   ├── PWA.md
│   └── EXPORTS.md
│
├── security/
│   ├── SECURITY_MODEL.md
│   ├── RLS_AND_AUTH.md
│   ├── CLIENT_KEY_STORAGE.md
│   └── THREAT_MODEL.md
│
├── engineering/
│   ├── DEVELOPMENT.md
│   ├── TESTING.md
│   ├── MIGRATIONS.md
│   ├── OBSERVABILITY.md
│   └── AI_ASSISTED_DEVELOPMENT.md
│
├── reference/
│   ├── API.md
│   ├── DATABASE_SCHEMA.md
│   ├── ENVIRONMENT.md
│   └── PROJECT_STATUS.md
│
├── decisions/
│   ├── ADR-001-local-first-authority.md
│   ├── ADR-002-user-scoped-storage.md
│   ├── ADR-003-single-write-pipeline.md
│   ├── ADR-004-server-CAS.md
│   ├── ADR-005-durable-change-feed.md
│   ├── ADR-006-multi-tab-coordination.md
│   └── ADR-007-realtime-as-wakeup.md
│
├── changelog/
│   └── CHANGELOG.md
│
└── archive/
    ├── plans/
    ├── execution/
    ├── superseded/
    └── historical/
```

This is a target architecture, not a mandate to create every file. Merge documents when the subject is small enough to remain coherent.

---

# 8. THE NEW README MUST BE TECHNICAL

Replace the current root README with a serious engineering entry point.

The README should explain Artix as a **project engineering workspace** connecting:

```text
Project Intent
      ↓
Documents / Specifications
      ↓
System Design / Architecture
      ↓
AI Context & Generation
      ↓
Implementation
      ↓
Future GitHub / Codebase Integration
```

It should include, in a readable order:

1. What Artix is
2. Core problem it addresses
3. Project/workspace model
4. Current capabilities
5. Architecture overview
6. Technology stack
7. Local-first architecture
8. Synchronization model
9. Outbox and dependency ordering
10. CAS and concurrency semantics
11. Pull/change-feed model
12. Conflict handling
13. Multi-tab coordination
14. User runtime lifecycle
15. Realtime role
16. Data model
17. AI subsystem architecture
18. Editor/workspace/system-design architecture
19. Security model
20. Billing/authentication/PWA
21. Testing strategy
22. Repository structure
23. Current implementation status
24. Planned/future architecture
25. Documentation map

### README style

It should use diagrams, tables, and small pseudocode blocks where they clarify behavior.

It should avoid unsupported marketing language.

It should distinguish:

- `IMPLEMENTED`
- `PLANNED`
- `EXPERIMENTAL`
- `HISTORICAL`

---

# 9. SYNCHRONIZATION DOCUMENTATION MUST BE ALGORITHM-FIRST

The synchronization system is one of Artix's technically distinctive parts. It deserves documentation that explains behavior, not only file names.

At minimum document:

### 9.1 Local write pipeline

```text
User mutation
    ↓
Repository transaction
    ├── entity state
    ├── outbox mutation
    └── sync metadata
    ↓
local commit succeeds
    ↓
UI continues immediately
    ↓
background synchronization
```

### 9.2 Outbox lifecycle

Document actual states and transitions from TypeScript.

Explain:

- mutation identity
- local revision
- base server version
- leases
- retries
- permanent failures
- compaction
- deletion/restore transitions
- dependency ordering

### 9.3 Pull algorithm

Explain:

- durable cursor
- ordered change feed
- remote hydration
- pending-local protection
- cursor advancement only after successful local application
- stale event handling

### 9.4 Push algorithm

Explain:

- leader ownership
- lease acquisition
- dependency ordering
- CAS predicate
- mutation ID
- acknowledgement processing
- local revision race handling
- retry/error classification

### 9.5 Conflict algorithm

Explain three-way merge using:

```text
base
local
remote
```

For each entity type, document whether the result is:

- automatic merge
- user-resolved merge
- keep-local
- keep-remote
- divergent copy
- blocked/conflict state

### 9.6 Tombstones

Explain local deletion state, remote deletion semantics, change-feed events, retention, and purge conditions separately.

---

# 10. ARCHITECTURAL DECISIONS

Convert durable decisions from the local corpus into concise ADRs.

Each ADR should include:

```text
Context
Decision
Alternatives considered
Why this decision was made
Consequences
Current implementation
Status
Related code/docs
```

Do not create ADRs for ordinary implementation details.

Prioritize the decisions that explain why the architecture is shaped as it is.

---

# 11. LOCAL ARTIFACT PROMOTION RULES

A local artifact may be promoted only when its knowledge has been classified.

### Promote to canonical current docs when:

- the implementation confirms it
- it describes a stable subsystem
- it contains important technical knowledge not already documented

### Convert into an ADR when:

- it records a durable architectural choice
- the choice explains tradeoffs
- the rationale remains useful to future maintainers

### Keep as PRD/product material when:

- it expresses desired behavior
- it defines product requirements
- it does not claim to describe current implementation

### Archive when:

- the material is historical but useful
- it explains an architectural evolution
- it documents why an abandoned approach was rejected

### Discard after extraction when:

- it is a duplicate
- it contains obsolete implementation detail with no historical value
- it is a transient AI execution artifact

Do not lose unique knowledge simply because the original document is obsolete.

---

# 12. EXISTING REPOSITORY DOCUMENT TREATMENT

Do not blindly preserve every current document.

### Root

`README.md`
- rewrite as the primary technical entry point

`DOCS.md`
- do not keep a giant competing technical specification if its content can be distributed across canonical docs
- extract valuable content
- redirect or retire it after the new hierarchy exists

`SECURITY.md`
- retain as the public security policy, but align technical claims with current implementation

### `docs/`

Documents such as:

- `ARCHITECTURE.md`
- `LOCAL_FIRST_ARCHITECTURE_SHIFT.md`
- `SYNC_PROTOCOL.md`
- `SYNC_FAILURE_MODES.md`
- `SYNC_STATE_MACHINE.md`
- `SYNC_NETWORK_INVENTORY.md`
- `PROJECT_FILE_STRUCTURE.md`
- `TESTING.md`
- `API.md`
- `CHALLENGES_AND_SOLUTIONS.md`

should be audited individually.

Some can become canonical documents after correction; some should be merged; some should become historical/archive material.

### `prd/`

Keep product requirements separate from current implementation documentation.

A PRD should be allowed to describe desired/future behavior without being mistaken for code truth.

---

# 13. STATUS LABEL SYSTEM

Every major architecture document should have a status banner when appropriate:

```text
Status: IMPLEMENTED
Verified against: <commit/date>
```

or:

```text
Status: PARTIALLY IMPLEMENTED
Verified portions: ...
Unimplemented portions: ...
```

or:

```text
Status: PLANNED
```

or:

```text
Status: HISTORICAL / SUPERSEDED
```

This is especially important for local-first, GitHub integration, Excalidraw integration, advanced AI features, and any future architecture discussed in old artifacts.

---

# 14. DOCUMENTATION VERIFICATION GATE

Before a documentation PR is considered complete, perform all of these checks.

## Code consistency

Does every implementation claim match current source code?

## Database consistency

Do schemas, migrations, types, triggers, RLS policies, and delete semantics match documentation?

## Behavioral consistency

Do state machines and pseudocode match runtime behavior?

## Test consistency

Do test counts, test names, and verification commands match the repository?

## Lifecycle consistency

Are login, logout, account switching, startup, shutdown, and failure behavior described correctly?

## Naming consistency

Do docs use the same names as source code?

## Status consistency

Is future work clearly separated from implemented behavior?

## Link consistency

Do internal Markdown links point to the new canonical locations?

## Duplication audit

Is there more than one document claiming to be the authoritative description of the same subsystem?

If yes, merge, redirect, or archive.

---

# 15. EXECUTION PHASES

## DOC-0 — Freeze the correctness baseline

Record the post-C12 repository state used for documentation.

Do not modify synchronization implementation during this documentation pass unless a documentation audit discovers a factual contradiction that requires a separate engineering issue.

Documentation work must not silently turn into another correctness pass.

## DOC-1 — Repository inventory

Inventory:

- root files
- `src` architecture
- sync subsystem
- repositories
- migrations
- tests
- existing docs
- PRD files
- deployment/configuration

Produce a machine-readable map if useful.

## DOC-2 — Local artifact inventory

Scan all 35+ local artifacts.

Build the artifact registry.

Cluster and classify them.

Do not edit or delete them yet.

## DOC-3 — Truth reconciliation

For every major subsystem, compare:

```text
code ↔ migrations ↔ tests ↔ current docs ↔ local artifacts
```

Record contradictions.

Do not resolve contradictions by guessing.

Use implementation evidence as the current truth boundary.

## DOC-4 — Canonical information model

Design the final documentation structure and identify:

- documents to create
- documents to rewrite
- documents to merge
- documents to rename
- documents to archive
- documents to retire

## DOC-5 — Extract local knowledge

Transfer valuable information from the local corpus into:

- README
- architecture docs
- algorithms docs
- subsystem docs
- ADRs
- PRD
- historical archive

Track each artifact's disposition in the registry.

## DOC-6 — Rewrite root README

Produce the technical README described in Section 8.

## DOC-7 — Rewrite architecture documentation

Create the authoritative current architecture model.

The main architecture diagram should show roughly:

```text
UI
 ↓
Repositories / Local Application API
 ↓
IndexedDB / Dexie
 ├── Entity State
 ├── Outbox
 └── Sync Metadata
 ↓
UserSyncRuntime
 ├── PullEngine
 ├── SyncEngine
 ├── Conflict Handling
 ├── Realtime Wakeup
 └── Multi-Tab Coordination
 ↓
Supabase / PostgreSQL
 ├── Entity Tables
 ├── CAS Versions
 ├── sync_changes
 ├── processed_mutations
 └── RLS/Auth
```

Only include boxes that the current code actually implements.

## DOC-8 — Rewrite algorithm documentation

Document the local-first and synchronization mechanisms in detail.

This is the most important technical documentation group.

## DOC-9 — Rewrite subsystem documentation

Document:

- workspace/editor
- system design
- AI pipeline
- authentication
- BYOK
- billing
- PWA
- exports

## DOC-10 — Create ADRs

Extract durable architectural decisions from the local corpus and repository history.

## DOC-11 — Archive historical material

Move superseded repository plans and historical notes into the archive structure where their history is genuinely useful.

Do not fill the archive with every old AI prompt.

## DOC-12 — Link and navigation cleanup

Ensure README → docs → subsystem docs → ADRs → reference docs form a navigable documentation graph.

## DOC-13 — Accuracy audit

Perform the verification gate from Section 14.

Search specifically for stale numbers, old file names, old state names, outdated architecture terms, and false implementation claims.

## DOC-14 — Documentation release

Only after the previous phases succeed:

- remove/retire obsolete canonical competitors
- update changelog
- finalize documentation index
- ensure root is clean
- produce a summary of artifact dispositions

---

# 16. GEMINI EXECUTION RULES

Paste these rules at the top of the execution task.

```text
DOCUMENTATION GOVERNANCE

1. Treat the post-C12 repository implementation as the current engineering truth.
2. Inspect code, migrations, tests, and existing docs before writing replacement documentation.
3. Also inspect the complete local artifact corpus available in the workspace.
4. Never assume a local artifact is current merely because it is detailed or recent-looking.
5. Do not delete local artifacts during the analysis phase.
6. Build an artifact registry before deciding what to archive or discard.
7. Preserve unique knowledge even when the original document is obsolete.
8. Do not create duplicate architecture documents.
9. Do not create planning documents in the repository root.
10. Temporary agent plans are not canonical documentation.
11. README is the public technical entry point.
12. docs/ describes the current implementation.
13. docs/decisions/ contains durable architectural rationale.
14. prd/ describes product requirements and intended behavior.
15. docs/archive/ contains superseded or historical material.
16. Never document desired behavior as implemented.
17. Never claim guarantees stronger than the implementation provides.
18. Realtime is not the synchronization correctness source; durable change-feed processing is.
19. Do not call user-scope hashing cryptographic isolation.
20. Verify every schema/type/state-machine claim against current code and migrations.
21. During this phase, do not silently modify application behavior to make documentation easier to write.
22. If a technical contradiction requires code changes, record it separately as an engineering issue instead of mixing it into documentation work.
23. Avoid a giant monolithic DOCS.md becoming a second competing source of truth.
24. Prefer fewer, stronger canonical documents over dozens of small files.
25. Every document must clearly distinguish IMPLEMENTED, PLANNED, HISTORICAL, and SUPERSEDED material.
26. After each major documentation group, run a consistency audit against the repository.
```

---

# 17. DEFINITION OF DONE

The documentation phase is complete only when:

- the root README accurately explains the real Artix architecture
- there is one obvious source of truth for each major subsystem
- the post-C12 synchronization architecture is documented accurately
- algorithms are explained, not merely named
- local-first, outbox, CAS, pull, push, conflict, tombstone, realtime, and multi-tab behavior are understandable
- current and future architecture are clearly separated
- architectural decisions have durable ADRs where justified
- the 35+ local artifacts have been inventoried and each has a disposition
- unique knowledge from local artifacts has been preserved
- obsolete duplicates are no longer competing with canonical docs
- root-level documentation is clean
- internal documentation links work
- schema/state/test claims match the implementation
- security wording is technically precise
- test counts and status claims are current
- a new engineer can understand Artix without reading historical planning files first

The final repository should feel like a **coherent technical system manual**, not a chronological dump of AI-generated plans.

---

# 18. IMPORTANT EXECUTION CONSTRAINT

The 35+ local artifacts should be considered a **source corpus first, repository content second**.

The desired outcome is not:

```text
35 local files → 35 files in GitHub
```

The desired outcome is:

```text
35+ local artifacts
        ↓
artifact inventory
        ↓
knowledge extraction
        ↓
truth reconciliation against code
        ↓
canonical architecture + algorithms + ADRs + PRD
        ↓
small, coherent documentation system
        ↓
historical archive only where justified
```

This preserves the intellectual history of Artix without allowing historical planning material to compete with the implementation as documentation.
