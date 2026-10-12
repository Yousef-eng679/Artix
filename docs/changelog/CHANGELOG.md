# Changelog — Artix

All notable changes to the Artix platform are documented below.

---

## [v2.3.0] — 2026-09-30

### Canonical Documentation System & Recovery Plan V2
- **Unified Canonical Hierarchy**: Created `docs/architecture/`, `docs/algorithms/`, `docs/subsystems/`, `docs/security/`, `docs/engineering/`, `docs/reference/`, and `docs/decisions/`.
- **Authoritative Technical README**: Completely replaced the placeholder root `README.md` with a comprehensive 25-section engineering manual covering architecture, data models, CAS concurrency, outbox algebra, and distributed failure modes.
- **7 Architectural Decision Records (ADRs)**: Documented durable architectural decisions (`ADR-001` through `ADR-007`) explaining local-first authority, user-scoped storage, single write pipelines, optimistic CAS, durable change feeds, Web Locks coordination, and Realtime wakeup roles.
- **Truth Reconciliation & Artifact Registry**: Extracted knowledge from 35+ historical local artifacts, cataloged them in `docs/reference/ARTIFACT_REGISTRY.md`, and reconciled 7 critical contradictions (Web Locks vs heartbeats; server version integer vs bigint; tombstone delete vs server CAS delete; outbox state transitions; idempotency ledgers vs 2PC; Realtime wakeup role; user scope hashing).

---

## [v2.2.0] — 2026-09-28

### Protocol-Level Synchronization Correctness Hardening (Phases C0–C12)
- **Phase C0 (Protocol Freeze)**: Authored formal specifications for mutation identity, monotonic versioning, state machine transitions, and 14 distributed failure modes.
- **Phase C1 (Idempotent Server Protocol)**: Added durable `mutationId` (UUID v4) to `OutboxEntry` and implemented `public.processed_mutations` server ledger to guarantee safe retries under dropped connections.
- **Phase C2 (CAS Baseline Propagation)**: Enforced monotonic `baseServerVersion` across all repository mutations and delete operations, preventing silent Lost Updates.
- **Phase C3 (Revision-Safe Acknowledgements)**: Acknowledging push revision $N$ checks local revision; if the user typed revision $N+1$ in the interim, the baseline updates while local status correctly remains `pending`.
- **Phase C4 (Eliminate Hook-Level Remote Reads)**: Refactored `useDocuments`, `useSystemDesigns`, and `useWorkspaceFolders` to read exclusively from local IndexedDB repositories; eliminated direct Supabase imports from UI hooks.
- **Phase C5 (Pending-State-Safe Pull Application)**: `PullEngine` inspects the outbox before applying remote snapshots; concurrent modifications are captured as structured 3-way conflicts in `ConflictRepository`, blocking the outbox entry.
- **Phase C6 (UserSyncRuntime Lifecycle Owner)**: Bound runtime lifecycle to user authentication state via `UserSyncRuntimeContext` and provider, ensuring zero cross-tenant cache leakage upon account switch.
- **Phase C7 (Realtime Lifecycle & Recovery)**: Bound Realtime channels to runtime lifecycle with 150ms leading-edge debouncing and reconnect cursor pulls.
- **Phase C8 (Tombstones & Delete Correctness)**: Created `TombstoneManager` to manage `LOCAL_PENDING_DELETE`, `REMOTE_CONFIRMED_DELETE`, and `DELETED_SYNCED` states with 30-day garbage collection, preventing entity resurrection.
- **Phase C9 (Outbox Mutation Algebra & Dependency Ordering)**: Implemented restore mutation algebra (`DELETE + CREATE -> UPDATE`), folder cascading payloads, and topological DAG push ordering.
- **Phase C10 (Web Locks Single-Leader Worker)**: Implemented native Web Locks API leader election in `TabCoordinator` with instant zero-latency orphaned lease recovery upon tab crashes.
- **Phase C11 (Storage, Migration & Runtime Safety)**: Added multi-tab `versionchange` and `blocked` handlers to `ArtixDB`, hardened legacy database migration, and exposed typed `RuntimeStatus`.
- **Phase C12 (Correctness Test Matrix)**: Authored comprehensive 10-scenario distributed failure simulation suite (`src/test/sync/correctnessMatrix.test.ts`), verifying 100% green execution across scenarios A through J.

---

## [v2.1.0] — 2026-09-26

### Local-First Architecture Shift & Dexie IndexedDB Authority
- **Local Persistence Layer**: Integrated Dexie.js v4 on top of IndexedDB, establishing local storage as the primary authority for all workspace resources.
- **Atomic 3-Table Mutations**: Every local mutation commits across `[entity, outbox, sync_metadata]` in a single transaction.
- **Append-Only Change Feed**: Implemented `public.sync_changes` in PostgreSQL with sequence cursors for bandwidth-efficient replication.
- **Diff3 3-Way Line Merge**: Implemented automated three-way line merge algorithm for technical markdown documents.

---

## [v2.0.0] — 2026-09-24

### Workspace UX, Hierarchical Folders & Multi-Tab System (PR #1)
- **Multi-Tab Workspace Shell**: Added persistent workspace tab bar (`WorkspaceTabBar.tsx`) with URL synchronization (`?doc=` and `?design=`), active dirty state indicators, and keyboard navigation (`Ctrl+W`, `Ctrl+Tab`, `Ctrl+S`).
- **Hierarchical Folder DAG**: Added multi-level nested folders, drag-and-drop hierarchy, and cascade deletion support.
- **Unified Resource Adapters**: Implemented 4-tier pure `AdaptableResource` view model abstracting documents and system designs.
- **Monaco Preview Toggle**: Added synchronized Markdown preview split-pane with persistent user layout preferences.

---

## [v1.6.0] — 2026-09-20

### CI/CD & Reliability Hardening
- **GitHub Actions CI Automation**: Added `.github/workflows/ci.yml` running parallel linting, TypeScript typecheck, Vitest unit test suite, and production build on Node.js 20 LTS.
- **Hermetic Supabase Unit Test Suite**: Intercepted `FunctionsClient.prototype.invoke` in test setup, removing operating-system DNS lookups.
- **Async Concurrency & Race-Condition Defense**: Refactored `saveSettings()` to return `Promise<void>` with revision-counter guards.
- **Client Storage Sanitization**: Enforced `sanitizeSettingsForStorage()` in `disableEncryption()`.

---

## [v1.5.0] — 2026-07-25
- Google OAuth Integration, database foreign key constraints, route code-splitting with `React.lazy()`.

---

## [v1.4.0] — 2026-07-23
- Accessibility landmarks, `/public/llms.txt` AI agent crawling specs, Reset Vault dialog.

---

## [v1.3.0] — 2026-07-23
- System Architect horizontal Dagre layout, 1-click Auto Layout button, 40-node capacity.

---

## [v1.2.0] — 2026-07-23
- PRD Generator and Vibe Coding prompt compilers with 2-pass critique pass (`refine.ts`).

---

## [v1.1.0] — 2026-07-23
- Stripe billing integration via Supabase Edge Functions and tier limit database triggers.

---

## [v1.0.0] — 2026-07-22
- Initial platform setup, BYOK key encryption, Monaco editor, and Vitest test suite.
