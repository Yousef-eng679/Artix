# Artix — Local-First Engineering Workspace & Specification Engine

> **Engineering Status**: v2.5.0 — Productionized Billing, Strict CAS & True Offline-First Architecture  
> **Verification**: 107 Vitest Files (698/698 Tests) | Real PostgreSQL 17 Concurrency & RLS Suite (6/6) | Playwright Production PWA E2E (18 Chromium specs) | TypeScript 0 Errors | ESLint 0 Errors

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
│   │ Projects/Folders/ │     │ Mutations / Leases│    │ Revisions/Status │   │
│   │ Documents/Designs │     │ Causal Barrier    │    │ Cursor/Hydration │   │
│   └───────────────────┘     └───────────────────┘    └──────────────────┘   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Asynchronous Push / Pull
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      CLOUD REPLICATION ENGINE (Supabase)                    │
│                                                                             │
│   ┌───────────────────┐     ┌───────────────────┐    ┌──────────────────┐   │
│   │ PostgreSQL Tables │     │ apply_sync_mutation│   │  `sync_changes`  │   │
│   │ 4 Synced Entities │     │ Atomic CAS RPC    │    │ Cursor Feed Log  │   │
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
| **Document Forge** | `IMPLEMENTED` | Locally bundled Monaco (`monaco-editor` 0.57 + local worker, zero CDN) with Markdown preview toggle, AST-escaped Markdown + strict URI protocol filtering, stale-buffer overwrite protection (`StaleBufferError`), and multi-format export (native free; PDF/HTML Pro). |
| **System Architect** | `IMPLEMENTED` | React Flow canvas with System and Algorithm node catalogs, persisted inline labels and custom colors, `crypto.randomUUID()` node IDs, dagre auto-layout, freehand strokes, and stale-buffer protection. |
| **Local-First Engine** | `IMPLEMENTED` | User-scoped Dexie IndexedDB (`ArtixDB_v2_<hash>`, schema v3, 8 tables including `projects`) with atomic multi-table transactions and zero-latency local reads, readable offline even with an expired JWT. |
| **Distributed Outbox** | `IMPLEMENTED` | Transactional mutation queue across 4 synced entities with immutable `dispatched` flag, `leaseToken` fencing (30s TTL), per-entity causal barrier, DAG topological ordering, and 7-case compaction algebra. |
| **Server CAS Concurrency**| `IMPLEMENTED` | Single-transaction `public.apply_sync_mutation` RPC: advisory lock + `processed_mutations` idempotency + strict `version = p_base_version` CAS + `sync_changes` with `mutation_id`. |
| **Durable Change Feed** | `IMPLEMENTED` | Commit-ordered `public.sync_changes` with self-echo recognition, cold `bootstrapHydrateAll()`, and `resnapshotAll()` when the cursor falls below the `sync_retention_state` retention floor. |
| **Multi-Tab Coordinator** | `IMPLEMENTED` | Web Locks API single-leader execution with instant failover, post-commit cross-tab notifications carrying real `localRevision`, and per-user coordinator eviction. |
| **AI Intelligence Suite** | `IMPLEMENTED` | Multi-mode PRD generator, Vibe Coding prompt compiler, Agentic Workflow and Architecture generators with streaming 2-pass refinement and primary/backup provider failover. |
| **BYOK Security** | `IMPLEMENTED` | Client-side BYOK storage (default `obf:` Base64 obfuscation + opt-in PBKDF2 600k iterations `v: 2` / AES-GCM 256-bit passphrase vault with `v: 1` 250k backward compatibility) supporting OpenAI, Anthropic, Gemini, Groq, OpenRouter, and Ollama. |
| **Stripe Billing & Limits**| `IMPLEMENTED` | Atomic `reconcile_stripe_subscription` RPC, strict `past_due` → `free` fail-closed policy, RLS-protected `manual_grants`, serialized `check_plan_tier_limit()` (incl. monthly AI cap), and offline entitlement/quota caching. |
| **PWA & Offline Worker** | `IMPLEMENTED` | Workbox precache with `clientsClaim` + `skipWaiting`, self-hosted `@fontsource` fonts, `navigator.storage.persist()`, and offline cold start with an expired JWT. |

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
│ (ProjectRepo, DocumentRepo, SystemDesignRepo, FolderRepo)│
└───────────────────────────┬────────────────────────────┘
                            │ Atomic Dexie Transaction
                            ▼
┌────────────────────────────────────────────────────────┐
│                 Client IndexedDB Layer                 │
│ [entities] [outbox] [sync_metadata] [conflicts] [meta] │
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
                            │ apply_sync_mutation RPC / sync_changes
                            ▼
┌────────────────────────────────────────────────────────┐
│                  Supabase Cloud Engine                 │
│ PostgreSQL 17 | sync_changes | processed_mutations     │
└────────────────────────────────────────────────────────┘
```

---

## 6. Technology Stack

- **Core Framework**: React 18 with TypeScript (Strict mode enabled, zero `any` assertions in critical pathways)
- **Bundler & PWA**: Vite 5.4 with `vite-plugin-pwa` 1.2 (Workbox `clientsClaim` + `skipWaiting`, 5 MiB precache limit)
- **Local Database**: Dexie.js v4.4 (`ArtixDB` schema v3, 8 tables, compound indices and live queries)
- **Styling & UI**: Tailwind CSS, Shadcn UI, Radix Primitives, Lucide Icons, Framer Motion, self-hosted `@fontsource/inter` + `@fontsource/jetbrains-mono`
- **Editor Engine**: `monaco-editor` 0.57 + `@monaco-editor/react` 4.7 (locally bundled worker, zero CDN)
- **Canvas Engine**: React Flow (`@xyflow/react`) + `@dagrejs/dagre` auto-layout
- **Cloud Backend**: Supabase (PostgreSQL 17, Row Level Security, Edge Functions in Deno)
- **Testing**: Vitest, `@testing-library/react`, `fake-indexeddb`, `pg` + `@electric-sql/pglite` (real PostgreSQL suite), `@playwright/test` 1.64

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
- **Pure Local Reads**: UI hooks (`useDocuments`, `useSystemDesigns`, `useWorkspaceFolders`) query IndexedDB directly; `useProjects` reads the local `ProjectRepository` once hydrated (online pre-hydration fallback only). No remote network calls occur on render paths for synced entities.

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
         ├─── (Tier Limit / Validation / Retries Exhausted) ─► [ BLOCKED ] (Retry via SyncStatusBanner)
         │
         └─── (200 OK / Verified) ─────────► [ DRAINED ] (Deleted from Outbox)
```

Once an entry is claimed it is stamped `dispatched: true` with a fresh `leaseToken`; dispatched entries are never compacted or mutated again, and push acknowledgements/failures are fenced by that token.

### Topological Dependency Ordering
Entities are pushed in topological DAG dependency order (`src/lib/sync/dependencyOrder.ts`, Kahn's algorithm with FIFO tie-breaking):
1. Projects are created on the server before any of their folders, documents, or designs.
2. Parent workspace folders are created before child folders, and folders before the documents or designs contained within them.
3. Documents and designs are deleted before their parent folders; projects are deleted last.

A per-entity **causal barrier** holds back later entries for an entity while an earlier entry is `in_flight`, `blocked`, or waiting on `nextRetryAt`.

### Outbox Compaction Algebra
When a user performs rapid offline mutations on the same entity, the outbox compacts into the latest **undispatched** `pending` entry only:
- `CREATE + UPDATE -> CREATE` (with merged payload)
- `UPDATE + UPDATE -> UPDATE` (with merged payload, preserving original `baseServerVersion`)
- `CREATE + DELETE -> NOOP` (purged from outbox)
- `UPDATE + DELETE -> DELETE` (preserves baseline version for server CAS)
- `DELETE + DELETE -> DELETE`
- `DELETE + UPDATE -> UPDATE` (Restore case)
- `DELETE + CREATE -> CREATE`

---

## 10. CAS & Concurrency Semantics

To eliminate silent Lost Updates, Artix implements server-enforced **Compare-and-Swap (CAS)** concurrency:

1. Every project, workspace folder, document, and system design maintains an integer `version` in PostgreSQL.
2. PostgreSQL triggers automatically increment `version` and update `updated_at` on every update:
   ```sql
   NEW.version = OLD.version + 1;
   NEW.updated_at = now();
   ```
3. Push adapters never write tables directly. They call a single-transaction RPC via `executeAtomicMutation()` (`src/lib/sync/adapters/idempotency.ts`):
   ```typescript
   const { data, error } = await supabase.rpc('apply_sync_mutation', {
     p_mutation_id: entry.mutationId,
     p_user_id: userId,
     p_entity_type: 'document',
     p_entity_id: entityId,
     p_operation: 'update',
     p_payload: payload,
     p_base_version: Number(entry.baseServerVersion), // required >= 1 for update/delete
   });
   ```
   Inside one PostgreSQL transaction the RPC takes an advisory lock on the mutation ID, short-circuits if `processed_mutations` already holds it, runs `UPDATE ... WHERE version = p_base_version`, records the `sync_changes` row with `mutation_id`, and writes the ledger row.
4. If another device modified the row in the interim, the RPC returns `{ status: 'conflict', reason: 'version_mismatch' | 'remote_deleted' | 'already_exists', current_row }`. The engine parks the outbox entry as `blocked` and records a 3-way conflict. Updates/deletes without a valid baseline fail closed client-side (`MissingCasBaselineError`) after a pre-push reconciler attempts to heal legacy entries.

---

## 11. Pull & Change-Feed Model

Remote synchronization does not poll full entity tables. Instead, it streams from an append-only change feed:

1. A PostgreSQL trigger `record_sync_change()` captures all `INSERT`, `UPDATE`, and `DELETE` operations across projects, folders, documents, and designs into `public.sync_changes`. A per-user advisory lock makes `sequence` order equal commit order, and the root entity of each RPC mutation carries its `mutation_id`.
2. Each client stores a durable cursor in `database_meta` under the key `server_cursor`.
3. `PullEngine.syncPull()` chooses one of three modes: `bootstrapHydrateAll()` on a never-hydrated device, `resnapshotAll()` when the cursor is below `min_retained_sequence` (from `get_sync_feed_bounds()`), or incremental `pullAll()` (batches of 50).
4. **Self-Echo & Pending-State Guards**: Changes whose `mutation_id` matches the client's own push are treated as acknowledgements and never overwrite newer local edits. If an active outbox entry exists with other local uncommitted edits, the remote update is recorded as a 3-way conflict instead of overwriting.
5. The local cursor advances in the same Dexie transaction as the batch's entity updates, and listeners are notified only after that transaction commits.

---

## 12. Conflict Handling

When concurrent edits occur on the same entity across different clients:

1. The push RPC returns a structured conflict (`version_mismatch`, `remote_deleted`, or `already_exists`).
2. The `SyncEngine` marks the outbox entry as `blocked` to stop automated retry floods.
3. The entity's sync status in `sync_metadata` is updated to `conflict`.
4. A structured 3-way conflict record is stored in `ConflictRepository`:
   ```typescript
   interface ConflictRecord {
     id: string;
     entityType: 'project' | 'document' | 'system_design' | 'workspace_folder';
     entityId: string;
     userId: string;
     basePayload: Record<string, any> | null;  // Common ancestor snapshot
     localPayload: Record<string, any>;        // User's offline draft
     remotePayload: Record<string, any> | null;// Server's conflicting snapshot
     reason?: 'version_mismatch' | 'remote_deleted' | 'already_exists' | string | null;
     remoteVersion?: string | null;
     detectedAt: number;                       // epoch ms
     resolvedAt?: number | null;
   }
   ```
5. The `ConflictResolutionCenter` UI offers **Keep mine**, **Accept remote**, **Save as copy**, and (for documents) **Merge**. Merging uses an LCS-aligned 3-way `diff3` that auto-merges non-overlapping changes and flags overlapping blocks with `<<<<<<< LOCAL`, `=======`, `>>>>>>> REMOTE`. Content with unresolved markers cannot be saved or pushed (`UnresolvedConflictMarkersError`).

---

## 13. Multi-Tab Coordination

Users frequently open multiple tabs of the same workspace. Artix enforces **Single-Leader Coordination** via `TabCoordinator` (`src/lib/sync/tabCoordinator.ts`):

- **Web Locks API Election**: All tabs request an exclusive lock (`navigator.locks.request('artix_sync_leader_lock_<hash>')`). The browser kernel grants leadership to exactly one tab.
- **Standby Tabs**: Standby tabs read and write locally to IndexedDB without restrictions. When a mutation occurs, they notify the leader over `BroadcastChannel` with `REQUEST_SYNC`.
- **Zero-Latency Failover**: If the leader tab is closed or crashes mid-push, the browser instantly releases the Web Lock to the next standby tab, which claims the leadership role, reclaims expired leases, and drains the outbox without latency.
- **Broadcast Deduplication**: Cross-tab change broadcasts are filtered through a 3000ms signature cache to prevent infinite notification loops. Changes applied by `PullEngine` are announced only after their Dexie transaction commits, carrying the real `localRevision` so open editors can detect stale buffers.

---

## 14. User Runtime Lifecycle

The synchronization subsystem is strictly bound to user authentication sessions via `UserSyncRuntime` (`src/lib/sync/userSyncRuntime.ts`):

```text
User Sign-In ──► Open User DB (ArtixDB_v2_<hash>) ──► Recover Crashed Leases ──► Start Runtime
                                                                                       │
User Sign-Out ◄── Close User DB ◄── Abort In-Flight Sync ◄── Stop Realtime ◄───────────┘
```

- **User Isolation**: Each user account receives a completely isolated database namespace (`ArtixDB_v2_<hash>`), and `localStorage` draft/tab keys are scoped by the same user hash.
- **Account Switch Safety**: Switching from User A to User B terminates A's runtime, tears down Realtime, evicts A's `SyncEngine` and `TabCoordinator`, closes database handles, clears the TanStack `QueryClient` and dirty tracker, and purges sensitive browser caches before initializing B (Scenario H verified).
- **Offline Cold Start**: Booting offline with an expired JWT restores the cached identity (`src/lib/auth/offlineSession.ts`), opens the local database, and pauses cloud sync until the session can be refreshed online.
- **React Context Binding**: `UserSyncRuntimeProvider` wraps the React component tree, exposing typed runtime state (`uninitialized | starting | running | degraded | errored | stopped`) plus `isHydrated` and `isCloudSyncPaused`.

---

## 15. Role of Realtime

Supabase Realtime WebSocket channels are utilized exclusively as a **latency optimization and wakeup signal**:

- When a remote change is broadcast, `RealtimeSyncManager` debounces bursts (50ms leading + trailing edge) and, on the leader tab only, invokes a pull.
- **Realtime is NOT a correctness boundary**: If the WebSocket connection drops, encounters timeouts (`CHANNEL_ERROR`), or is blocked by network proxies, the system remains 100% correct.
- Upon reconnection, `RealtimeSyncManager` triggers a cursor-based catch-up pull, fetching all missed changes from `public.sync_changes`.

---

## 16. Data Model

### IndexedDB Local Schema (`ArtixDB`, Dexie schema v3)
```typescript
projects:          'id, userId, updatedAt, name, localRevision, isDeleted'
documents:         'id, [userId+projectId], userId, projectId, folderId, localRevision, updatedAt, isDeleted'
system_designs:    'id, [userId+projectId], userId, projectId, folderId, localRevision, updatedAt, isDeleted'
workspace_folders: 'id, [userId+projectId], userId, projectId, parentFolderId, name, localRevision, updatedAt, isDeleted'
outbox:            'id, [userId+entityType+entityId], userId, state, createdAt, localRevision'
sync_metadata:     'id, [userId+entityType], userId, entityId, syncState, localRevision, lastSyncedAt'
conflicts:         'id, [userId+entityType+entityId], detectedAt'
database_meta:     'key, updatedAt'   // server_cursor, hydration_complete, legacy_migration, cached_subscription, cached_ai_generations
```

### PostgreSQL Cloud Schema (Supabase)
```sql
-- Core Synced Entity Tables
public.projects          (id UUID PRIMARY KEY, user_id UUID, name TEXT, version INT DEFAULT 1, deleted_at TIMESTAMPTZ)
public.documents         (id UUID PRIMARY KEY, user_id UUID, project_id UUID, folder_id UUID, title TEXT, content TEXT, version INT DEFAULT 1, deleted_at TIMESTAMPTZ)
public.system_designs    (id UUID PRIMARY KEY, user_id UUID, project_id UUID, folder_id UUID, name TEXT, board_state JSONB, version INT DEFAULT 1, deleted_at TIMESTAMPTZ)
public.workspace_folders (id UUID PRIMARY KEY, user_id UUID, project_id UUID, parent_folder_id UUID, name TEXT, version INT DEFAULT 1, deleted_at TIMESTAMPTZ)

-- Replication, Idempotency & Retention
public.sync_changes         (sequence BIGINT IDENTITY PRIMARY KEY, user_id UUID, entity_type TEXT, entity_id TEXT, operation TEXT, entity_version BIGINT, mutation_id UUID NULL, payload JSONB, changed_at TIMESTAMPTZ)
public.processed_mutations  (mutation_id UUID PRIMARY KEY, user_id UUID, entity_type TEXT, entity_id UUID, version BIGINT, updated_at TIMESTAMPTZ, processed_at TIMESTAMPTZ)
public.sync_retention_state (id SMALLINT PRIMARY KEY DEFAULT 1, min_retained_sequence BIGINT, last_pruned_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)

-- Billing & Entitlements
public.subscriptions  (..., plan_tier TEXT, status TEXT, billing_cycle TEXT, current_period_end TIMESTAMPTZ, reconciliation_version BIGINT, last_stripe_event_created BIGINT)
public.stripe_events  (id UUID, stripe_event_id TEXT UNIQUE, event_type TEXT, processed_at TIMESTAMPTZ)
public.manual_grants  (id UUID, user_id UUID UNIQUE, plan_tier TEXT, reason TEXT, granted_by TEXT, starts_at, expires_at, revoked_at TIMESTAMPTZ)
```

---

## 17. AI Subsystem Architecture

Artix includes a multi-provider prompt generation and context compiler engine:

- **Provider Abstraction (`src/lib/ai/`)**: Supports OpenAI (GPT-4o), Anthropic (Claude 3.5 Sonnet), Google Gemini (Gemini 1.5 Pro/Flash), Groq, OpenRouter, and local Ollama endpoints, with automatic failover from `settings.primary` to `settings.backup` in `src/lib/ai/registry.ts`.
- **Streaming Pipeline (`streaming.ts`)**: Server-Sent Events (SSE) reader parsing chunked delta responses.
- **2-Pass Reflection Engine (`refine.ts`)**: Prompts pass through an automatic critique pass that removes hand-waving filler words ("ensure scalability", "TBD") and expands edge cases, concrete database schemas, and explicit file paths.
- **Prompt Compilers**: Specialized generators for Sprint PRDs (`src/components/AI/PRDGeneratorDialog.tsx`), Vibe Coding Prompts (`VibeCodingDialog.tsx`), Agentic Workflows (`AgenticWorkflowDialog.tsx`), and System/Algorithm Architecture graphs (`ArchitectureGeneratorDialog.tsx`).

---

## 18. Editor & Canvas Subsystems

- **Document Forge (`src/components/Editor/`)**:
  - Locally bundled Monaco Editor (`monacoSetup.ts`, `monaco-editor` 0.57 + local worker) supporting Markdown, XML, and Plain Text formats with zero CDN dependency.
  - Synchronized Markdown preview with persistent user toggle (`artix.editor.showPreview`) and stale-buffer overwrite protection (`StaleBufferError` + banner when remote edits arrive while dirty).
  - Multi-format export (`src/lib/documentExport.ts`: native `.md`/`.xml`/`.txt` for all tiers; `.html` and `.pdf` for Pro).
- **System Architect (`src/components/SystemArchitect/`)**:
  - Node graph canvas built on React Flow (`ArchitectNode.tsx`) with System Mode (7 infrastructure templates) and Algorithm Mode (17 data-structure/algorithm templates).
  - Collision-free `crypto.randomUUID()` node/edge IDs, persisted inline labels and custom colors, freehand stroke overlay (`DrawingCanvas.tsx`), and `dagre` auto-layout.
  - Drag-aware 1000ms debounced persistence and stale-buffer overwrite protection (`StaleBufferError`).

---

## 19. Security Model

1. **Row Level Security (RLS)**: All 14 PostgreSQL tables in `public` enforce RLS policies. Client queries can only access rows where `auth.uid() = user_id` (while `stripe_events` and `sync_retention_state` writes are restricted to `service_role`, and `manual_grants` allows `authenticated` `SELECT` of own row only).
2. **BYOK Client Key Protection**: Third-party AI API keys entered by the user stay strictly client-side. By default they are stored in `localStorage` with `obf:` Base64 obfuscation (`src/lib/ai/storage.ts`); when the optional passphrase vault is enabled, keys are encrypted at rest using PBKDF2 (600,000 iterations for `v: 2`, SHA-256; legacy `v: 1` 250,000 iterations supported for decryption) and AES-GCM 256-bit (`src/lib/ai/crypto.ts`).
3. **Markdown AST Escaping & URL Protocol Filtering**: `MarkdownPreview.tsx` renders Markdown via `react-markdown` without `rehype-raw` (so raw inline HTML/scripts render as inert text) and enforces an explicit `sanitizeMarkdownUrl` protocol allowlist (`http:`, `https:`, `mailto:`, relative links), verified in `src/test/security.test.ts`.
4. **Content Security Policy (CSP)**: HTTP headers restrict script, style, and iframe sources to trusted origins.

---

## 20. Billing, Auth & PWA

- **Authentication**: Managed via Supabase Auth with PKCE flow, supporting email/password and Google OAuth, pre-signup email/MX validation (`validate-email`), and offline cold-start session continuity (`src/lib/auth/offlineSession.ts`) when a cached JWT expires offline.
- **Stripe Billing**:
  - Tier subscriptions (`free`, `pro` at \$8/mo or \$72/yr) managed via Supabase Edge Functions (`create-checkout-session`, `create-portal-session`, `stripe-webhook`) with authoritative price allowlisting (`_shared/billingPolicy.ts`).
  - `stripe-webhook` verifies `Stripe-Signature`, retrieves the live subscription from Stripe, enforces strict fail-closed `past_due -> free` (`GRACE_PERIOD_DAYS = 0`), and executes the single-transaction `public.reconcile_stripe_subscription` RPC.
  - Administrative Pro overrides are stored in RLS-protected `public.manual_grants` and evaluated via `public.user_has_active_pro_entitlement`.
  - Database triggers serialize and enforce resource limits per user (`check_plan_tier_limit()`: 3 projects / 10 documents / 3 system designs / 5 AI generations per month on Free; 100 projects and unlimited documents/designs/AI on Pro), while offline clients read cached entitlement and count local Dexie entities.
- **Progressive Web App**: Configured via Vite PWA (`clientsClaim: true`, `skipWaiting: true`, 5 MiB precache budget, self-hosted `@fontsource/inter` and `@fontsource/jetbrains-mono`, and `navigator.storage.persist()`).

---

## 21. Testing Strategy

The repository enforces a **4-layer verification pyramid** in CI (`.github/workflows/ci.yml`):

```text
Layer 1: Unit, Repository & Component Suite (Vitest + fake-indexeddb)
├── 107 Vitest Test Files (698 Passing Assertions)
├── Local Repositories, Outbox Algebra & Dexie v3 Schema
├── Workspace Tabs, Editor/Canvas Stale-Buffer Guards & XSS Sanitization
└── Architecture Network Boundary Guards (networkBoundary.test.ts)

Layer 2: Controllable Fake-Server Distributed Fault Injection (40 Sync Suites)
├── controllableFakeServerFaultInjection.test.ts
├── correctnessMatrix.test.ts (Scenarios A through J)
├── atomicPushAckAndLeaseTokenFencing.test.ts & dispatchedSelfEchoAndCausalBarrier.test.ts
├── bootstrapHydrationAndRetentionFloor.test.tsx & pullCursorCommitOrder.test.ts
└── multiDeviceConflictResolution.test.tsx & multiAccountEvictionAndStorageScope.test.tsx

Layer 3: Real PostgreSQL 17 Concurrency, CAS, Billing & RLS (`npm run test:pg`)
└── src/test/postgres/backendConcurrencyAndRls.pg.test.ts (6/6 Passing on PostgreSQL 17 & PGlite)

Layer 4: Production PWA + Workbox Service Worker Cold-Start E2E (`npm run test:e2e`)
└── tests/e2e/{auth,features,security,offlineColdStartAndSyncMatrix}.spec.ts (18 Chromium Specs)
```

### Distributed Failure Matrix (`correctnessMatrix.test.ts`)
- **Scenario A**: Local durability (offline create -> edit -> reload/restart)
- **Scenario B**: Ambiguous remote result (lost response -> idempotent `apply_sync_mutation` retry)
- **Scenario C**: Concurrent edits (version mismatch -> CAS conflict -> outbox blocked)
- **Scenario D**: Local edit during push (immutable `dispatched` flag + self-echo `mutation_id` guard preserves $N+1$)
- **Scenario E**: Remote stale snapshot (stale server change rejected -> local pending preserved)
- **Scenario F**: Remote delete (offline client reconnects -> soft-delete or `remote_deleted` conflict)
- **Scenario G**: Leader crash mid-push (immediate orphaned lease recovery + `leaseToken` fencing)
- **Scenario H**: Account switch (User A stopped -> caches/QueryClient/coordinators evicted -> User B started)
- **Scenario I**: Realtime failure (cursor-based pull converges without realtime)
- **Scenario J**: Duplicate event deduplication (cursor filter prevents repeated mutations)

---

## 22. Repository Structure

```text
Artix/
├── docs/                      # Canonical Technical Documentation System (v2.5.0)
│   ├── architecture/          # System architecture, data models, lifecycle
│   ├── algorithms/            # Sync, outbox, CAS, pull, push, conflict algorithms
│   ├── subsystems/            # Editor, canvas, AI, auth, billing, PWA guides
│   ├── security/              # Security model, RLS policies, client key encryption
│   ├── engineering/           # Development guidelines, testing, migrations
│   ├── decisions/             # Architectural Decision Records (ADRs 001–007)
│   ├── reference/             # API reference, DB schema, network inventory, registry
│   ├── audits/                # Repository audit reports and historical remediation records
│   └── archive/               # Historical plans and superseded design notes
├── prd/                       # Product Requirements & Specifications
│   ├── ARTIX_PRODUCT_REQUIREMENTS_DOCUMENT.md
│   ├── TECHNICAL_SPECIFICATIONS.md
│   └── VIBE_CODING_PLAYBOOK.md
├── src/
│   ├── components/            # React UI components (Editor, SystemArchitect, AI, ConflictModal)
│   ├── contexts/              # UserSyncRuntimeContext and provider
│   ├── hooks/                 # React hooks (useProjects, useDocuments, useWorkspaceTabs, etc.)
│   ├── lib/
│   │   ├── ai/                # AI providers, crypto (v2 600k PBKDF2), streaming, prompts
│   │   ├── auth/              # Offline expired-JWT session continuity (offlineSession.ts)
│   │   ├── cache/             # Local draft recovery, debounced save, tabCloseGuard
│   │   ├── local/             # Dexie ArtixDB v3 (8 tables), entity types, user scoping
│   │   ├── repositories/      # Project, Document, SystemDesign, Folder, Outbox, Conflict repos
│   │   ├── sync/              # SyncEngine, PullEngine, TabCoordinator, Adapters, ErrorTaxonomy
│   │   └── workspace/         # User-scoped tab persistence, resource adapters, DAG grouping
│   ├── pages/                 # Route pages (Dashboard, ProjectWorkspace, Pricing, Settings, Auth)
│   └── test/                  # 107 Vitest suites + Layer 3 PostgreSQL concurrency/RLS suite
├── supabase/
│   ├── functions/             # Deno Edge Functions (stripe-webhook, checkout, portal, validate-email)
│   └── migrations/            # 25 SQL migrations (Expand/Contract CAS, Change Feed, Billing, RLS)
└── tests/
    └── e2e/                   # 4 Playwright E2E & production PWA cold-start spec suites
```

---

## 23. Current Implementation Status

| Capability / Module | Implementation Status | Verification Notes |
|---|---|---|
| IndexedDB Authority (`ArtixDB` v3) | `IMPLEMENTED` | User-scoped 8-table Dexie instances (incl. `projects`) with atomic transactions. |
| Atomic Server CAS (`apply_sync_mutation`) | `IMPLEMENTED` | Single-transaction advisory lock, `processed_mutations`, and `version = p_base_version`. |
| Durable Outbox & Causal Barrier | `IMPLEMENTED` | Topological DAG ordering, 7-case compaction, `dispatched` flag, `leaseToken` fencing. |
| Pull Change Feed & Retention Floor | `IMPLEMENTED` | Commit-ordered `sync_changes`, `mutation_id` self-echo, `bootstrapHydrateAll`, `resnapshotAll`. |
| Single-Leader Tabs | `IMPLEMENTED` | Native Web Locks API leader election + post-commit cross-tab `localRevision` broadcasts. |
| Realtime Wakeup | `IMPLEMENTED` | Supabase Realtime channel with 50ms leading+trailing debouncing on leader tab. |
| Tombstone Lifecycle | `IMPLEMENTED` | Soft-delete state machine across 4 entity tables with 30-day garbage collection. |
| AI Prompt Engine | `IMPLEMENTED` | PRD, Vibe, Agentic, and Architecture generators with 2-pass refinement & failover. |
| Multi-Tab Editor & Stale-Buffer Guard | `IMPLEMENTED` | Locally bundled Monaco, user-scoped tab persistence, and `StaleBufferError` banners. |
| Atomic Billing & Offline Entitlements | `IMPLEMENTED` | `reconcile_stripe_subscription` RPC, strict `past_due -> free`, `manual_grants`, Dexie cache. |
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
- Node.js >= 20.0.0 (Node 20 LTS used in CI)
- npm >= 10.0.0

### Installation & Run
```bash
# Clone the repository
git clone https://github.com/Yousef-eng679/Artix.git
cd Artix

# Install dependencies
npm install

# Start local development server (http://localhost:8080)
npm run dev

# Run Layer 1 & 2 Vitest unit/integration + fault-injection suite (107 files, 698 tests)
npm test

# Run Layer 3 PostgreSQL concurrency, CAS, billing & RLS suite (6/6 tests)
npm run test:pg

# Build production bundle
npm run build

# Run Layer 4 Playwright production PWA E2E suite (builds & previews with active Workbox SW)
npm run test:e2e
```

---

*Artix is developed under an engineering-first, local-first design philosophy. For architectural questions or contribution guidelines, consult the [Canonical Documentation Hub](./docs/README.md).*
