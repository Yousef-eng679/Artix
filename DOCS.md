# Artix Technical Documentation

> **Notice**: As part of the Documentation Recovery Plan (Post-C12), Artix documentation has evolved from this monolithic overview into a modular, authoritative system of connected canonical specifications under [`docs/`](./docs/README.md).

For complete, verified engineering specifications, refer to the canonical documentation sections:

---

## Canonical Documentation Quick Reference

### 1. System Architecture & Models
- **[System Architecture & Runtime Overview](./docs/architecture/SYSTEM.md)** — Architectural philosophy, component topology, and isolation boundaries.
- **[Data Model & State Machines](./docs/architecture/DATA_MODEL.md)** — Detailed Dexie IndexedDB schemas, PostgreSQL schemas, and state machine lifecycles.
- **[Application & Session Lifecycle](./docs/architecture/APPLICATION_LIFECYCLE.md)** — Authentication initialization, multi-tab coordination, and runtime states.
- **[Code Organization & Boundaries](./docs/architecture/CODE_ORGANIZATION.md)** — Directory layout, module responsibilities, and import rules.
- **[Dependency Boundaries](./docs/architecture/DEPENDENCY_BOUNDARIES.md)** — Isolation invariants preventing direct cloud reads from UI hooks.

### 2. Algorithms & Distributed Synchronization
- **[Local-First Synchronization & Failure Modes](./docs/algorithms/LOCAL_FIRST_SYNC.md)** — Atomic local write pipeline and the 10-scenario distributed failure matrix.
- **[Outbox Lifecycle & Compaction Algebra](./docs/algorithms/OUTBOX.md)** — Outbox state transitions, 6-case compaction matrix, and topological DAG ordering.
- **[Pull Engine & Change Feed](./docs/algorithms/PULL_ENGINE.md)** — Append-only `public.sync_changes` log, sequence cursors, and pending-local guards.
- **[Push Engine & CAS Protocol](./docs/algorithms/PUSH_ENGINE.md)** — Optimistic Compare-and-Swap concurrency, push adapters, and revision-safe acks.
- **[Conflict Resolution & Diff3 Merge](./docs/algorithms/CONFLICT_RESOLUTION.md)** — Automatic 3-way line merge for Markdown specifications.
- **[Multi-Tab Web Locks Coordination](./docs/algorithms/MULTI_TAB_COORDINATION.md)** — Native `navigator.locks` leader election with zero-latency failover.
- **[Tombstones & Safe Deletion Lifecycle](./docs/algorithms/TOMBSTONES.md)** — Soft-delete invariants, non-resurrection guards, and 30-day garbage collection.

### 3. Subsystem Implementation Guides
- **[Workspace & Multi-Tab Editor](./docs/subsystems/WORKSPACE_AND_EDITOR.md)** — Multi-tab workspace shell, Monaco Editor, and DOMPurify XSS sanitization.
- **[System Architect Canvas](./docs/subsystems/SYSTEM_DESIGN.md)** — React Flow visual node graph, architectural node library, and high-res export.
- **[AI Prompt Engineering Pipeline](./docs/subsystems/AI_PIPELINE.md)** — Multi-provider inference, streaming readers, and 2-pass critique pass (`refine.ts`).
- **[Authentication & Security](./docs/subsystems/AUTHENTICATION_AND_SECURITY.md)** — PKCE auth flow and comprehensive PostgreSQL RLS policies.
- **[Stripe Billing & Limits](./docs/subsystems/BILLING_AND_LIMITS.md)** — Edge functions, webhook verification, and tier limit triggers.
- **[Progressive Web App (PWA)](./docs/subsystems/PWA_AND_OFFLINE.md)** — Service worker precaching and offline asset delivery.

### 4. Architectural Decision Records (ADRs)
- **[ADR-001: Local-First Authority over Cloud Storage](./docs/decisions/ADR-001-local-first-authority.md)**
- **[ADR-002: User-Scoped IndexedDB Namespaces](./docs/decisions/ADR-002-user-scoped-storage.md)**
- **[ADR-003: Single Unidirectional Write Pipeline](./docs/decisions/ADR-003-single-write-pipeline.md)**
- **[ADR-004: Optimistic Compare-and-Swap (CAS) Concurrency](./docs/decisions/ADR-004-server-cas-concurrency.md)**
- **[ADR-005: Durable Append-Only Change Feed & Sequence Cursor](./docs/decisions/ADR-005-durable-change-feed-cursor.md)**
- **[ADR-006: Web Locks API for Multi-Tab Leadership](./docs/decisions/ADR-006-web-locks-multi-tab-coordination.md)**
- **[ADR-007: Realtime as Latency Accelerator, Not Correctness Source](./docs/decisions/ADR-007-realtime-as-wakeup-accelerator.md)**

### 5. Technical Reference & Registries
- **[API Reference](./docs/reference/API.md)**
- **[Database Schema DDL](./docs/reference/DATABASE_SCHEMA.md)**
- **[Environment Variables](./docs/reference/ENVIRONMENT.md)**
- **[Network Inventory](./docs/reference/NETWORK_INVENTORY.md)**
- **[Project Status & Verification Checksums](./docs/reference/PROJECT_STATUS.md)**
- **[Local Artifact Corpus Registry](./docs/reference/ARTIFACT_REGISTRY.md)**
- **[Truth Reconciliation Report](./docs/reference/TRUTH_RECONCILIATION.md)**

---

*For the complete technical entry point, visit [`README.md`](./README.md) or [`docs/README.md`](./docs/README.md).*
