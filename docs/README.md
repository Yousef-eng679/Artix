# Artix Canonical Documentation Hub

> **Documentation Version**: v2.3.0  
> **Baseline Release**: Post-C12 Synchronization Correctness Hardening (`a48c979`)  
> **Documentation Governance**: System of Connected Canonical Documents (Recovery Plan V2)

---

## 1. System Architecture

The technical architecture of Artix is structured into focused, authoritative specifications:

- **[System Architecture & Runtime Overview](./architecture/SYSTEM.md)**: Architectural philosophy, component topology, cross-boundary communication protocols, and isolation guarantees.
- **[Data Model & State Machines](./architecture/DATA_MODEL.md)**: Complete IndexedDB and Supabase PostgreSQL schema specifications, entity lifecycles, and formal outbox state models.
- **[Application & Session Lifecycle](./architecture/APPLICATION_LIFECYCLE.md)**: Authentication initialization, `UserSyncRuntime` lifecycle owner, multi-tab Web Lock leadership, and crash recovery.
- **[Code Organization & Module Boundaries](./architecture/CODE_ORGANIZATION.md)**: Repository directory tree, component catalog, layering rules, and forbidden import paths.
- **[Dependency Boundaries & Isolation Invariants](./architecture/DEPENDENCY_BOUNDARIES.md)**: Test-verified isolation boundaries, eliminating direct cloud reads from UI hooks.

---

## 2. Distributed Algorithms & Synchronization Protocols

- **[Local-First Synchronization & Failure Modes](./algorithms/LOCAL_FIRST_SYNC.md)**: Core protocol invariants, atomic local write pipeline, and the exhaustive 10-scenario distributed failure matrix.
- **[Outbox Lifecycle & Compaction Algebra](./algorithms/OUTBOX.md)**: Outbox data structure, 6-case compaction algebra matrix, topological DAG push ordering, and in-flight lease recovery.
- **[Pull Engine & Durable Change Feed](./algorithms/PULL_ENGINE.md)**: Server-side `public.sync_changes` change feed, monotonic sequence cursors, and the pending-state protection guard.
- **[Push Engine & CAS Concurrency Protocol](./algorithms/PUSH_ENGINE.md)**: Optimistic Compare-and-Swap (CAS) version predicates, push adapters, and revision-safe push acknowledgments.
- **[Conflict Resolution & 3-Way Diff3 Merge](./algorithms/CONFLICT_RESOLUTION.md)**: Detection of 409 conflicts, `ConflictRepository` snapshot storage, and line-level 3-way diff3 merging for technical documents.
- **[Multi-Tab Coordination & Web Locks Leader Protocol](./algorithms/MULTI_TAB_COORDINATION.md)**: Native browser Web Locks API (`navigator.locks`) single-leader election, zero-latency failover, and BroadcastChannel event bus.
- **[Tombstones & Safe Deletion Lifecycle](./algorithms/TOMBSTONES.md)**: Prevention of entity resurrection, soft-delete state machine, non-echoing remote deletes, and 30-day garbage collection.

---

## 3. Subsystem Implementation Guides

- **[Workspace & Multi-Tab Editor Subsystem](./subsystems/WORKSPACE_AND_EDITOR.md)**: Workspace shell, persistent tab bar (`useWorkspaceTabs`), dirty state tracking, Monaco editor, and DOMPurify XSS sanitization.
- **[System Architect Canvas Subsystem](./subsystems/SYSTEM_DESIGN.md)**: React Flow interactive node graph, cloud infrastructure node library, board state serialization, and PNG/SVG export.
- **[AI Intelligence Suite & Prompt Pipeline](./subsystems/AI_PIPELINE.md)**: Multi-provider abstraction, Server-Sent Events (SSE) token streaming, 2-pass critique pass (`refine.ts`), and prompt compilers.
- **[Authentication & Storage Security Boundaries](./subsystems/AUTHENTICATION_AND_SECURITY.md)**: Supabase Auth PKCE flow, comprehensive PostgreSQL RLS policy catalog, and user-scoped database isolation.
- **[Stripe Billing & Resource Tier Enforcement](./subsystems/BILLING_AND_LIMITS.md)**: Stripe checkout sessions, customer portal, webhook signature verification, and database trigger limit enforcement.
- **[Progressive Web App (PWA) & Offline Asset Caching](./subsystems/PWA_AND_OFFLINE.md)**: Workbox precaching, service worker lifecycle, Cache-First strategy, and native desktop installability.

---

## 4. Security & Cryptography

- **[Security Model & Threat Analysis](./security/SECURITY_MODEL.md)**: Comprehensive threat matrix, trust boundaries, and public vulnerability reporting guidelines.
- **[Row Level Security (RLS) & Auth Architecture](./security/RLS_AND_AUTH.md)**: Complete SQL policies for multi-tenant isolation across all tables.
- **[Client-Side BYOK Key Encryption & Storage](./security/CLIENT_KEY_STORAGE.md)**: Web Cryptography API implementation using PBKDF2 (100,000 iterations) and AES-GCM 256-bit.

---

## 5. Engineering Standards & Operations

- **[Engineering Guidelines & Development Standards](./engineering/DEVELOPMENT.md)**: Local developer setup, strict TypeScript standards, React error boundaries, and commit conventions.
- **[Testing Architecture & Verification Protocols](./engineering/TESTING.md)**: Vitest test runner, in-memory `fake-indexeddb`, mock guidelines, and the 10 distributed failure test scenarios.
- **[Database Migrations & Schema Evolution Guide](./engineering/MIGRATIONS.md)**: Client IndexedDB schema versioning, legacy database migration, and Supabase SQL migration management.
- **[Observability, Error Taxonomy & Diagnostics](./engineering/OBSERVABILITY.md)**: `classifySyncError` taxonomy, client-side health hooks (`useSyncStatus`), and runtime diagnostics.

---

## 6. Technical Reference & Registries

- **[API Reference](./reference/API.md)**: Strongly typed method signatures for `DocumentRepository`, `SystemDesignRepository`, `FolderRepository`, and `SyncEngine`.
- **[Comprehensive Database Schema](./reference/DATABASE_SCHEMA.md)**: Full PostgreSQL DDL schemas and Dexie IndexedDB table definitions.
- **[Environment Variables & Configuration](./reference/ENVIRONMENT.md)**: Client `.env` variables and server-side Supabase Vault secret definitions.
- **[Network Boundary & Remote Endpoint Inventory](./reference/NETWORK_INVENTORY.md)**: Exhaustive catalog of all authorized external endpoints, protocols, and payloads.
- **[Project Status & Implementation Matrix](./reference/PROJECT_STATUS.md)**: Detailed status matrix classifying features as `IMPLEMENTED`, `PARTIALLY IMPLEMENTED`, or `PLANNED`.
- **[Local Artifact Corpus Registry](./reference/ARTIFACT_REGISTRY.md)**: Complete catalog and disposition map for all 35+ historical local artifacts.
- **[Truth Reconciliation Report](./reference/TRUTH_RECONCILIATION.md)**: Formal audit reconciling legacy documentation contradictions against verified code truth.

---

## 7. Architectural Decision Records (ADRs)

| ADR ID | Title | Status | Scope |
|---|---|---|---|
| **[ADR-001](./decisions/ADR-001-local-first-authority.md)** | Local-First Authority over Cloud Storage | `ACCEPTED` | Shift from remote-first REST to local Dexie IndexedDB authority. |
| **[ADR-002](./decisions/ADR-002-user-scoped-storage.md)** | User-Scoped IndexedDB Namespaces | `ACCEPTED` | FNV-1a hash database partitioning (`ArtixDB_v2_<hash>`) for multi-tenant isolation. |
| **[ADR-003](./decisions/ADR-003-single-write-pipeline.md)** | Single Unidirectional Write Pipeline | `ACCEPTED` | Atomic 3-table Dexie transactions across entities, outbox, and sync metadata. |
| **[ADR-004](./decisions/ADR-004-server-cas-concurrency.md)** | Optimistic Compare-and-Swap (CAS) Concurrency | `ACCEPTED` | Server version increment triggers and CAS predicates preventing Lost Updates. |
| **[ADR-005](./decisions/ADR-005-durable-change-feed-cursor.md)**| Durable Append-Only Change Feed & Sequence Cursor| `ACCEPTED` | Append-only `sync_changes` table and client monotonic sequence cursor pull. |
| **[ADR-006](./decisions/ADR-006-web-locks-multi-tab-coordination.md)**| Web Locks API for Multi-Tab Leadership | `ACCEPTED` | Native browser `navigator.locks` leader election with zero-latency failover. |
| **[ADR-007](./decisions/ADR-007-realtime-as-wakeup-accelerator.md)**| Realtime as Latency Accelerator, Not Correctness Source| `ACCEPTED` | WebSocket channels used purely for wakeup triggers; change feed is correctness authority. |

---

## 8. Product Requirements (PRD)

- **[Product Requirements Document (PRD)](../prd/ARTIX_PRODUCT_REQUIREMENTS_DOCUMENT.md)**: Core product mission, user personas, and functional requirements.
- **[Technical Specifications](../prd/TECHNICAL_SPECIFICATIONS.md)**: Product-level architectural specifications and performance benchmarks.
- **[Vibe Coding Playbook](../prd/VIBE_CODING_PLAYBOOK.md)**: Prompt compilation methodology for AI coding assistants.

---

## 9. Changelog & Historical Archive

- **[Changelog](./changelog/CHANGELOG.md)**: Complete chronological history of releases from v1.0.0 through v2.3.0.
- **[Historical Archive](./archive/historical/)**: Preserved historical engineering reviews, Arabic interview guide, and release descriptions.
- **[Superseded Execution Plans](./archive/plans/)**: Preserved multi-phase execution roadmaps and remediation plans.
