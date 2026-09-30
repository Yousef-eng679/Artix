# Artix — Local-First Engineering Workspace & Specification Engine

> **Engineering Status**: Production-Ready Post-C12 Synchronized Architecture  
> **Verification**: 81 Test Files Passed (566/566 Tests Green) | TypeScript Strict Clean | ESLint 0 Errors

Artix is a local-first software engineering workspace designed for technical leads, system architects, and developers. It unifies multi-format technical specifications, visual system design, and context-injected AI prompt engineering into an authoritative, offline-first client application powered by Dexie IndexedDB and synchronized with Supabase PostgreSQL.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                             ARTIX WORKSPACE                                 │
│                                                                             │
│   Project Intent ───► Technical Specs ───► Visual Architecture ───► AI      │
│      (PRD Engine)        (Monaco Forge)        (Canvas Graph)     Context   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Direct Local Commit (0ms latency)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    LOCAL-FIRST PERSISTENCE LAYER (IndexedDB)                 │
│                                                                             │
│   ┌───────────────────┐     ┌───────────────────┐    ┌──────────────────┐   │
│   │   Entity State    │     │   Durable Outbox  │    │  Sync Metadata   │   │
│   │ Documents/Designs │     │ Mutations / Leases│    │ Revisions/Status │   │
│   └───────────────────┘     └───────────────────┘    └──────────────────┘   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Asynchronous Push / Pull
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      CLOUD REPLICATION ENGINE (Supabase)                    │
│                                                                             │
│   ┌───────────────────┐     ┌───────────────────┐    ┌──────────────────┐   │
│   │ PostgreSQL Tables │     │ CAS Concurrency   │    │  `sync_changes`  │   │
│   │ Documents/Designs │     │ Version Invariant │    │ Cursor Feed Log  │   │
│   └───────────────────┘     └───────────────────┘    └──────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. What Artix Is

Artix bridges the gap between early product requirements, architectural system blueprints, and AI-assisted implementation. Rather than treating documentation as static text files disconnected from code, Artix provides an interactive workstation where:

- Architecture diagrams, database schemas, and API contracts live in unified project containers.
- All modifications are committed immediately to client-side storage with zero network latency.
- Background synchronization guarantees convergence across multiple browser tabs and remote devices using a protocol-level correct, idempotent replication model.
- Technical context can be compiled and fed into frontier AI coding agents (Cursor, Claude Code, Antigravity) with precise file-by-file execution plans.

---

## 2. Core Problem Addressed

Traditional web-based engineering tools suffer from three fundamental architectural flaws:

1. **Network Fragility & Latency Blocks**: Standard SaaS apps block UI inputs on remote API roundtrips. Network fluctuations lead to lost drafts, unresponsiveness, and corrupted states.
2. **Siloed Technical Artifacts**: Product specs live in Notion, architecture diagrams live in Figma, and prompts live in chat histories—leaving AI coders with fragmented, stale context.
3. **Naive Synchronization**: Most web apps rely on last-write-wins (LWW) or uncontrolled REST updates, silently overwriting concurrent edits made across different browser tabs or offline devices.

Artix solves these problems by establishing **local storage authority**, utilizing a **durable transactional outbox**, enforcing **optimistic Compare-and-Swap (CAS) versioning**, and compiling unified project specifications for AI workflows.

---

## 3. Project & Workspace Model

Artix organizes work into self-contained **Projects** comprising hierarchical resources:

```text
Project (UUID)
├── Workspace Folders (Hierarchical DAG, Nested Parent/Child)
├── Documents (Markdown, XML, Plain Text specifications)
└── System Designs (React Flow interactive node graph canvases)
```

### Workspace Navigation & Tab Subsystem
- **Multi-Tab Workspace Shell**: Users can open multiple documents and system designs simultaneously in a persistent tab bar (`src/components/ProjectWorkspace/WorkspaceTabBar.tsx`).
- **URL Synchronization**: Active tab state reflects in search parameters (`?doc=<id>` or `?design=<id>`) without forcing re-renders of background tabs.
- **Dirty State Tracking**: Each open tab maintains an independent unsaved/dirty indicator, preventing accidental tab closure via `CloseTabConfirmDialog`.
- **Keyboard Navigation**: Native shortcuts for productivity (`Ctrl+W` close tab, `Ctrl+Tab` cycle tabs, `Ctrl+S` force flush).

---

## 4. Current Capabilities

| Subsystem | Status | Description |
|---|---|---|
| **Document Forge** | `IMPLEMENTED` | Monaco-powered editor with syntax highlighting, Markdown preview toggle, XSS sanitization (DOMPurify), and multi-format export (PDF/HTML/MD). |
| **System Architect** | `IMPLEMENTED` | Drag-and-drop architectural canvas powered by React Flow with custom microservice, gateway, database, queue, and cache nodes. |
| **Local-First Engine** | `IMPLEMENTED` | User-scoped Dexie IndexedDB (`ArtixDB_v2_<hash>`) with atomic 3-table transaction writes and zero-latency local reads. |
| **Distributed Outbox** | `IMPLEMENTED` | Transactional mutation queue with monotonic version tracking, DAG topological dependency ordering, and restore algebra. |
| **Server CAS Concurrency**| `IMPLEMENTED` | Optimistic concurrency control via PostgreSQL version check triggers and `processed_mutations` idempotency ledger. |
| **Durable Change Feed** | `IMPLEMENTED` | Cursor-based change log (`public.sync_changes`) with leading-edge Realtime wakeup and automatic reconnection catchup. |
| **Multi-Tab Coordinator** | `IMPLEMENTED` | Web Locks API single-leader execution with instant zero-latency failover and cross-tab duplicate suppression. |
| **AI Intelligence Suite** | `IMPLEMENTED` | Multi-mode PRD generator (Agile, Technical Spec, Lean MVP, Custom) and Vibe Coding prompt compiler with 2-pass refinement. |
| **BYOK Security** | `IMPLEMENTED` | Client-side encrypted API key storage (PBKDF2 100k iterations + AES-GCM 256-bit) supporting OpenAI, Anthropic, Gemini, Groq, and Ollama. |
| **Stripe Billing & Limits**| `IMPLEMENTED` | Supabase Edge Functions with webhook signature verification, portal management, and PostgreSQL trigger tier limit enforcement. |
| **PWA & Offline Worker** | `IMPLEMENTED` | Workbox service worker precaching full application bundles and static assets for zero-network launches. |

---

## 5. Architecture Overview

Artix follows a strict **unidirectional data flow** where the UI interacts exclusively with local repositories. Cloud synchronization operates completely out-of-band:

```text
┌────────────────────────────────────────────────────────┐
│                   React UI Components                  │
│          (Editor, Canvas, Sidebar, AI Panels)          │
└───────────────────────────┬────────────────────────────┘
                            │ Read / Write
                            ▼
┌────────────────────────────────────────────────────────┐
│             Local Repositories & Contexts              │
│ (DocumentRepository, SystemDesignRepo, FolderRepo, etc)│
└───────────────────────────┬────────────────────────────┘
                            │ Atomic Dexie Transaction
                            ▼
┌────────────────────────────────────────────────────────┐
│                 Client IndexedDB Layer                 │
│         [entities]  [outbox]  [sync_metadata]          │
└───────────────▲──────────────────────────┬─────────────┘
                │                          │
        Pull    │                          │ Push
     (Reconcile)│                          │ (Drain)
                │                          ▼
┌───────────────┴──────────┐    ┌────────────────────────┐
│        PullEngine        │    │       SyncEngine       │
│  (Cursor-based sync_log) │    │ (Leader Worker & CAS)  │
└───────────────▲──────────┘    └──────────┬─────────────┘
                │                          │
                └───────────┬──────────────┘
                            │ REST / Postgres Triggers
                            ▼
┌────────────────────────────────────────────────────────┐
│                  Supabase Cloud Engine                 │
│   PostgreSQL | sync_changes | processed_mutations      │
└────────────────────────────────────────────────────────┘
```

---

## 6. Technology Stack

- **Core Framework**: React 18 with TypeScript (Strict mode enabled, zero `any` assertions in critical pathways)
- **Bundler & PWA**: Vite 5 with `vite-plugin-pwa` (Workbox caching)
- **Local Database**: Dexie.js v4 (IndexedDB abstraction with compound indices and live queries)
- **Styling & UI**: Tailwind CSS, Shadcn UI, Radix Primitives, Lucide Icons, Framer Motion
- **Editor Engine**: Monaco Editor (`@monaco-editor/react`)
- **Canvas Engine**: React Flow (`@xyflow/react`)
- **Cloud Backend**: Supabase (PostgreSQL 15, Row Level Security, Edge Functions in Deno)
- **Testing**: Vitest, `@testing-library/react`, `fake-indexeddb`

---

## 7. Local-First Architecture

All write operations (create, update, delete) in Artix are executed locally first:

```typescript
// Example: User modifies a technical document
await db.transaction('rw', [db.documents, db.outbox, db.sync_metadata], async () => {
  // 1. Update entity state with incremented localRevision
  await db.documents.update(docId, {
    title: newTitle,
    localRevision: currentRevision + 1,
    updatedAt: new Date().toISOString()
  });

  // 2. Enqueue or compact durable mutation in outbox
  await outboxRepo.enqueue({
    mutationId: crypto.randomUUID(),
    entityType: 'document',
    entityId: docId,
    operation: 'update',
    payload: { title: newTitle },
    baseServerVersion: metadata.serverVersion,
    localRevision: currentRevision + 1
  });

  // 3. Mark sync metadata as pending
  await syncMetadataRepo.markPending(docId, 'document', currentRevision + 1);
});
```

**Guarantees**:
- **0ms Mutation Latency**: Local writes succeed in memory/disk without waiting for server response.
- **Offline Durability**: Edits survive browser closures, machine reboots, and prolonged offline sessions (Scenario A verified).
- **Pure Local Reads**: UI hooks (`useDocuments`, `useSystemDesigns`, `useWorkspaceFolders`) query IndexedDB directly; no remote network calls occur on render paths.

---

## 8. Synchronization Model

Synchronization operates through two symmetric engines orchestrated by `UserSyncRuntime`:

```text
Client A (Local DB) ──[SyncEngine Push]──► Supabase CAS ──► PostgreSQL
                                                               │
                                                       (Trigger appends)
                                                               ▼
Client B (Local DB) ◄──[PullEngine Cursor]──────────────── sync_changes
```

- **Push Pipeline (`SyncEngine`)**: Drains the local outbox by sending mutations to Supabase via entity push adapters.
- **Pull Pipeline (`PullEngine`)**: Periodically and reactively pulls remote changes from `public.sync_changes` using a monotonically increasing sequence cursor.
- **Symmetric Safety**: Pull downloads never overwrite unpushed local work; pushes never overwrite unacknowledged remote changes.

---

## 9. Outbox & Dependency Ordering

The outbox manages in-flight cloud mutations using strict lifecycle states:

```text
    ┌──────────┐
    │ PENDING  │◄───────────────────────┐ (Temporary Network Error)
    └────┬─────┘                        │
         │ (Acquire Lease)              │
         ▼                              │
   ┌───────────┐                        │
   │ IN_FLIGHT ├────────────────────────┘
   └─────┬─────┘
         │
         ├─── (CAS Mismatch / Conflict) ───► [ BLOCKED ] (3-Way Conflict Saved)
         │
         └─── (200 OK / Verified) ─────────► [ DRAINED ] (Deleted from Outbox)
```

### Topological Dependency Ordering
Entities are pushed in topological DAG dependency order (`src/lib/sync/dependencyOrder.ts`):
1. Parent workspace folders are created on the server before child folders.
2. Parent folders are created before the documents or designs contained within them.
3. Documents and designs are deleted before their parent folders are deleted.

### Outbox Compaction Algebra
When a user performs rapid offline mutations on the same entity, the outbox compacts redundant operations:
- `CREATE + UPDATE -> CREATE` (with merged payload)
- `UPDATE + UPDATE -> UPDATE` (with merged payload, preserving original `baseServerVersion`)
- `CREATE + DELETE -> NOOP` (purged from outbox)
- `UPDATE + DELETE -> DELETE` (preserves baseline version for server CAS)
- `DELETE + CREATE -> UPDATE` (Restore case)

---

## 10. CAS & Concurrency Semantics

To eliminate silent Lost Updates, Artix implements server-enforced **Compare-and-Swap (CAS)** concurrency:

1. Every document, system design, and folder maintains an integer `version` in PostgreSQL.
2. PostgreSQL triggers automatically increment `version` and update `updated_at` on every update:
   ```sql
   NEW.version = OLD.version + 1;
   NEW.updated_at = now();
   ```
3. Push adapters execute updates with an optimistic CAS predicate:
   ```typescript
   const { data, error } = await supabase
     .from('documents')
     .update({ ...payload, version: baseVersion + 1 })
     .eq('id', entityId)
     .eq('version', baseVersion) // CAS Guard
     .select('id, version, updated_at')
     .maybeSingle();
   ```
4. If another device modified the row in the interim, the query returns zero rows. The adapter detects the mismatch and raises an HTTP `409 CONFLICT`, halting the outbox entry from retrying and initiating three-way merge resolution.

---

## 11. Pull & Change-Feed Model

Remote synchronization does not poll full entity tables. Instead, it streams from an append-only change feed:

1. A PostgreSQL trigger `record_sync_change()` captures all `INSERT`, `UPDATE`, and `DELETE` operations across documents, designs, and folders into `public.sync_changes`.
2. Each client stores a durable `last_synced_sequence` cursor in `sync_metadata`.
3. `PullEngine` queries new rows where `sequence > last_synced_sequence` filtered by `user_id`.
4. **Pending-State Guard**: Before applying a remote update to a local entity, `PullEngine` inspects the outbox:
   - If an active outbox entry exists with local uncommitted edits, the remote update is rejected from immediate overwrite, recorded as a 3-way conflict, and marked `conflict`.
5. The local cursor advances in IndexedDB only *after* all changes in the batch are safely committed.

---

## 12. Conflict Handling

When concurrent edits occur on the same entity across different clients:

1. The push adapter raises a `409 CONFLICT`.
2. The `SyncEngine` marks the outbox entry as `blocked` to stop automated retry floods.
3. The entity's sync status in `sync_metadata` is updated to `conflict`.
4. A structured 3-way conflict record is stored in `ConflictRepository`:
   ```typescript
   interface ConflictRecord {
     id: string;
     entityType: 'document' | 'system_design' | 'workspace_folder';
     entityId: string;
     baseContent: string;   // Common ancestor snapshot
     localContent: string;  // User's offline draft
     remoteContent: string; // Server's conflicting snapshot
     detectedAt: string;
   }
   ```
5. For technical markdown documents, Artix provides automatic 3-way line diffing (`diff3`), auto-merging non-overlapping changes and flagging overlapping blocks with standard Git conflict markers (`<<<<<<< LOCAL`, `=======`, `>>>>>>> REMOTE`).

---

## 13. Multi-Tab Coordination

Users frequently open multiple tabs of the same workspace. Artix enforces **Single-Leader Coordination** via `TabCoordinator` (`src/lib/sync/tabCoordinator.ts`):

- **Web Locks API Election**: All tabs request an exclusive lock (`navigator.locks.request('artix_sync_leader_lock_<hash>')`). The browser kernel grants leadership to exactly one tab.
- **Standby Tabs**: Standby tabs read and write locally to IndexedDB without restrictions. When a mutation occurs, they notify the leader over `BroadcastChannel` with `REQUEST_SYNC`.
- **Zero-Latency Failover**: If the leader tab is closed or crashes mid-push, the browser instantly releases the Web Lock to the next standby tab, which claims the leadership role, reclaims expired leases, and drains the outbox without latency.
- **Broadcast Deduplication**: Cross-tab change broadcasts are filtered through a 3000ms signature cache to prevent infinite notification loops.

---

## 14. User Runtime Lifecycle

The synchronization subsystem is strictly bound to user authentication sessions via `UserSyncRuntime` (`src/lib/sync/userSyncRuntime.ts`):

```text
User Sign-In ──► Open User DB (ArtixDB_v2_<hash>) ──► Recover Crashed Leases ──► Start Runtime
                                                                                       │
User Sign-Out ◄── Close User DB ◄── Abort In-Flight Sync ◄── Stop Realtime ◄───────────┘
```

- **User Isolation**: Each user account receives a completely isolated database namespace (`ArtixDB_v2_<hash>`).
- **Account Switch Safety**: Switching from User A to User B immediately terminates A's runtime, tears down Realtime subscriptions, closes database handles, and initializes B's workspace from scratch with zero memory or disk leaks (Scenario H verified).
- **React Context Binding**: `UserSyncRuntimeProvider` wraps the React component tree, exposing typed runtime status (`initializing | running | migrating | blocked | quota_exceeded | degraded | stopped`).

---

## 15. Role of Realtime

Supabase Realtime WebSocket channels are utilized exclusively as a **latency optimization and wakeup signal**:

- When a remote change is broadcast, `RealtimeSyncManager` debounces bursts (150ms) and invokes `PullEngine`.
- **Realtime is NOT a correctness boundary**: If the WebSocket connection drops, encounters timeouts (`CHANNEL_ERROR`), or is blocked by network proxies, the system remains 100% correct.
- Upon reconnection, `RealtimeSyncManager` triggers a cursor-based catch-up pull, fetching all missed changes from `public.sync_changes`.

---

## 16. Data Model

### IndexedDB Local Schema (`ArtixDB`)
```typescript
documents:         'id, [userId+projectId], userId, projectId, folderId, localRevision, updatedAt, isDeleted'
system_designs:    'id, [userId+projectId], userId, projectId, folderId, localRevision, updatedAt, isDeleted'
workspace_folders: 'id, [userId+projectId], userId, projectId, parentFolderId, name, localRevision, updatedAt, isDeleted'
outbox:            'id, [userId+entityType+entityId], userId, state, createdAt, localRevision'
sync_metadata:     'id, [userId+entityType], userId, entityId, syncState, localRevision, lastSyncedAt'
conflicts:         'id, [userId+entityType+entityId], detectedAt'
database_meta:     'key, updatedAt'
```

### PostgreSQL Cloud Schema (Supabase)
```sql
-- Core Entity Tables
public.documents         (id UUID PRIMARY KEY, user_id UUID, project_id UUID, folder_id UUID, title TEXT, content TEXT, version INT DEFAULT 1, deleted_at TIMESTAMPTZ)
public.system_designs    (id UUID PRIMARY KEY, user_id UUID, project_id UUID, folder_id UUID, name TEXT, board_state JSONB, version INT DEFAULT 1, deleted_at TIMESTAMPTZ)
public.workspace_folders (id UUID PRIMARY KEY, user_id UUID, project_id UUID, parent_folder_id UUID, name TEXT, version INT DEFAULT 1, deleted_at TIMESTAMPTZ)

-- Replication & Idempotency Logs
public.sync_changes        (sequence BIGINT IDENTITY PRIMARY KEY, user_id UUID, entity_type TEXT, entity_id TEXT, operation TEXT, entity_version BIGINT, payload JSONB, changed_at TIMESTAMPTZ)
public.processed_mutations (mutation_id UUID PRIMARY KEY, user_id UUID, entity_type TEXT, entity_id UUID, version BIGINT, updated_at TIMESTAMPTZ, processed_at TIMESTAMPTZ)
```

---

## 17. AI Subsystem Architecture

Artix includes a multi-provider prompt generation and context compiler engine:

- **Provider Abstraction (`src/lib/ai/`)**: Supports OpenAI (GPT-4o), Anthropic (Claude 3.5 Sonnet), Google Gemini (Gemini 1.5 Pro/Flash), Groq, OpenRouter, and local Ollama endpoints.
- **Streaming Pipeline (`streaming.ts`)**: Server-Sent Events (SSE) reader parsing chunked delta responses with connection timeout guards.
- **2-Pass Reflection Engine (`refine.ts`)**: Prompts pass through an automatic critique pass that removes hand-waving filler words ("ensure scalability", "TBD") and expands edge cases, concrete database schemas, and explicit file paths.
- **Prompt Compilers**: Specialized generators for Sprint PRDs (`PRDGenerator.tsx`), Vibe Coding Prompts (`VibeCoding.tsx`), and Agentic Workflows (`AgenticWorkflow.tsx`).

---

## 18. Editor & Canvas Subsystems

- **Document Forge (`src/components/Editor/`)**:
  - Monaco Editor integration with language auto-detection (Markdown, TypeScript, JSON, SQL, XML, YAML).
  - Synchronized Markdown preview with split-pane slider and persistent user layout preferences.
  - Tab close confirmation dialog preventing data loss if changes are pending.
- **System Architect (`src/components/SystemArchitect/`)**:
  - Node graph canvas built on React Flow.
  - Custom SVG node renderers for cloud infrastructure (API Gateways, Microservices, Relational DBs, Caches, Event Buses).
  - Orthogonal and Bezier edge routing with label annotations.
  - High-resolution export to PNG, SVG, and portable JSON.

---

## 19. Security Model

1. **Row Level Security (RLS)**: Every PostgreSQL table in Supabase enforces RLS policies. Client queries can only select, insert, update, or delete rows where `auth.uid() = user_id`.
2. **BYOK Client Encryption**: Third-party AI API keys entered by the user are stored in the browser. When encryption is enabled, keys are encrypted using PBKDF2 (100,000 iterations, SHA-256) and AES-GCM 256-bit with a user-provided passphrase (`src/lib/ai/crypto.ts`).
3. **HTML Sanitization**: All rendered Markdown output is sanitized using DOMPurify with strict protocol whitelists (`http`, `https`, `mailto`), blocking script execution and CSS injection attacks (`src/test/components/MarkdownPreviewXSS.test.tsx`).
4. **Content Security Policy (CSP)**: HTTP headers restrict script, style, and iframe sources to trusted origins.

---

## 20. Billing, Auth & PWA

- **Authentication**: Managed via Supabase Auth with PKCE flow, supporting email/password and Google OAuth.
- **Stripe Billing**:
  - Tier subscriptions (`free`, `pro`) managed via Supabase Edge Functions (`create-checkout-session`, `create-portal-session`, `stripe-webhook`).
  - Webhook signatures are verified cryptographically using Stripe SDK before processing events.
  - Database triggers enforce resource limits based on subscription tier (`enforce_tier_limits_trigger.sql`).
- **Progressive Web App**: Configured via Vite PWA, precaching offline application assets with automated service worker updates.

---

## 21. Testing Strategy

The repository maintains strict verification standards with an automated test suite spanning **81 test files and 566 tests**:

```text
Unit & Subsystem Tests (71 Files)
├── Local Repositories & Dexie Storage
├── Workspace Tabs & Navigation Shell
├── Push Adapters & Error Taxonomy
├── Monaco Editor & Markdown XSS Sanitization
└── AI Streaming & Crypto Storage

Distributed Protocol & Correctness Tests (10 Files)
├── casBaselinePropagation.test.ts
├── concurrencyCAS.test.ts
├── conflictResolver.test.ts
├── idempotentMutation.test.ts
├── leaderWorkerCorrectness.test.ts
├── leaseRecovery.test.ts
├── multiTabRuntime.test.ts
├── outboxMutationAlgebra.test.ts
├── pullEngine.test.ts
└── correctnessMatrix.test.ts (Scenarios A through J)
```

### Distributed Failure Matrix (`correctnessMatrix.test.ts`)
- **Scenario A**: Local durability (offline create -> edit -> reload/restart)
- **Scenario B**: Ambiguous remote result (lost response -> idempotent retry)
- **Scenario C**: Concurrent edits (version mismatch -> 409 CAS conflict -> outbox blocked)
- **Scenario D**: Local edit during push (revision safety -> ack $N$ preserves $N+1$)
- **Scenario E**: Remote stale snapshot (stale server change rejected -> local pending preserved)
- **Scenario F**: Remote delete (offline client reconnects -> soft-delete confirmed)
- **Scenario G**: Leader crash mid-push (immediate orphaned lease recovery to standby)
- **Scenario H**: Account switch (User A stopped -> User B started -> zero data leakage)
- **Scenario I**: Realtime failure (cursor-based pull converges without realtime)
- **Scenario J**: Duplicate event deduplication (cursor filter prevents repeated mutations)

---

## 22. Repository Structure

```text
c:\Fenix-main\
├── docs/                      # Canonical Technical Documentation System
│   ├── architecture/          # System architecture, data models, lifecycle
│   ├── algorithms/            # Sync, outbox, CAS, pull, push, conflict algorithms
│   ├── subsystems/            # Editor, canvas, AI, auth, billing, PWA guides
│   ├── security/              # Security model, RLS policies, client key encryption
│   ├── engineering/           # Development guidelines, testing, migrations
│   ├── decisions/             # Architectural Decision Records (ADRs 001–007)
│   ├── reference/             # API reference, DB schema, network inventory, registry
│   └── archive/               # Historical plans and superseded design notes
├── prd/                       # Product Requirements & Specifications
│   ├── ARTIX_PRODUCT_REQUIREMENTS_DOCUMENT.md
│   ├── TECHNICAL_SPECIFICATIONS.md
│   └── VIBE_CODING_PLAYBOOK.md
├── src/
│   ├── components/            # React UI components (Editor, Canvas, Tabs, Dialogs)
│   ├── contexts/              # UserSyncRuntimeContext and provider
│   ├── hooks/                 # React hooks (useDocuments, useWorkspaceTabs, etc.)
│   ├── lib/
│   │   ├── ai/                # AI providers, crypto, streaming, prompt generation
│   │   ├── local/             # Dexie database, entity types, user scoping
│   │   ├── repositories/      # Local repository abstraction (atomic mutations)
│   │   ├── sync/              # SyncEngine, PullEngine, TabCoordinator, Adapters
│   │   └── workspace/         # Tab persistence, resource adapters, DAG grouping
│   ├── pages/                 # Route pages (ProjectWorkspace, Dashboard, Pricing)
│   └── test/                  # 81 Vitest test suites (566 tests)
└── supabase/
    ├── functions/             # Stripe Edge Functions (Deno)
    └── migrations/            # Versioned SQL migrations (CAS, Change Feed, Ledger)
```

---

## 23. Current Implementation Status

| Capability / Module | Implementation Status | Verification Notes |
|---|---|---|
| IndexedDB Authority | `IMPLEMENTED` | User-scoped Dexie instances with atomic transactions. |
| CAS Concurrency | `IMPLEMENTED` | Optimistic PostgreSQL version predicates & triggers. |
| Durable Outbox | `IMPLEMENTED` | Topological DAG ordering, compaction algebra, crash recovery. |
| Pull Change Feed | `IMPLEMENTED` | Sequence cursors querying `public.sync_changes`. |
| Single-Leader Tabs | `IMPLEMENTED` | Native Web Locks API leader election. |
| Realtime Wakeup | `IMPLEMENTED` | Supabase Realtime channel with 150ms debouncing. |
| Tombstone Lifecycle | `IMPLEMENTED` | Soft-delete state machine with 30-day garbage collection. |
| AI Prompt Engine | `IMPLEMENTED` | Multi-mode PRD generator and Vibe prompt compiler. |
| Multi-Tab Editor | `IMPLEMENTED` | Persistent workspace tabs with dirty state detection. |
| GitHub Sync | `PLANNED` | Bi-directional git commit export and PR creation. |
| Excalidraw Engine | `PLANNED` | Hybrid integration with React Flow canvas. |
| Collaborative CRDTs | `PROPOSED` | Fine-grained character-level Yjs collaborative editing. |

---

## 24. Planned & Future Architecture

1. **Bi-Directional GitHub Repository Sync (`PLANNED`)**: Export technical specifications and visual architecture directly into target Git repositories as structured Markdown and Mermaid diagrams via GitHub App integration.
2. **Vector-Search Project Knowledge (`PLANNED`)**: Embed project documents using client-side WebAssembly embeddings (Transformers.js) or pgvector to provide semantic search across technical specifications.
3. **Hybrid Canvas Engine (`PLANNED`)**: Complement structured node-graphs with freeform Excalidraw hand-drawn wireframes and component sketch overlays.

---

## 25. Documentation Map

The canonical documentation is organized into focused, authoritative guides under [`docs/`](./docs/README.md):

- **Architecture**:
  - [System Architecture & Runtime Overview](./docs/architecture/SYSTEM.md)
  - [Data Model & State Machines](./docs/architecture/DATA_MODEL.md)
  - [Application & Session Lifecycle](./docs/architecture/APPLICATION_LIFECYCLE.md)
  - [Code Organization & Module Boundaries](./docs/architecture/CODE_ORGANIZATION.md)
- **Algorithms & Synchronization**:
  - [Local-First Write Pipeline](./docs/algorithms/LOCAL_FIRST_SYNC.md)
  - [Outbox Lifecycle & Compaction Algebra](./docs/algorithms/OUTBOX.md)
  - [Pull Engine & Durable Change Feed](./docs/algorithms/PULL_ENGINE.md)
  - [Push Engine & CAS Concurrency Protocol](./docs/algorithms/PUSH_ENGINE.md)
  - [Conflict Resolution & 3-Way Diff3 Merge](./docs/algorithms/CONFLICT_RESOLUTION.md)
  - [Multi-Tab Web Locks Coordination](./docs/algorithms/MULTI_TAB_COORDINATION.md)
  - [Tombstone Lifecycle & Safe Purging](./docs/algorithms/TOMBSTONES.md)
- **Subsystems**:
  - [Workspace & Multi-Tab Editor Subsystem](./docs/subsystems/WORKSPACE_AND_EDITOR.md)
  - [System Architect Canvas Subsystem](./docs/subsystems/SYSTEM_DESIGN.md)
  - [AI Prompt Engineering Pipeline](./docs/subsystems/AI_PIPELINE.md)
  - [Authentication & Storage Boundaries](./docs/subsystems/AUTHENTICATION_AND_SECURITY.md)
  - [Stripe Billing & Tier Enforcement](./docs/subsystems/BILLING_AND_LIMITS.md)
  - [PWA & Offline Service Worker](./docs/subsystems/PWA_AND_OFFLINE.md)
- **Engineering & Operations**:
  - [Development Workflow & Standards](./docs/engineering/DEVELOPMENT.md)
  - [Testing Architecture & Simulation Suite](./docs/engineering/TESTING.md)
  - [Database Migrations & Schema Evolution](./docs/engineering/MIGRATIONS.md)
  - [Observability & Error Taxonomy](./docs/engineering/OBSERVABILITY.md)
- **Architectural Decision Records (ADRs)**:
  - [ADR-001: Local-First Authority over Cloud Storage](./docs/decisions/ADR-001-local-first-authority.md)
  - [ADR-002: User-Scoped IndexedDB Namespaces](./docs/decisions/ADR-002-user-scoped-storage.md)
  - [ADR-003: Single Unidirectional Write Pipeline](./docs/decisions/ADR-003-single-write-pipeline.md)
  - [ADR-004: Optimistic Compare-and-Swap Concurrency](./docs/decisions/ADR-004-server-cas-concurrency.md)
  - [ADR-005: Durable Append-Only Change Feed & Cursor](./docs/decisions/ADR-005-durable-change-feed-cursor.md)
  - [ADR-006: Web Locks API for Multi-Tab Leadership](./docs/decisions/ADR-006-web-locks-multi-tab-coordination.md)
  - [ADR-007: Realtime as Latency Accelerator, Not Correctness Source](./docs/decisions/ADR-007-realtime-as-wakeup-accelerator.md)

---

## Quickstart & Development

### Prerequisites
- Node.js >= 18.0.0
- npm >= 9.0.0

### Installation & Run
```bash
# Clone the repository
git clone https://github.com/Yousef-eng679/Artix.git
cd Artix

# Install dependencies
npm install

# Start local development server
npm run dev

# Run comprehensive test suite (81 test files, 566 tests)
npm test

# Build production bundle
npm run build
```

---

*Artix is developed under an engineering-first, local-first design philosophy. For architectural questions or contribution guidelines, consult the [Canonical Documentation Hub](./docs/README.md).*
