# Artix Canonical Documentation Hub

> **Documentation Version**: v2.5.0  
> **Baseline Release**: Productionized Billing, Strict CAS & True Offline-First Architecture  
> **Verification Baseline**: 107 Vitest Test Files / 698 Tests | `npm run test:pg` 6/6 PostgreSQL 17 Concurrency & RLS Tests | `npm run test:e2e` 18 Chromium Playwright Production PWA Specs | 0 TypeScript Errors | 0 ESLint Errors  
> **Documentation Governance**: System of Connected Canonical Documents (Audit F-001–F-007 & Tasks 01–29 Remediated)

---

## 1. System Architecture

The technical architecture of Artix is structured into focused, authoritative specifications:

- **[Architecture Overview](./architecture/OVERVIEW.md)**: High-level client and cloud topology, core architectural pillars, and data invariants.
- **[System Architecture & Runtime Overview](./architecture/SYSTEM.md)**: Architectural philosophy, component topology, cross-boundary communication protocols, and isolation guarantees.
- **[Data Model & State Machines](./architecture/DATA_MODEL.md)**: Complete Dexie IndexedDB v3 (8 tables) and Supabase PostgreSQL 17 (14 tables) schema specifications, entity lifecycles, and formal outbox state models.
- **[Application & Session Lifecycle](./architecture/APPLICATION_LIFECYCLE.md)**: Authentication initialization, offline expired-JWT session continuity, `UserSyncRuntime` lifecycle owner, multi-tab Web Lock leadership, and crash recovery.
- **[Code Organization & Module Boundaries](./architecture/CODE_ORGANIZATION.md)**: Repository directory tree, component catalog, layering rules, and prohibited import paths.
- **[Dependency Boundaries & Isolation Invariants](./architecture/DEPENDENCY_BOUNDARIES.md)**: Test-verified isolation boundaries eliminating direct cloud mutations and UI-hook cloud queries.

---

## 2. Distributed Algorithms & Synchronization Protocols

- **[Local-First Synchronization & Failure Modes](./algorithms/LOCAL_FIRST_SYNC.md)**: Core protocol invariants, commit-ordered change feed, `leaseToken` fencing, atomic local write pipeline, and the exhaustive 10-scenario distributed failure matrix.
- **[Outbox Lifecycle & Compaction Algebra](./algorithms/OUTBOX.md)**: Outbox data structure, 7-case compaction algebra matrix on undispatched tail entries, immutable `dispatched` flag, per-entity causal barrier, topological DAG push ordering, and `leaseToken` crash recovery.
- **[Pull Engine & Durable Change Feed](./algorithms/PULL_ENGINE.md)**: Commit-ordered `public.sync_changes` change feed, `database_meta['server_cursor']`, `mutation_id` self-echo guard, `bootstrapHydrateAll`, `sync_retention_state` floor `resnapshotAll`, and pending-state protection.
- **[Push Engine & CAS Concurrency Protocol](./algorithms/PUSH_ENGINE.md)**: Single-transaction `public.apply_sync_mutation` RPC, strict CAS baselines (`baseServerVersion >= 1`), `leaseToken` fencing, 4 entity push adapters (including `projects`), and revision-safe push acknowledgments.
- **[Conflict Resolution & 3-Way Diff3 Merge](./algorithms/CONFLICT_RESOLUTION.md)**: Detection of 409 and remote-delete conflicts, `ConflictRepository` snapshot storage across all 4 entity types, LCS-aligned 3-way `diff3` text merge, `UnresolvedConflictMarkersError` guard, and `ConflictResolutionCenter` UI.
- **[Multi-Tab Coordination & Web Locks Leader Protocol](./algorithms/MULTI_TAB_COORDINATION.md)**: Native browser Web Locks API (`navigator.locks`) single-leader election, zero-latency failover, `BroadcastChannel` event bus, and `leaseToken` storage fencing.
- **[Tombstones & Safe Deletion Lifecycle](./algorithms/TOMBSTONES.md)**: Prevention of entity resurrection across all 4 synced entity types, soft-delete state machine, non-echoing remote deletes, and 30-day garbage collection.

---

## 3. Subsystem Implementation Guides

- **[Workspace & Multi-Tab Editor Subsystem](./subsystems/WORKSPACE_AND_EDITOR.md)**: Workspace shell, persistent tab bar (`useWorkspaceTabs`), dirty state tracking, offline-bundled Monaco editor, stale-buffer protection, and AST-escaped Markdown + URL protocol sanitization.
- **[System Architect Canvas Subsystem](./subsystems/SYSTEM_DESIGN.md)**: React Flow interactive node graph, cloud infrastructure node library, stale-buffer protection, canonical board state serialization, and PNG/SVG export.
- **[AI Intelligence Suite & Prompt Pipeline](./subsystems/AI_PIPELINE.md)**: Multi-provider abstraction, Server-Sent Events (SSE) token streaming, 2-pass critique pass (`refine.ts`), and prompt compilers.
- **[Authentication & Storage Security Boundaries](./subsystems/AUTHENTICATION_AND_SECURITY.md)**: Supabase Auth PKCE flow, offline expired-JWT session recovery, multi-account cache eviction, comprehensive PostgreSQL RLS policy catalog, and user-scoped database isolation.
- **[Stripe Billing & Resource Tier Enforcement](./subsystems/BILLING_AND_LIMITS.md)**: Stripe checkout/portal Edge Functions, server-owned price allowlist, atomic `reconcile_stripe_subscription` RPC, `manual_grants`, strict `past_due` fail-closed policy, serialized `check_plan_tier_limit()` trigger, and offline entitlement caching.
- **[Progressive Web App (PWA) & Offline Asset Caching](./subsystems/PWA_AND_OFFLINE.md)**: Workbox precaching (`clientsClaim` + `skipWaiting`), self-hosted `@fontsource` fonts, `navigator.storage.persist()`, and native desktop installability.

---

## 4. Security & Cryptography

- **[Security Model & Threat Analysis](./security/SECURITY_MODEL.md)**: Comprehensive threat matrix, trust boundaries, and public vulnerability reporting guidelines.
- **[Row Level Security (RLS) & Auth Architecture](./security/RLS_AND_AUTH.md)**: Complete SQL policies for multi-tenant isolation across all 14 `public` tables.
- **[Client-Side BYOK Key Encryption & Storage](./security/CLIENT_KEY_STORAGE.md)**: Web Cryptography API implementation using PBKDF2 (600,000 iterations v:2; legacy v:1 250,000) and AES-GCM 256-bit.

---

## 5. Engineering Standards & Operations

- **[Engineering Guidelines & Development Standards](./engineering/DEVELOPMENT.md)**: Local developer setup, strict TypeScript standards, React error boundaries, and commit conventions.
- **[Testing Architecture & Verification Protocols](./engineering/TESTING.md)**: 4-layer verification pyramid — 107 Vitest suites (698 tests), Layer 2 controllable fake-server fault injection, Layer 3 real PostgreSQL 17 concurrency & RLS suite (`npm run test:pg`, 6/6 tests), and Layer 4 Chromium Playwright production PWA E2E suite (`npm run test:e2e`, 18 specs).
- **[Database Migrations & Schema Evolution Guide](./engineering/MIGRATIONS.md)**: Client IndexedDB schema v3 evolution, legacy database migration, and 25 Supabase SQL migrations.
- **[Observability, Error Taxonomy & Diagnostics](./engineering/OBSERVABILITY.md)**: `classifySyncError` taxonomy, `SyncStatusBanner`, client-side health hooks (`useSyncStatus`), and runtime diagnostics.

---

## 6. Technical Reference & Registries

- **[API Reference](./reference/API.md)**: Strongly typed method signatures for `ProjectRepository`, `DocumentRepository`, `SystemDesignRepository`, `FolderRepository`, and `SyncEngine`.
- **[Comprehensive Database Schema](./reference/DATABASE_SCHEMA.md)**: Full PostgreSQL 17 DDL schemas (14 tables) and Dexie IndexedDB v3 table definitions (8 tables).
- **[Environment Variables & Configuration](./reference/ENVIRONMENT.md)**: Client `.env` variables and server-side Supabase Vault secret definitions.
- **[Network Boundary & Remote Endpoint Inventory](./reference/NETWORK_INVENTORY.md)**: Exhaustive catalog of all authorized external endpoints, protocols, and payloads.
- **[Project Status & Implementation Matrix](./reference/PROJECT_STATUS.md)**: Detailed status matrix classifying features as `IMPLEMENTED`, `PARTIALLY IMPLEMENTED`, or `PLANNED`.
- **[Local Artifact Corpus Registry](./reference/ARTIFACT_REGISTRY.md)**: Complete catalog and disposition map for all 35+ historical local artifacts.
- **[Truth Reconciliation Report](./reference/TRUTH_RECONCILIATION.md)**: Formal audit reconciling legacy documentation contradictions against verified code truth.
- **[Repository Audit (2026-10-12)](./audits/2026-10-12_REPOSITORY_AUDIT.md)** and **[Audit Remediation Plan](./audits/AUDIT_REMEDIATION_PLAN.md)**: External engineering audit findings (F-001–F-007) and the completed atomic task plan (Tasks 01–29).

---

## 7. Architectural Decision Records (ADRs)

| ADR ID | Title | Status | Scope |
|---|---|---|---|
| **[ADR-001](./decisions/ADR-001-local-first-authority.md)** | Local-First Authority over Cloud Storage | `ACCEPTED` | Shift from remote-first REST to local Dexie IndexedDB v3 authority across all 4 workspace entity types. |
| **[ADR-002](./decisions/ADR-002-user-scoped-storage.md)** | User-Scoped IndexedDB Namespaces | `ACCEPTED` | FNV-1a hash partitioning (`ArtixDB_v2_<hash>`), user-scoped `localStorage`, and full cache/query eviction on account switch. |
| **[ADR-003](./decisions/ADR-003-single-write-pipeline.md)** | Single Unidirectional Write Pipeline | `ACCEPTED` | Atomic Dexie transactions (`3-table` CRUD, `5-table` folder delete, `6-table` project cascade delete across `[projects, documents, system_designs, workspace_folders, outbox, sync_metadata]`). |
| **[ADR-004](./decisions/ADR-004-server-cas-concurrency.md)** | Optimistic Compare-and-Swap (CAS) Concurrency | `ACCEPTED` | Single-transaction `apply_sync_mutation` RPC enforcing strict CAS (`baseServerVersion >= 1`) and `processed_mutations` idempotency. |
| **[ADR-005](./decisions/ADR-005-durable-change-feed-cursor.md)**| Durable Append-Only Change Feed & Sequence Cursor| `ACCEPTED` | Commit-ordered `sync_changes` log, `database_meta['server_cursor']`, `mutation_id` self-echo, and `sync_retention_state` floor recovery. |
| **[ADR-006](./decisions/ADR-006-web-locks-multi-tab-coordination.md)**| Web Locks API for Multi-Tab Leadership | `ACCEPTED` | Native `navigator.locks` leader election, `BroadcastChannel` notifications, and `leaseToken` fencing. |
| **[ADR-007](./decisions/ADR-007-realtime-as-wakeup-accelerator.md)**| Realtime as Latency Accelerator, Not Correctness Source| `ACCEPTED` | Leader-gated WebSocket channels with 50ms debounce used purely for wakeup triggers; change feed is correctness authority. |

---

## 8. Product Requirements (PRD)

- **[Product Requirements Document (PRD)](../prd/ARTIX_PRODUCT_REQUIREMENTS_DOCUMENT.md)**: Core product mission, user personas, and functional requirements.
- **[Technical Specifications](../prd/TECHNICAL_SPECIFICATIONS.md)**: Product-level architectural specifications and performance benchmarks.
- **[Vibe Coding Playbook](../prd/VIBE_CODING_PLAYBOOK.md)**: Prompt compilation methodology for AI coding assistants.

---

## 9. Changelog & Historical Archive

- **[Changelog](./changelog/CHANGELOG.md)**: Complete chronological history of releases from v1.0.0 through v2.5.0.
- **[Historical Archive](./archive/historical/)**: Preserved historical engineering reviews, Arabic interview guide, and release descriptions.
- **[Superseded Execution Plans](./archive/plans/)**: Preserved multi-phase execution roadmaps and remediation plans.
