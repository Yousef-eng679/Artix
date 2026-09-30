# ARTIX — Documentation Recovery, Canonicalization & Technical Redocumentation Plan

**Status:** Proposed
**Scope:** Repository documentation, planning artifacts, architecture documentation, README, ADRs, historical records
**Primary objective:** Establish one professional, code-derived technical documentation system for Artix and eliminate documentation drift.

---

## 1. Executive Summary

Artix does not currently have a documentation problem caused by “not enough documentation.” It has a **documentation governance problem**.

The repository currently contains several generations of information at the same time:

- planning documents created for AI execution,
- implementation plans that were later partially or fully implemented,
- PR descriptions,
- an older consolidated `DOCS.md`,
- a newer `docs/` tree,
- product requirements under `prd/`,
- and a README that contains both product language and technical claims.

These artifacts were created at different points in the architecture's evolution. As a result, they describe different versions of Artix.

The correct response is **not** to update forty documents one by one.

The correct response is to establish a canonical documentation architecture, inventory all existing artifacts, extract their useful knowledge, archive historical plans, and regenerate the current technical documentation directly from the implementation.

The final state should make the repository read like a serious engineering project:

```text
                    ARTIX DOCUMENTATION
                           │
             ┌─────────────┴─────────────┐
             │                           │
       CURRENT TRUTH                 HISTORY
             │                           │
     ┌───────┼────────┐          ┌───────┼────────┐
     │       │        │          │       │        │
   README  docs/     ADRs      plans   PRs   old architecture
     │       │        │
     └───────┴────────┴─────── current implementation
```

The most important outcome is this:

> **Documentation must describe the system that exists, while explicitly separating product intent, architectural decisions, implementation details, and historical plans.**

---

# 2. Why the Gemini Plans Ended Up in GitHub

This happened because the execution workflow did not distinguish between **agent working material** and **repository documentation**.

An AI coding agent typically sees a plan as a useful project artifact. If the instructions say to create a phase plan, implementation plan, or post-audit document, the model has no inherent reason to keep that file outside the repository.

The repository therefore accumulated files such as:

```text
ARTIX_LOCAL_FIRST_SYNC_HARDENING_PLAN.md
ARTIX_PROJECT_STAGES_TIMETABLE_AND_FOLDER_ANALYSIS.md
Artix_Offline_First_Infrastructure_and_Synchronization_Plan.md
PR_DESCRIPTION.md
PR_DESCRIPTION_OFFLINE_SYNC.md
```

These are useful as **development history**, but they are not good canonical documentation.

The deeper issue is that there was no enforced rule like:

> Temporary execution plans are not canonical documentation and must not be placed in the repository root.

Without that boundary, the AI naturally optimized for preserving context rather than maintaining a clean documentation architecture.

---

# 3. Why the Current Documentation Feels Late and Wrong

The current documentation has been updated **after implementation phases**, instead of being maintained as part of the architecture itself.

That creates three problems.

## 3.1 Documentation describes intentions instead of behavior

A plan may say:

```text
UserSyncRuntime owns authentication lifecycle.
```

while the current authentication code does not actually wire that lifecycle.

The document then describes the desired architecture rather than the implemented architecture.

## 3.2 Documents describe different generations of Artix

For example, the current repository has both:

- older synchronization descriptions,
- newer local-first descriptions,
- and a current implementation that has already moved beyond some of those designs.

The result is not simply “outdated docs.” It is **multiple competing architecture narratives**.

## 3.3 The README is too feature-oriented

The current README describes capabilities well enough for a landing page, but it does not explain the engineering core of Artix deeply enough.

For a technical project, the README should answer questions such as:

- What is the core data model?
- Why is IndexedDB authoritative?
- What exactly is atomic?
- What does the outbox contain?
- How does the push protocol work?
- How does the pull cursor work?
- How are conflicts detected and represented?
- Why is CAS necessary?
- What happens when a response is lost?
- How does multi-tab coordination work?
- What guarantees are provided offline?
- Which guarantees are not yet implemented?

Those are the things that make the project technically interesting.

---

# 4. The New Documentation Philosophy

From this point onward, Artix documentation follows one rule:

> **Current code is the implementation authority. Documentation explains it. Plans describe proposed work. ADRs explain permanent decisions. History is archived.**

That gives the following hierarchy:

```text
CODE
DATABASE MIGRATIONS
TESTS
     ↓
CANONICAL TECHNICAL DOCS
     ↓
README
     ↓
PRODUCT REQUIREMENTS
     ↓
HISTORICAL PLANS
```

If a document conflicts with the implementation, the document is wrong.

If the implementation conflicts with an architectural decision that is still intended to govern the project, the implementation needs to be changed—or the ADR must be superseded.

---

# 5. Four Documentation Classes

Every Artix document must belong to exactly one primary class.

## Class A — Canonical Current Documentation

Describes what exists now.

Location:

```text
docs/
README.md
```

Examples:

- architecture,
- algorithms,
- security model,
- database model,
- testing strategy,
- project structure.

These documents are maintained continuously.

---

## Class B — Product Definition

Describes what Artix is intended to provide as a product.

Location:

```text
prd/
```

This is where product requirements belong.

A PRD may describe a planned feature, but it must not be written as proof that the feature is implemented.

---

## Class C — Architectural Decision Records

Describes why a major architectural choice was made.

Location:

```text
docs/decisions/
```

Example:

```text
ADR-001-authoritative-local-state.md
ADR-002-user-scoped-storage.md
ADR-003-atomic-local-mutation.md
ADR-004-outbox-based-synchronization.md
ADR-005-server-CAS.md
ADR-006-durable-change-feed.md
ADR-007-multi-tab-coordination.md
ADR-008-realtime-as-acceleration.md
```

An ADR records:

1. Context
2. Problem
3. Options considered
4. Decision
5. Consequences
6. Status

An ADR is not an implementation checklist.

---

## Class D — Temporary Execution / Historical Material

These include:

- Gemini execution plans,
- phase instructions,
- investigation notes,
- PR descriptions,
- migration planning drafts,
- abandoned designs.

They belong outside canonical documentation.

Preferred repository location for preserved history:

```text
docs/archive/
```

Temporary work that does not need historical preservation should remain outside the repository altogether.

---

# 6. Target Repository Documentation Structure

The proposed final structure is:

```text
README.md

prd/
└── ARTIX_PRODUCT_REQUIREMENTS_DOCUMENT.md

.artix/                     # optional local-only agent workspace
├── plans/
├── execution/
└── scratch/

docs/
├── README.md
│
├── architecture/
│   ├── OVERVIEW.md
│   ├── SYSTEM.md
│   ├── APPLICATION_LIFECYCLE.md
│   ├── CODE_ORGANIZATION.md
│   ├── DATA_MODEL.md
│   └── DEPENDENCY_BOUNDARIES.md
│
├── algorithms/
│   ├── LOCAL_FIRST_SYNC.md
│   ├── OUTBOX.md
│   ├── PUSH_ENGINE.md
│   ├── PULL_ENGINE.md
│   ├── CHANGE_FEED.md
│   ├── CAS_CONCURRENCY.md
│   ├── CONFLICT_RESOLUTION.md
│   ├── OUTBOX_COMPACTION.md
│   └── MULTI_TAB_COORDINATION.md
│
├── subsystems/
│   ├── EDITOR.md
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
│   ├── ADR-001-authoritative-local-state.md
│   ├── ADR-002-user-scoped-storage.md
│   ├── ADR-003-atomic-local-mutation.md
│   ├── ADR-004-outbox-based-synchronization.md
│   ├── ADR-005-server-CAS.md
│   ├── ADR-006-durable-change-feed.md
│   ├── ADR-007-multi-tab-coordination.md
│   └── ADR-008-realtime-as-acceleration.md
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

This structure gives every document type a home.

---

# 7. Root Directory Policy

The repository root must not become a planning notebook.

The root should contain project essentials such as:

```text
README.md
LICENSE
SECURITY.md
package.json
configuration files
src/
supabase/
tests/
docs/
prd/
```

The following are explicitly discouraged at the root:

```text
*_PLAN.md
*_EXECUTION.md
PR_DESCRIPTION*.md
PHASE_*.md
TEMP_*.md
```

Unless explicitly requested, Gemini must not create such files there.

---

# 8. What to Do With the Existing ~40 Local Artifacts

Do **not** manually rewrite them all.

Perform a batch classification pass.

For every artifact record:

```text
path
category
purpose
source/date
status
current / historical / obsolete
contains architectural decision? yes/no
contains implementation facts? yes/no
duplicate/supersedes
canonical destination
final action
```

The action must be one of:

```text
MERGE
EXTRACT
ARCHIVE
DELETE
KEEP
```

The goal is:

> preserve knowledge, not file count.

---

# 9. Initial Inventory of the Current Repository

The current repository already demonstrates why this cleanup is necessary.

Examples currently present include:

```text
README.md
DOCS.md
ARTIX_LOCAL_FIRST_SYNC_HARDENING_PLAN.md
ARTIX_PROJECT_STAGES_TIMETABLE_AND_FOLDER_ANALYSIS.md
Artix_Offline_First_Infrastructure_and_Synchronization_Plan.md
PR_DESCRIPTION.md
PR_DESCRIPTION_OFFLINE_SYNC.md
```

At the same time, `docs/` already contains its own architecture and sync documentation, including files such as:

```text
docs/ARCHITECTURE.md
docs/LOCAL_FIRST_ARCHITECTURE_SHIFT.md
docs/SYNC_NETWORK_INVENTORY.md
docs/PROJECT_FILE_STRUCTURE.md
docs/TESTING.md
```

And `prd/` contains product/technical specifications.

This is not inherently bad, but the current boundaries are unclear and several files overlap in purpose.

---

# 10. README Redesign — The Most Important Part

The new README should become a **technical architecture document with an approachable entry point**.

It should not be a second marketing page.

It should explain the actual engineering idea behind Artix.

## Proposed README structure

```text
1. Artix
2. Core idea
3. Why Artix exists
4. Project model
5. Core capabilities
6. Architecture overview
7. Local-first architecture
8. Synchronization protocol
9. Core algorithms
10. Conflict model
11. Multi-tab coordination
12. AI architecture
13. Editor architecture
14. System design architecture
15. Authentication and runtime lifecycle
16. Data model
17. Security model
18. Testing strategy
19. Repository structure
20. Development
21. Current implementation status
22. Planned capabilities
23. Documentation map
```

---

# 11. README — Core Product Idea

The README should explain Artix at the conceptual level first.

A useful model is:

```text
              ARTIX PROJECT
                    │
      ┌─────────────┼─────────────┐
      │             │             │
 Documentation  System Design   AI Context
      │             │             │
      └─────────────┼─────────────┘
                    │
               Implementation
                    │
               GitHub / Code
```

The important idea is that Artix is not merely:

```text
Monaco + canvas + AI
```

It is a workspace attempting to keep **project intent, technical knowledge, design, and implementation context connected**.

The README should explain that future GitHub integration extends this model rather than describing it as already implemented.

---

# 12. README — Local-First Architecture

This section should be one of the strongest technical parts of the README.

Explain the invariant:

```text
UI mutation
    ↓
Repository
    ↓
Atomic IndexedDB transaction
    ├── Entity state
    ├── Sync metadata
    └── Outbox mutation
    ↓
Commit
    ↓
UI immediately reflects local state
```

The README must explicitly state that the network is **not part of the local mutation critical path**.

Then explain the background synchronization pipeline:

```text
IndexedDB
   │
   ├── pull remote changes
   │
   └── drain outbox
          │
          ↓
       Supabase
```

---

# 13. README — Outbox Algorithm

Do not describe the outbox as simply “a queue.”

Explain that it is durable mutation state.

Document concepts such as:

- mutation identity,
- entity identity,
- operation type,
- local revision,
- server baseline/version,
- dependency ordering,
- retry state,
- lease ownership,
- retry scheduling,
- conflict/error classification.

Suggested state diagram:

```text
PENDING
   ↓
IN_FLIGHT
 ┌─┼────────────────┐
 ↓ ↓                ↓
ACK CONFLICT     TRANSIENT ERROR
                  ↓
                PENDING

PERMANENT ERROR
      ↓
   BLOCKED
```

The exact state names must be generated from the current implementation.

---

# 14. README — Pull Algorithm

Explain the durable change feed as an ordered server history.

```text
local cursor
    ↓
server change feed
    ↓
ordered changes
    ↓
collision/conflict evaluation
    ↓
atomic local application
    ↓
cursor advancement
```

Most importantly, explain the invariant:

> A remote change must not be considered consumed until the corresponding local transaction and cursor update are durably committed.

This is the type of detail that should appear in the project README because it demonstrates the core engineering model.

---

# 15. README — Push Algorithm

Document:

```text
eligible outbox mutations
        ↓
dependency ordering
        ↓
lease acquisition
        ↓
server mutation
        ↓
CAS / conflict detection
        ↓
acknowledgement or retry
```

Then explain the difficult case:

```text
server commits
      ↓
response is lost
      ↓
client retries
```

This is where mutation identity and idempotency become critical.

The README should explicitly document which guarantees are currently implemented and which are still under hardening.

---

# 16. README — CAS Algorithm

Explain optimistic concurrency with an actual pseudocode example:

```sql
UPDATE documents
SET content = $new_content
WHERE id = $id
  AND version = $base_version;
```

Then:

```text
1 row affected → write accepted
0 rows affected → baseline is stale → reconciliation/conflict path
```

The documentation must reflect the actual database type and trigger behavior instead of copying terminology from older plans.

For example, if the current migration uses `INTEGER`, documentation must not claim `BIGINT` until the migration actually uses it.

---

# 17. README — Conflict Resolution

Explain the difference between:

### Text conflicts

```text
BASE
LOCAL
REMOTE
   ↓
DIFF3
   ↓
MERGED RESULT / CONFLICT
```

### Structured design conflicts

Canvas/system-design state is structured data and should not be treated like arbitrary text.

Document the actual divergence strategy used by the implementation.

Also explain what the user sees after a conflict.

---

# 18. README — Multi-Tab Coordination

Explain:

```text
Tab A ─────┐
Tab B ─────┼── user-scoped coordinator
Tab C ─────┘
             │
             └── one push leader
```

Describe:

- Web Locks,
- BroadcastChannel,
- leader acquisition,
- standby tabs,
- sync requests,
- entity-change announcements,
- duplicate suppression,
- leader loss/recovery.

Crucially, documentation must distinguish **actual implemented behavior** from a planned heartbeat/lease protocol.

Do not document a heartbeat if the current implementation does not actually send one.

---

# 19. README — Authentication and Runtime Lifecycle

Document the intended lifecycle as a state machine:

```text
SIGNED_OUT
   ↓
no user runtime

SIGNED_IN(A)
   ↓
open runtime A
   ↓
open DB A
   ↓
recover outbox leases
   ↓
attach sync engine

A → B
   ↓
stop A
close A DB
   ↓
open runtime B
```

Then verify every arrow against the actual application code.

This section must not describe a runtime as “owned by auth” if the runtime is not wired into the auth lifecycle yet.

---

# 20. README — Security Accuracy

Several existing claims are too strong and must be corrected.

For example:

```text
user-scoped DB naming
```

is not the same thing as:

```text
cryptographic isolation
```

If a database name uses a non-cryptographic hash, it must never be described as a cryptographic partition or a security boundary.

The README should clearly distinguish:

- authentication,
- authorization,
- RLS,
- local isolation,
- browser storage,
- encryption,
- key obfuscation,
- threat model limitations.

---

# 21. Technical Documentation Beyond the README

The README should explain the system, but it should not contain every implementation detail.

The canonical deeper documentation should be split into focused files.

## Architecture

### `docs/architecture/OVERVIEW.md`

The complete system map.

### `docs/architecture/SYSTEM.md`

Detailed frontend, local persistence, sync, backend, and external-service boundaries.

### `docs/architecture/DATA_MODEL.md`

Entity relationships and ownership model.

### `docs/architecture/APPLICATION_LIFECYCLE.md`

Boot, auth, runtime, logout, account switching, shutdown.

### `docs/architecture/CODE_ORGANIZATION.md`

Actual code layout derived from the repository.

### `docs/architecture/DEPENDENCY_BOUNDARIES.md`

Which layer may call which layer.

---

# 22. Algorithm Documentation

Create dedicated documents for the technically interesting parts.

Recommended files:

```text
docs/algorithms/LOCAL_FIRST_SYNC.md
docs/algorithms/OUTBOX.md
docs/algorithms/PULL_ENGINE.md
docs/algorithms/PUSH_ENGINE.md
docs/algorithms/CHANGE_FEED.md
docs/algorithms/CAS_CONCURRENCY.md
docs/algorithms/CONFLICT_RESOLUTION.md
docs/algorithms/OUTBOX_COMPACTION.md
docs/algorithms/MULTI_TAB_COORDINATION.md
```

Each document should contain:

```text
Purpose
Invariant(s)
Inputs
State
Algorithm
Failure cases
Recovery
Concurrency model
Tests
Implementation references
```

This is how Artix gets documentation that is genuinely useful to a technical reader.

---

# 23. Architectural Decision Records

Convert durable choices from the old planning documents into ADRs.

Example:

## ADR-001 — IndexedDB as local authority

### Context
Network access is unreliable and UI mutations must remain available offline.

### Decision
IndexedDB is the authoritative local read/write source for syncable project state.

### Consequence
Network availability must never be required to complete a local mutation.

The implementation plan that originally led to this decision becomes historical.

This distinction is essential:

```text
ADR = why
Implementation doc = how
Plan = how we got there
```

---

# 24. Historical Archive

Do not delete the accumulated work merely because it is no longer canonical.

Move useful historical documents into:

```text
docs/archive/plans/
docs/archive/execution/
docs/archive/superseded/
docs/archive/historical/
```

Add a small note to archived documents:

```markdown
> Historical document. This file describes an earlier Artix architecture or implementation phase and is not authoritative for the current system.
```

This preserves the engineering journey without confusing future readers.

---

# 25. Specific Existing Files — Recommended Treatment

The current repository suggests the following migration pattern.

## Keep and rewrite

```text
README.md
```

Rewrite completely around the current architecture.

```text
docs/README.md
```

Turn into the documentation index and navigation map.

```text
prd/ARTIX_PRODUCT_REQUIREMENTS_DOCUMENT.md
```

Keep as product requirements after separating implemented functionality from roadmap items.

---

## Split / replace

```text
DOCS.md
```

This should stop being the second competing documentation system.

Its useful content should be redistributed into:

```text
docs/architecture/
docs/algorithms/
docs/subsystems/
docs/security/
docs/engineering/
docs/reference/
```

Then archive the old `DOCS.md` rather than maintaining it in parallel.

---

## Rewrite from code

```text
docs/ARCHITECTURE.md
docs/PROJECT_FILE_STRUCTURE.md
docs/SYNC_NETWORK_INVENTORY.md
docs/LOCAL_FIRST_ARCHITECTURE_SHIFT.md
docs/CHALLENGES_AND_SOLUTIONS.md
docs/TESTING.md
docs/API.md
```

Do not simply edit these line by line.

Use them as source material, then regenerate canonical documents from the actual code and migrations.

---

## Archive

Typical examples:

```text
ARTIX_LOCAL_FIRST_SYNC_HARDENING_PLAN.md
ARTIX_PROJECT_STAGES_TIMETABLE_AND_FOLDER_ANALYSIS.md
Artix_Offline_First_Infrastructure_and_Synchronization_Plan.md
PR_DESCRIPTION.md
PR_DESCRIPTION_OFFLINE_SYNC.md
```

Their useful ideas should be extracted first.

---

# 26. Documentation Regeneration Method

The new documentation pass must start from the implementation.

For architecture documents, the agent must inspect:

```text
src/lib/local/*
src/lib/repositories/*
src/lib/sync/*
src/hooks/*
src/integrations/*
supabase/migrations/*
tests/*
```

For synchronization specifically:

```text
local database
entity repositories
outbox types
outbox repository
sync metadata
sync engine
pull engine
push adapters
conflict repository
conflict resolver
tab coordinator
user sync runtime
realtime manager
auth lifecycle
```

The old markdown is reference material only.

It is never the primary source for determining current behavior.

---

# 27. Documentation Accuracy Protocol

Every important claim must be classified as:

```text
IMPLEMENTED
PLANNED
EXPERIMENTAL
DEPRECATED
HISTORICAL
```

Never write planned behavior as present tense implementation.

Examples:

### Good

> GitHub synchronization is planned and is not currently part of the synchronization runtime.

### Bad

> Artix synchronizes projects with GitHub.

when the feature does not exist yet.

---

# 28. Claims That Require Special Verification

During the documentation rewrite, search for strong claims such as:

```text
100% offline
zero data leakage
cryptographically partitioned
BIGINT
heartbeat
idempotent
exactly-once
real-time synchronization
continuous synchronization
atomic
conflict-free
```

Each claim must be verified against implementation and tests.

The documentation should prefer precise engineering language over impressive-sounding language.

---

# 29. Test Documentation Must Be Derived From Current Reality

Never keep stale test counts in documentation.

Instead of:

```text
78 tests pass
```

write the exact current suite composition only after verification.

The testing document should state:

- unit tests,
- integration tests,
- E2E tests,
- security tests,
- sync correctness tests,
- failure-injection tests,
- build/type/lint gates.

The documentation must explain **what correctness properties are being tested**, not only the number of tests.

---

# 30. README Quality Standard

The new README should feel like a technical project overview written for an engineer who wants to understand how Artix works.

It should contain:

- diagrams,
- state machines,
- sequence diagrams,
- pseudocode,
- architectural invariants,
- failure scenarios,
- implementation references.

It should avoid paragraphs full of marketing adjectives such as:

```text
modern
powerful
robust
scalable
enterprise-ready
high-performance
```

unless the statement is backed by measurable behavior.

---

# 31. Documentation Change Workflow Going Forward

The future workflow should be:

```text
architecture change
       ↓
identify affected ADR / docs
       ↓
implement change
       ↓
update canonical technical docs
       ↓
update README summary if necessary
       ↓
update changelog
       ↓
verify docs against code/tests
```

Not:

```text
build 20 features
      ↓
remember documentation later
      ↓
ask AI to rewrite everything from old markdown
```

That second workflow is what caused the current drift.

---

# 32. Gemini Governance Rules

These rules should be added permanently to the Gemini master instructions.

```text
DOCUMENTATION GOVERNANCE

1. Do not create planning documents in the repository root.
2. Do not create duplicate architecture documents when a canonical document already exists.
3. Temporary execution plans are not canonical project documentation.
4. Keep transient agent planning outside the committed documentation tree unless explicitly requested.
5. Before modifying documentation, inspect the current implementation, migrations, and tests.
6. Never document a desired architecture as implemented architecture.
7. Label planned, experimental, deprecated, and historical behavior explicitly.
8. README.md is the high-level technical entry point.
9. docs/ contains canonical technical documentation.
10. docs/decisions/ contains durable architectural decisions.
11. docs/archive/ contains superseded and historical material.
12. When architecture changes, update the canonical documentation in the same change set whenever practical.
13. Do not copy stale claims from older plans without verifying them against code.
14. Do not add a new markdown artifact merely to summarize a phase unless the artifact has permanent documentation value.
15. If a planning document contains a durable architectural decision, extract that decision into an ADR and archive the original plan.
```

---

# 33. Migration Phases

## DOC-0 — Documentation Freeze

Stop creating new planning files while the inventory is performed.

Do not start broad documentation edits yet.

---

## DOC-1 — Inventory

Create a temporary inventory containing every planning/documentation artifact.

Output:

```text
DOCUMENTATION_INVENTORY.md
```

This file itself is temporary and should be removed or archived after migration.

---

## DOC-2 — Classification

Assign every document to:

```text
CURRENT
PRODUCT
DECISION
HISTORICAL
OBSOLETE
```

Record its destination.

---

## DOC-3 — Canonical Architecture Extraction

Inspect the codebase and migrations first.

Create the canonical architecture tree from implementation truth.

This is the most important phase.

---

## DOC-4 — Algorithm Documentation

Write detailed documents for:

- local-first mutation protocol,
- outbox,
- push,
- pull,
- change feed,
- CAS,
- conflict resolution,
- compaction,
- multi-tab coordination.

---

## DOC-5 — Subsystem Documentation

Write focused documentation for:

- editor,
- system design,
- AI,
- auth,
- billing,
- PWA,
- exports.

---

## DOC-6 — Security and Engineering Docs

Write:

- security model,
- threat model,
- migration strategy,
- testing strategy,
- development workflow.

---

## DOC-7 — ADR Extraction

Extract permanent architectural decisions from historical plans.

Archive the original plans.

---

## DOC-8 — Rewrite README

Only after the architecture and algorithm docs exist.

The README becomes the concise high-level narrative that links into the deeper technical documents.

---

## DOC-9 — Repository Cleanup

Archive or remove duplicate documentation systems.

The project should no longer have two competing technical specs.

---

## DOC-10 — Documentation Audit

Verify every claim against:

```text
source code
migrations
tests
current project structure
```

---

# 34. Definition of Done

The documentation migration is complete only when all of these are true:

- There is one obvious current architecture source of truth.
- README accurately represents the current Artix system.
- The README explains the project's core technical ideas, not just its features.
- Non-trivial algorithms are explicitly documented.
- Local-first synchronization is documented as a protocol, not a buzzword.
- Outbox state and recovery are documented.
- Pull, push, CAS, conflict resolution, and multi-tab coordination have dedicated technical documentation.
- Product requirements are separated from implementation documentation.
- Architectural decisions are recorded as ADRs.
- Historical execution plans are archived.
- The repository root is clean.
- Duplicate architecture narratives are eliminated.
- Database documentation matches current migrations.
- Project structure documentation matches the code.
- Security claims are technically precise.
- Test documentation reflects the current suite.
- Planned functionality is labeled planned.
- No AI agent is free to add random documentation files to the repository.
- A new engineer can understand the architecture without reading the historical planning backlog.

---

# 35. Final Principle

The new Artix documentation system should not document **the process of building Artix** as its primary purpose.

It should document **Artix itself**.

The distinction is:

```text
OLD MODEL

plan → plan → phase → PR → plan → architecture → patch → README

NEW MODEL

                  ┌──────────────┐
                  │  CODE + DB   │
                  │  + TESTS     │
                  └──────┬───────┘
                         │
                  CURRENT TRUTH
                         │
          ┌──────────────┼──────────────┐
          ↓              ↓              ↓
     ARCHITECTURE     ALGORITHMS       ADRs
          └──────────────┼──────────────┘
                         ↓
                      README
                         │
                         ↓
                HUMAN-READABLE SYSTEM
```

That is the documentation architecture Artix should keep as the project grows.
