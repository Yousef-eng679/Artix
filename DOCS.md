# Artix Technical Documentation

> **Documentation Version**: v2.5.0 — Productionized Billing, Strict CAS & True Offline-First Architecture  
> **Notice**: Artix documentation is maintained as a modular, authoritative system of connected canonical specifications under [`docs/`](./docs/README.md) (Tasks 01–29 & Audit F-001–F-007 remediated; verified by 107 Vitest suites / 698 tests, 6/6 PostgreSQL 17 concurrency & RLS tests, and 18 Chromium Playwright PWA E2E specs).

For complete, verified engineering specifications, refer to the canonical documentation sections:

---

## Canonical Documentation Quick Reference

### 1. System Architecture & Models
- **[Architecture Overview](./docs/architecture/OVERVIEW.md)** — High-level local-first pillars, client/cloud layers, and data invariants.
- **[System Architecture & Runtime Overview](./docs/architecture/SYSTEM.md)** — Architectural philosophy, component topology, and isolation boundaries.
- **[Data Model & State Machines](./docs/architecture/DATA_MODEL.md)** — Detailed Dexie IndexedDB v3 schemas (8 tables), PostgreSQL 17 schemas (14 tables), and state machine lifecycles.
- **[Application & Session Lifecycle](./docs/architecture/APPLICATION_LIFECYCLE.md)** — Authentication initialization, offline expired-JWT continuity, multi-tab coordination, and `RuntimeState` lifecycle.
- **[Code Organization & Boundaries](./docs/architecture/CODE_ORGANIZATION.md)** — Directory layout, module responsibilities, and prohibited import rules.
- **[Dependency Boundaries](./docs/architecture/DEPENDENCY_BOUNDARIES.md)** — Test-verified isolation invariants preventing direct cloud mutations or reads from UI hooks.

### 2. Algorithms & Distributed Synchronization
- **[Local-First Synchronization & Failure Modes](./docs/algorithms/LOCAL_FIRST_SYNC.md)** — Atomic local write pipeline, commit-ordered change feed, `leaseToken` fencing, and the 10-scenario distributed failure matrix.
- **[Outbox Lifecycle & Compaction Algebra](./docs/algorithms/OUTBOX.md)** — Outbox state transitions, 7-case compaction matrix on undispatched tail entries, immutable `dispatched` flag, per-entity causal barrier, and topological DAG ordering.
- **[Pull Engine & Change Feed](./docs/algorithms/PULL_ENGINE.md)** — Commit-ordered `public.sync_changes` log, `database_meta['server_cursor']`, `mutation_id` self-echo recognition, `bootstrapHydrateAll`, `sync_retention_state` floor `resnapshotAll`, and pending-local guards.
- **[Push Engine & CAS Protocol](./docs/algorithms/PUSH_ENGINE.md)** — Single-transaction `public.apply_sync_mutation` RPC, strict CAS (`baseServerVersion >= 1`), `leaseToken` fencing, 4 entity push adapters (including `projects`), and revision-safe acks.
- **[Conflict Resolution & Diff3 Merge](./docs/algorithms/CONFLICT_RESOLUTION.md)** — LCS-aligned 3-way `diff3` text merge, `UnresolvedConflictMarkersError` push/save guard, `remote_deleted` & `create_copy` strategies across all 4 entity types, and `ConflictResolutionCenter` UI.
- **[Multi-Tab Web Locks Coordination](./docs/algorithms/MULTI_TAB_COORDINATION.md)** — Native `navigator.locks` leader election with zero-latency failover and cross-tab `BroadcastChannel` notifications.
- **[Tombstones & Safe Deletion Lifecycle](./docs/algorithms/TOMBSTONES.md)** — Soft-delete invariants across all 4 entity types, non-resurrection guards, and 30-day garbage collection.

### 3. Subsystem Implementation Guides
- **[Workspace & Multi-Tab Editor](./docs/subsystems/WORKSPACE_AND_EDITOR.md)** — Multi-tab workspace shell, bundled offline Monaco editor/worker, stale-buffer overwrite protection, and AST-escaped Markdown rendering with strict URL protocol sanitization.
- **[System Architect Canvas](./docs/subsystems/SYSTEM_DESIGN.md)** — React Flow visual node graph, architectural node library, stale-buffer protection, and high-res export.
- **[AI Prompt Engineering Pipeline](./docs/subsystems/AI_PIPELINE.md)** — Multi-provider inference, streaming readers, and 2-pass critique pass (`refine.ts`).
- **[Authentication & Security](./docs/subsystems/AUTHENTICATION_AND_SECURITY.md)** — PKCE auth flow, offline expired-JWT session continuity (`recoverOfflineSessionFromStorage`), multi-account teardown/cache eviction, and comprehensive PostgreSQL RLS policies.
- **[Stripe Billing & Limits](./docs/subsystems/BILLING_AND_LIMITS.md)** — Edge functions, atomic `reconcile_stripe_subscription` RPC, `manual_grants` RLS table, strict `past_due` fail-closed policy, serialized `check_plan_tier_limit()` trigger, and offline Dexie entitlement caching.
- **[Progressive Web App (PWA)](./docs/subsystems/PWA_AND_OFFLINE.md)** — Service worker precaching with immediate `clientsClaim` + `skipWaiting`, self-hosted `@fontsource` fonts, and `navigator.storage.persist()`.

### 4. Architectural Decision Records (ADRs)
- **[ADR-001: Local-First Authority over Cloud Storage](./docs/decisions/ADR-001-local-first-authority.md)**
- **[ADR-002: User-Scoped IndexedDB Namespaces](./docs/decisions/ADR-002-user-scoped-storage.md)**
- **[ADR-003: Single Unidirectional Write Pipeline](./docs/decisions/ADR-003-single-write-pipeline.md)**
- **[ADR-004: Optimistic Compare-and-Swap (CAS) Concurrency](./docs/decisions/ADR-004-server-cas-concurrency.md)**
- **[ADR-005: Durable Append-Only Change Feed & Sequence Cursor](./docs/decisions/ADR-005-durable-change-feed-cursor.md)**
- **[ADR-006: Web Locks API for Multi-Tab Leadership](./docs/decisions/ADR-006-web-locks-multi-tab-coordination.md)**
- **[ADR-007: Realtime as Latency Accelerator, Not Correctness Source](./docs/decisions/ADR-007-realtime-as-wakeup-accelerator.md)**

### 5. Engineering, Operations & Audits
- **[Engineering Guidelines & Development Standards](./docs/engineering/DEVELOPMENT.md)**
- **[Testing Architecture & Verification Protocols](./docs/engineering/TESTING.md)**
- **[Database Migrations & Schema Evolution Guide](./docs/engineering/MIGRATIONS.md)**
- **[Observability, Error Taxonomy & Diagnostics](./docs/engineering/OBSERVABILITY.md)**
- **[Repository Audit (2026-10-12)](./docs/audits/2026-10-12_REPOSITORY_AUDIT.md)**
- **[Audit Remediation Plan](./docs/audits/AUDIT_REMEDIATION_PLAN.md)**

### 6. Technical Reference & Registries
- **[API Reference](./docs/reference/API.md)**
- **[Database Schema DDL](./docs/reference/DATABASE_SCHEMA.md)**
- **[Environment Variables](./docs/reference/ENVIRONMENT.md)**
- **[Network Inventory](./docs/reference/NETWORK_INVENTORY.md)**
- **[Project Status & Verification Checksums](./docs/reference/PROJECT_STATUS.md)**
- **[Local Artifact Corpus Registry](./docs/reference/ARTIFACT_REGISTRY.md)**
- **[Truth Reconciliation Report](./docs/reference/TRUTH_RECONCILIATION.md)**

---

*For the complete technical entry point, visit [`README.md`](./README.md) or [`docs/README.md`](./docs/README.md).*
