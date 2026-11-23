# Changelog — Artix

All notable changes to the Artix platform are documented below.

---

## [v2.5.0] — 2026-11-07

### Unified Billing, Strict CAS & True Offline-First Productionization (`fix/productionize-billing-cas-sync`)
- **Expand/Contract Sync Protocol & `projects` Local-First Sync**: Added `projects.version` + `projects.deleted_at` + replication triggers (`20261101100000_expand_sync_protocol_and_projects.sql`), `sync_changes.mutation_id` + `'project'` in `entity_type`, `ArtixDB` v2/v3 `projects` table, `ProjectRepository`, `ProjectPushAdapter`, self-echo `lastAckedMutationId` correlation, and contracted strict server CAS (`p_base_version >= 1` required on `update` and `delete` via `20261101100100_contract_strict_cas_base_version.sql`).
- **Bounded `sync_changes` Retention & Snapshot Hydration**: Added `public.sync_retention_state`, `public.get_sync_feed_bounds()`, and `public.prune_sync_changes()` (`20261101100200_sync_changes_retention_and_floor.sql`), paired with `PullEngine` `bootstrapHydrateAll()` on cold start and `resnapshotAll()` whenever a client cursor falls behind `min_retained_sequence`.
- **Outbox Fencing, Causal Barrier & Atomic Push Finalization**: Added `dispatched` immutability, per-entity causal barrier ordering in `OutboxRepository.getPending({ readyOnly: true })`, `leaseToken` fencing (`markInFlight`), atomic `[outbox, sync_metadata, conflicts]` Dexie finalization in `SyncEngine`, and `retryBlocked` recovery in `SyncStatusBanner`.
- **Error Taxonomy & Conflict Resolution UX**: Expanded `src/lib/sync/errorTaxonomy.ts` to 17 `SyncErrorCode` values, HTTP `429` `Retry-After` parsing capped at `MAX_SYNC_BACKOFF_MS = 300_000`, `TIER_LIMIT_EXCEEDED` trigger mapping, strict `DOMException` `STORAGE_QUOTA` detection, structured conflict reasons (`version_mismatch`, `remote_deleted`, `already_exists`), and side-by-side resolution in `ConflictResolutionModal`.
- **Editor & Board Stale-Buffer Protection**: Added `expectedLocalRevision` / `StaleBufferError` checks and a non-destructive `stale-buffer-banner` (`Load remote`, `Keep mine`, `Save mine as copy`) in `Editor.tsx` and `SystemArchitect.tsx`, plus mid-drag auto-save deferral on the architecture canvas.
- **Atomic Stripe Reconciliation, Strict `past_due` Fail-Closed Policy & `manual_grants`**: Added `public.reconcile_stripe_subscription()` (`reconciliation_version`, `last_stripe_event_created`), RLS-protected `public.manual_grants` (superseding legacy hardcoded admin grant triggers), `public.user_has_active_pro_entitlement()`, and Free-tier monthly AI generation quota enforcement (`5/month`) inside `public.check_plan_tier_limit()` (`20261101100300_atomic_billing_reconciliation_and_manual_grants.sql`). `stripe-webhook` now verifies live subscriptions via `stripe.subscriptions.retrieve()` against the Pro price allowlist (`$8/mo`, `$72/yr`), enforces `GRACE_PERIOD_DAYS = 0` (`past_due` immediately downgrades `plan_tier` to `'free'`), and caches offline entitlements/quotas in `ArtixDB.database_meta` (`'cached_subscription'`, `'cached_ai_generations'`).
- **True Offline Cold-Start & Zero External CDNs**: Added `recoverOfflineSessionFromStorage()` (`src/lib/auth/offlineSession.ts`) and non-destructive `reauth-sync-banner` (`useAuth.tsx`), bundled `monaco-editor` + local web worker (`src/components/Editor/monacoSetup.ts`), self-hosted `@fontsource/inter` and `@fontsource/jetbrains-mono`, Workbox `skipWaiting`/`clientsClaim` with a 5 MiB precache ceiling, `navigator.storage.persist()`, and user-scoped `localStorage` keys/singleton eviction on sign-out.
- **4-Layer Verification Matrix**: Expanded Vitest to `107` files / `698` passing unit & fault-injection tests, added real PostgreSQL 17 / PGlite concurrency & RLS verification (`npm run test:pg`, `6/6` passing), and verified the production PWA build under Playwright Chromium E2E (`18` specs passing on `http://localhost:8080`).

---

## [v2.4.0] — 2026-10-24

### PR #12 Repository Audit Remediation (`fix/audit-remediation-plan`)
- **Commit-Ordered Change Feed (`F-001`)**: Serialized `public.record_sync_change()` sequence allocation with `pg_advisory_xact_lock` so `sync_changes.sequence` strictly matches transaction commit visibility (`20261020100000_commit_ordered_sync_changes.sql`).
- **True 3-Way `diff3` Merge & Conflict Guard (`F-002`)**: Replaced ad-hoc text merging with a full Myers LCS + `diff3` 3-way line merge (`src/lib/sync/merge.ts`), persisted `SyncMetadata.baseSnapshot`, and blocked accidental pushes containing unresolved conflict markers (`UNRESOLVED_CONFLICT_MARKERS`).
- **Server-Side Atomic Idempotent CAS RPC (`F-003`)**: Introduced `public.apply_sync_mutation` (`20261020110000_atomic_idempotent_mutation_rpc.sql`) executing idempotency ledger lookup, optimistic CAS write, and `processed_mutations` recording inside one transaction.
- **PWA Cache Hardening (`F-004`)**: Removed Workbox `runtimeCaching` on authenticated Supabase REST endpoints and added `clearSensitiveBrowserCaches()` (`src/lib/pwa/cacheCleanup.ts`) on startup and sign-out.
- **Dead Beacon Removal (`F-005`)**: Removed dead `/api/save` `navigator.sendBeacon` network calls from `src/lib/cache/tabCloseGuard.ts`, keeping unload persistence strictly local via `draftCache.ts`.
- **Serialized Tier-Limit Trigger (`F-006`)**: Added per-user `pg_advisory_xact_lock` serialization in `public.check_plan_tier_limit()` (`20261020120000_serialize_tier_limits_trigger.sql`).
- **OWASP PBKDF2 Hardening (`F-007`)**: Upgraded BYOK AES-256-GCM key derivation to `v: 2` (`600,000` PBKDF2-SHA256 iterations) with transparent `v: 1` (`250,000` iterations) read compatibility (`src/lib/ai/crypto.ts`).
- **Security Definer & Markdown XSS Hardening (`SS-01`, `SS-08`)**: Locked `search_path = public` and revoked public `EXECUTE` across `SECURITY DEFINER` functions (`20261020130000_harden_security_definer_advisors.sql`), added `sanitizeMarkdownUrl()` URI scheme allowlisting in `MarkdownPreview.tsx`, and added CI `build` + Playwright E2E gates in `.github/workflows/ci.yml`.

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
