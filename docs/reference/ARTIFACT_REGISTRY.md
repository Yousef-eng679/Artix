# Artix Local Artifact & Documentation Corpus Registry
**Inventory, Classification, and Knowledge Extraction Map**

---

## 1. Overview & Purpose

This registry catalogs the 35+ local and historical artifacts produced across development cycles of Artix (including Manus, Claude, Antigravity, and Gemini). Per the Artix Source-of-Truth Hierarchy:

```text
CODE + DATABASE MIGRATIONS + TESTS (Highest Authority)
            ↓
CURRENT CANONICAL ARCHITECTURE DOCUMENTATION
            ↓
ARCHITECTURAL DECISIONS / ADRs
            ↓
PRD / PRODUCT INTENT
            ↓
LOCAL DESIGN NOTES / HISTORICAL ARTIFACTS
            ↓
OLD PLANS / AI EXECUTION SCRATCHPADS (Lowest Authority)
```

No local artifact is considered current truth simply because of its length or detail. Every claim has been cross-referenced against the post-C12 implementation in `c:\Fenix-main`.

---

## 2. Complete Artifact Corpus Registry

| # | Artifact Filename / Path | Type | Era / Date | Scope | Authority | Current Status | Related Source Files | Knowledge Extracted & Transferred | Final Disposition |
|---|---|---|---|---|---|---|---|---|---|
| **01** | `01_2026-07-23_Manus_Remediation_Plan.md` (`Artrix_Remediation_Plan.md`) | Remediation Plan | July 2026 | Security, AI storage, RLS | Historical Review | `IMPLEMENTED` | `src/lib/ai/crypto.ts`, `src/lib/ai/storage.ts` | AES-GCM 256-bit PBKDF2 encryption for BYOK keys; plaintext fallback sanitization. | Archive to `docs/archive/historical/` & merge into `docs/security/CLIENT_KEY_STORAGE.md` |
| **02** | `02_2026-09-07_Claude_Engineering_Review_and_Fix_Checklist.md` | Code Review / Checklist | Sep 7, 2026 | Auto-save, Monaco Editor, DOMPurify, CSP | Engineering Review | `IMPLEMENTED` | `src/components/Editor/`, `src/components/SystemArchitect/` | Autosave debouncing logic, dirty state tracking per tab, MarkdownPreview DOMPurify hooks. | Archive to `docs/archive/historical/` & merge into `docs/subsystems/WORKSPACE_AND_EDITOR.md` |
| **03** | `03_2026-09-09_Claude_Merged_Engineering_Review_Final.md` | Consolidated Review | Sep 9, 2026 | Codebase-wide architecture audit | Historical Review | `IMPLEMENTED` | Across `src/`, `supabase/` | Full inventory of initial architectural gaps and baseline remediation milestones. | Archive to `docs/archive/historical/` |
| **04** | `04_2026-09-11_Antigravity_Hardening_Implementation_Plan.md` (`implementation_plan.md`) | Master Hardening Plan | Sep 11, 2026 | Security, Reliability, Zod boundaries, Hygiene | Implementation Plan | `IMPLEMENTED` | `src/App.tsx`, `src/components/ErrorBoundary.tsx`, `tsconfig.json` | React ErrorBoundaries, runtime Zod boundary guards, strict TS rules, lockfile cleanup. | Archive to `docs/archive/plans/` & merge into `docs/engineering/DEVELOPMENT.md` |
| **05** | `05_2026-09-20_Claude_Documentation_Sync_Directive.md` | Directive | Sep 20, 2026 | Documentation governance | Directive | `SUPERSEDED` | `docs/` | Guidelines on document-code synchronization (superseded by Recovery Plan V2). | Archive to `docs/archive/historical/` |
| **06** | `06_2026-09-21_Antigravity_Test_Audit_and_Improvement_Plan.md` | Test Audit Plan | Sep 21, 2026 | Unit & integration testing, Vitest, fake-indexeddb | Testing Plan | `IMPLEMENTED` | `src/test/setup.ts`, `src/test/` | Mocking patterns for IndexedDB, isolated memory databases, network failure simulation. | Archive to `docs/archive/plans/` & merge into `docs/engineering/TESTING.md` |
| **07** | `07_2026-09-21_Claude_Branch1_Workspace_UX_Implementation_Plan.md` | Workspace UX Plan | Sep 21, 2026 | Workspace shell, sidebar, resource adapters | Implementation Plan | `IMPLEMENTED` | `src/pages/ProjectWorkspace.tsx`, `src/lib/workspace/resourceAdapter.ts` | 4-tier pure resource adapter (`AdaptableResource`), unified workspace navigation. | Archive to `docs/archive/plans/` & merge into `docs/subsystems/WORKSPACE_AND_EDITOR.md` |
| **08** | `08_2026-09-21_Claude_Branch1_Folder_System_Implementation_Plan.md` | Folder System Plan | Sep 21, 2026 | Hierarchical folder tree, drag/drop, parent-child | Implementation Plan | `IMPLEMENTED` | `src/lib/workspace/groupResourcesByFolder.ts`, `src/hooks/useWorkspaceFolders.tsx` | Multi-level folder DAG algorithms, cascade deletion, breadcrumb computation. | Archive to `docs/archive/plans/` & merge into `docs/subsystems/WORKSPACE_AND_EDITOR.md` |
| **09** | `09_2026-09-21_Antigravity_Local_First_Architecture_Shift_ADR.md` | Architectural Decision | Sep 21, 2026 | Core persistence paradigm | Core Decision Record | `IMPLEMENTED` | `src/lib/local/db.ts`, `src/lib/repositories/` | Shift from Supabase-first to Dexie IndexedDB local-first authority with background sync. | Promoted to `docs/decisions/ADR-001-local-first-authority.md` |
| **10** | `10_2026-09-24_Claude_Workspace_Tabs_Architecture_Guide.md` | Subsystem Architecture | Sep 24, 2026 | Multi-tab editor architecture | Architecture Guide | `IMPLEMENTED` | `src/lib/workspace/workspaceTabs.ts`, `src/hooks/useWorkspaceTabs.ts` | Tab state model (`WorkspaceTab`), active tab routing, dirty tracking across open tabs. | Archive to `docs/archive/historical/` & merge into `docs/subsystems/WORKSPACE_AND_EDITOR.md` |
| **11** | `11_2026-09-24_Antigravity_Workspace_Tabs_Execution_Plan.md` (`implementation_plan_tabs_arcticture.md`) | Execution Plan | Sep 24, 2026 | 5-phase workspace tabs rollout | Implementation Plan | `IMPLEMENTED` | `src/components/ProjectWorkspace/WorkspaceTabBar.tsx` | Tab overflow handling, close confirmation guards, hotkey bindings (`Ctrl+W`, `Ctrl+Tab`). | Archive to `docs/archive/plans/` |
| **12** | `12_2026-09-24_Antigravity_PR1_Description_and_Release_Notes.md` (`PR_DESCRIPTION.md`) | Release Notes | Sep 24, 2026 | PR #1 (Workspace UX, Folders, Tabs) | Release Record | `HISTORICAL` | Workspace components | Summary of PR #1 changes and verification results. | Archive to `docs/archive/historical/` |
| **13** | `13_2026-09-24_Antigravity_PR1_Interview_Mastery_Guide_AR.md` (`ARTIX_PR1_INTERVIEW_MASTERY_AR.md`) | Technical Interview Guide | Sep 24, 2026 | Architectural reasoning, tradeoffs, Arabic mastery | Educational Reference | `IMPLEMENTED` | Workspace & Local-first subsystems | Deep rationale, distributed system tradeoffs, and technical explanations in Arabic. | Archive to `docs/archive/historical/` (Preserve permanently) |
| **14** | `14_2026-09-25_Antigravity_Offline_First_Master_Roadmap_and_Phase_A_Plan.md` | Sync Roadmap | Sep 25, 2026 | Local-first storage, Dexie schemas | Roadmap Plan | `IMPLEMENTED` | `src/lib/local/db.ts` | Local schema versioning, compound indexes `[userId+projectId]`, and repository abstraction. | Archive to `docs/archive/plans/` |
| **15** | `15_2026-09-25_Antigravity_Phase_B_UI_Cutover_and_Offline_Editing_Plan.md` | Cutover Plan | Sep 25, 2026 | Hook cutover from cloud to IndexedDB | Execution Plan | `IMPLEMENTED` | `src/hooks/useDocuments.tsx`, `useSystemDesigns.tsx` | Unidirectional local hook pattern, optimistic rendering, draft auto-recovery. | Archive to `docs/archive/plans/` |
| **16** | `ARTIX_SYNC_CORRECTNESS_HARDENING_PLAN (1).md` | Master Correctness Specification | Sep 28, 2026 | Phases C0–C12 Protocol Correctness | Core Technical Specification | `IMPLEMENTED` | `src/lib/sync/*`, `supabase/migrations/` | Invariant-based distributed sync, durable mutationId, CAS versioning, Web Locks leader, tombstone GC, Scenarios A–J test matrix. | Extracted into `docs/algorithms/*`, `docs/architecture/*`, and `docs/decisions/*` |
| **17** | `ARTIX_LOCAL_FIRST_SYNC_HARDENING_PLAN.md` | Sync Hardening Plan | Sep 26–28, 2026 | Phases 1–10 Sync Implementation | Implementation Plan | `IMPLEMENTED` | `src/lib/sync/syncEngine.ts`, `pullEngine.ts` | Change feed cursor processing, diff3 three-way text merge, push retry exponential backoff. | Extracted into `docs/algorithms/PULL_ENGINE.md` and `docs/algorithms/CONFLICT_RESOLUTION.md` |
| **18** | `Artix_Offline_First_Infrastructure_and_Synchronization_Plan.md` | Architecture Plan | Sep 25, 2026 | Initial outbox and sync engine architecture | Architecture Plan | `IMPLEMENTED` | `src/lib/sync/syncEngine.ts` | Outbox lifecycle, in-flight leasing, sync status machine, network status monitoring. | Archive to `docs/archive/plans/` |
| **19** | `docs/SYNC_PROTOCOL.md` | Protocol Specification | Sep 28, 2026 | Formal synchronization protocol | Protocol Specification | `IMPLEMENTED` | `src/lib/sync/*` | Monotonic version rules, outbox mutation algebra, cursor progression rules. | Promoted & merged into `docs/algorithms/LOCAL_FIRST_SYNC.md` & `OUTBOX.md` |
| **20** | `docs/SYNC_STATE_MACHINE.md` | State Machine Specification | Sep 28, 2026 | Entity, outbox, cursor state models | Formal Specification | `IMPLEMENTED` | `src/lib/local/types.ts` | Precise state transition matrices and invalid transition guards. | Merged into `docs/architecture/DATA_MODEL.md` & `docs/algorithms/OUTBOX.md` |
| **21** | `docs/SYNC_FAILURE_MODES.md` | Failure Analysis | Sep 28, 2026 | 14 distributed edge cases & recoveries | Distributed Systems Spec | `IMPLEMENTED` | `src/test/sync/correctnessMatrix.test.ts` | Recovery procedures for lost responses, concurrent edits, leader crashes, account switches. | Merged into `docs/algorithms/LOCAL_FIRST_SYNC.md#failure-modes` |
| **22** | `docs/SYNC_NETWORK_INVENTORY.md` | Network Inventory | Sep 28, 2026 | Complete audit of cloud calls | Audit Specification | `IMPLEMENTED` | `src/lib/sync/adapters/`, `src/hooks/` | Inventory of all Supabase REST, Realtime, and Edge Function endpoints. | Promoted to `docs/reference/NETWORK_INVENTORY.md` |
| **23** | `docs/SYNC_CORRECTNESS_IMPLEMENTATION_RECORD.md` | Release Record | Sep 28, 2026 | Post-C12 verification and PR #10 audit | Release Audit | `IMPLEMENTED` | `src/test/` | Complete verification gates, test suite results (81/81, 566 tests), PR #10 commit log. | Maintained in `docs/changelog/` & `docs/archive/` |
| **24** | `prd/ARTIX_PRODUCT_REQUIREMENTS_DOCUMENT.md` | PRD | 2026 | Product vision, workflows, requirements | Product Requirements | `CURRENT PRD` | Workspace, Editor, Canvas, AI | Defines product intent, user personas, workspace model, and feature specifications. | Retained as canonical PRD in `prd/ARTIX_PRODUCT_REQUIREMENTS_DOCUMENT.md` |
| **25** | `prd/TECHNICAL_SPECIFICATIONS.md` | Technical Spec | 2026 | High-level system requirements | Product Tech Spec | `RECONCILED` | Entire stack | Architecture stack, storage tiers, external APIs, performance benchmarks. | Reconciled and updated in `prd/TECHNICAL_SPECIFICATIONS.md` |
| **26** | `prd/VIBE_CODING_PLAYBOOK.md` | Playbook | 2026 | Prompt generation and AI coding loop | Feature Guide | `IMPLEMENTED` | `src/pages/VibeCoding.tsx` | Conversational prompt generation, context injection, and framework templating. | Retained in `prd/VIBE_CODING_PLAYBOOK.md` |
| **27** | `DOCS.md` | Monolithic Doc | Historical | Architecture, API, UI, AI, Security in single file | Competing Monolith | `SUPERSEDED` | Entire repo | Overview descriptions and feature catalogs. | Dissected and distributed into canonical `docs/*`, then replaced with redirect. |
| **28** | `SECURITY.md` & `SECURITY_AUDIT.md` | Security Policy & Audit | Hardening | RLS policies, crypto, threat model | Security Spec | `IMPLEMENTED` | `supabase/migrations/`, `src/lib/ai/crypto.ts` | Comprehensive RLS matrix, threat analysis, CSP policies, DOMPurify configuration. | `SECURITY.md` maintained at root; detailed specs placed in `docs/security/` |
| **29** | `docs/LOCAL_FIRST_ARCHITECTURE_SHIFT.md` | Architecture Shift ADR | Sep 21, 2026 | Shift to local-first IndexedDB | Architecture Decision | `IMPLEMENTED` | `src/lib/local/` | Rationale for local-first, Dexie vs SQLite-Wasm vs raw IDB. | Converted to `docs/decisions/ADR-001-local-first-authority.md` |
| **30** | `docs/PROJECT_FILE_STRUCTURE.md` | File Tree Guide | Sep 2026 | Directory organization | Architecture Guide | `UPDATED` | File system | High-level module organization map. | Integrated into `docs/architecture/CODE_ORGANIZATION.md` |
| **31** | `docs/TESTING.md` | Testing Guide | Sep 2026 | Test commands, test types, mock rules | Engineering Guide | `UPDATED` | `src/test/` | Setup instructions, test suites, and mock expectations. | Promoted & modernized in `docs/engineering/TESTING.md` |
| **32** | `docs/API.md` | API Reference | Sep 2026 | Repository and sync engine APIs | Reference Guide | `UPDATED` | `src/lib/repositories/`, `src/lib/sync/` | Repository method signatures, parameters, and return types. | Modernized in `docs/reference/API.md` |
| **33** | `docs/ARCHITECTURE.md` | Architecture Overview | Legacy | System components overview | Legacy Architecture | `SUPERSEDED` | Across `src/` | Early architectural overview prior to C0–C12 correctness hardening. | Superseded by `docs/architecture/SYSTEM.md` |
| **34** | `docs/CHALLENGES_AND_SOLUTIONS.md` | Case Studies | Legacy | Engineering challenges and fixes | Engineering Notes | `HISTORICAL` | Various | Multi-tab sync, CAS versioning, XSS sanitization, and state hydration issues. | Merged into `docs/engineering/OBSERVABILITY.md` & `docs/decisions/` |
| **35** | `PR_DESCRIPTION_OFFLINE_SYNC.md` | PR Release Notes | Sep 28, 2026 | PR #7 / PR #8 Offline sync release notes | Release Notes | `HISTORICAL` | Sync subsystem | Historical 10-phase hardening release notes. | Archive to `docs/archive/historical/` |

---

## 3. Thematic Clustering Summary

```text
1. PRODUCT INTENT & WORKSPACES
   ├── prd/ARTIX_PRODUCT_REQUIREMENTS_DOCUMENT.md
   ├── prd/TECHNICAL_SPECIFICATIONS.md
   └── prd/VIBE_CODING_PLAYBOOK.md

2. SYSTEM ARCHITECTURE & DATA MODELS
   ├── docs/architecture/OVERVIEW.md
   ├── docs/architecture/SYSTEM.md
   ├── docs/architecture/DATA_MODEL.md
   ├── docs/architecture/APPLICATION_LIFECYCLE.md
   ├── docs/architecture/CODE_ORGANIZATION.md
   └── docs/architecture/DEPENDENCY_BOUNDARIES.md

3. SYNCHRONIZATION ALGORITHMS & PROTOCOLS
   ├── docs/algorithms/LOCAL_FIRST_SYNC.md
   ├── docs/algorithms/OUTBOX.md
   ├── docs/algorithms/PULL_ENGINE.md
   ├── docs/algorithms/PUSH_ENGINE.md
   ├── docs/algorithms/CONFLICT_RESOLUTION.md
   ├── docs/algorithms/MULTI_TAB_COORDINATION.md
   └── docs/algorithms/TOMBSTONES.md

4. SUBSYSTEM IMPLEMENTATIONS
   ├── docs/subsystems/WORKSPACE_AND_EDITOR.md
   ├── docs/subsystems/SYSTEM_DESIGN.md
   ├── docs/subsystems/AI_PIPELINE.md
   ├── docs/subsystems/AUTHENTICATION_AND_SECURITY.md
   ├── docs/subsystems/BILLING_AND_LIMITS.md
   └── docs/subsystems/PWA_AND_OFFLINE.md

5. SECURITY, RLS & CRYPTOGRAPHY
   ├── docs/security/SECURITY_MODEL.md
   ├── docs/security/RLS_AND_AUTH.md
   └── docs/security/CLIENT_KEY_STORAGE.md

6. ENGINEERING & DEVELOPMENT OPERATIONS
   ├── docs/engineering/DEVELOPMENT.md
   ├── docs/engineering/TESTING.md
   ├── docs/engineering/MIGRATIONS.md
   └── docs/engineering/OBSERVABILITY.md

7. TECHNICAL REFERENCE & SCHEMAS
   ├── docs/reference/API.md
   ├── docs/reference/DATABASE_SCHEMA.md
   ├── docs/reference/ENVIRONMENT.md
   ├── docs/reference/NETWORK_INVENTORY.md
   ├── docs/reference/PROJECT_STATUS.md
   └── docs/reference/ARTIFACT_REGISTRY.md (This File)

8. ARCHITECTURAL DECISION RECORDS (ADRs)
   ├── docs/decisions/ADR-001-local-first-authority.md
   ├── docs/decisions/ADR-002-user-scoped-storage.md
   ├── docs/decisions/ADR-003-single-write-pipeline.md
   ├── docs/decisions/ADR-004-server-cas-concurrency.md
   ├── docs/decisions/ADR-005-durable-change-feed-cursor.md
   ├── docs/decisions/ADR-006-web-locks-multi-tab-coordination.md
   └── docs/decisions/ADR-007-realtime-as-wakeup-accelerator.md

9. HISTORICAL & ARCHIVED MATERIAL
   ├── docs/archive/historical/ (Artifacts 01, 02, 03, 10, 12, 13, PR descriptions)
   └── docs/archive/plans/ (Artifacts 04, 06, 07, 08, 11, 14, 15)
```
