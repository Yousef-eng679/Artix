# Artix — Branch 1 Implementation Plan
## Project Workspace & Resource Navigation Redesign

**Status:** Implementation plan only — do not implement from this document until the Pre-Implementation Codebase Audit passes.

**Repository:** `Yousef-eng679/Artix`

**Target branch:** `feat/project-workspace-ux`

**Baseline:** current `main` after the completed hardening work.

---

# 0. Executive Intent

This branch exists to fix a specific architectural/UX problem in Artix:

> A Project is currently presented as two separate lists — Documents and System Architect designs — instead of as one navigable Project Workspace.

The current experience is workable for a tiny project, but it does not scale well when a project contains many documents and designs. More importantly, the System Architect is presented as a separate tab/tool rather than as a first-class resource inside the same project context.

The objective of this branch is to establish a **usable Project Workspace shell and navigation model** before the later Local-first / IndexedDB architecture branch.

This branch is intentionally separate from the IndexedDB redesign.

---

# 1. Current-State Facts To Validate

The plan was written against the current Artix repository and must be re-checked against the exact checkout before implementation.

Current code observations:

### 1.1 Project workspace is currently tab-oriented

`src/pages/ProjectWorkspace.tsx` currently has:

- `activeTab: 'documents' | 'architect'`
- `selectedDocument`
- `selectedDesign`
- separate document and design lists
- a full-screen `Editor` path when a document is selected
- a full-screen `SystemArchitect` path when a design is selected

This means the project navigation model is currently:

```text
Project
├── Document Forge
└── System Architect
```

rather than:

```text
Project Workspace
├── Documents / resources
├── System designs / boards
└── shared project navigation
```

Source:
`src/pages/ProjectWorkspace.tsx`

GitHub:
https://github.com/Yousef-eng679/Artix/blob/main/src/pages/ProjectWorkspace.tsx

### 1.2 Documents and system designs are currently separate data domains

The current hooks are:

- `src/hooks/useDocuments.tsx`
- `src/hooks/useSystemDesigns.tsx`

The existing backend tables remain:

- `documents`
- `system_designs`

The branch must continue using those existing sources of truth.

No backend persistence rewrite is part of this branch.

### 1.3 System Architect already accepts document context

The current `ProjectWorkspace` passes document information into `SystemArchitect`.

This is an important existing integration seam.

Do not remove or bypass it.

The UX redesign should strengthen the relationship between documents and boards without rewriting the internal Architect engine.

### 1.4 Existing editor/autosave behavior is already hardened

The current project contains hardened save/recovery infrastructure including:

- debounced saving
- serialized save queueing
- draft recovery
- before-unload handling

The Branch 1 implementation must preserve these behaviors.

Relevant files include:

- `src/lib/autosave.ts`
- `src/lib/cache/debouncedSave.ts`
- `src/lib/cache/draftRecovery.ts`
- `src/lib/cache/saveQueue.ts`

No autosave redesign is in scope here.

### 1.5 Dashboard already has a global sidebar

`src/components/DashboardSidebar.tsx` already establishes an Artix navigation language.

The project workspace should feel consistent with it, but the dashboard sidebar should NOT simply be reused as the project navigation structure unless the agent verifies that the component boundaries are appropriate.

The project sidebar has a different semantic job:

> It navigates resources inside one project.

---

# 2. Architectural Goal

The branch should introduce a **Project Workspace shell** that treats documents and system designs as two resource types inside one navigable project.

Conceptual model:

```text
                         Artix Project
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
         Navigation        Workspace         Resource
            │               Content           Context
            │                 │                 │
        Sidebar           Editor / Board      Metadata
            │
      ┌─────┼─────┐
      │     │     │
   Overview Docs Designs
```

The critical architectural idea is:

> **Tools are not the resource hierarchy.**

`Document Forge` and `System Architect` are capabilities/editors.

Documents and boards are project resources.

The user should be able to move among those resources without losing project context.

---

# 3. Branch Scope

## In scope

### A. Project workspace shell

Create a persistent project-level layout containing:

```text
Project header
Project sidebar
Main workspace area
```

The sidebar must remain visible while navigating resources on desktop.

### B. Unified resource navigation

Create a frontend-only normalized resource model that can represent:

```text
Document
System Design / Board
```

Example conceptual type:

```ts
type WorkspaceResource =
  | {
      kind: 'document';
      id: string;
      projectId: string;
      title: string;
      updatedAt: string;
    }
  | {
      kind: 'design';
      id: string;
      projectId: string;
      title: string;
      updatedAt: string;
    };
```

The exact shape MUST be verified against the live codebase before implementation.

This is a UI/view-model abstraction.

It is NOT a replacement for the existing backend models.

### C. Sidebar navigation

The project sidebar should provide a scalable navigation surface.

Minimum structure:

```text
PROJECT
  Overview
  Documents
  Designs

RECENT
  recent resources

PROJECT TOOLS
  New Document
  New Design
```

The exact visual hierarchy may evolve after implementation validation, but the semantic responsibilities must remain.

### D. Resource counts

Show lightweight counts for:

- documents
- designs

Counts must come from actual loaded data, not hard-coded values.

### E. Search/filter within the project

Provide a practical way to locate resources when the number grows.

For Branch 1, the preferred implementation is client-side filtering over already loaded project resources.

Do not add a new backend search service for this branch.

The filtering behavior must be deterministic and case-insensitive.

### F. Unified resource list / tree presentation

The workspace should not show two isolated full-page lists.

Instead, the sidebar and main area should support:

```text
Documents
  ├── PRD
  ├── Requirements
  └── Notes

Designs
  ├── System Architecture
  └── API Flow
```

The grouping can initially be type-based.

**Custom persistent user-created folders are explicitly deferred to the Local-first branch unless the codebase audit proves there is already an existing stable folder model that can be reused without introducing new persistence architecture.**

### G. Architect + document coexistence

Opening a board must not conceptually leave the project.

The project sidebar should still be available.

The user must be able to move:

```text
Board
  → Document
  → Board
  → Document
```

without returning to the project card/list page between resources.

### H. URL/deep-link state

The workspace selection must survive refresh and allow a resource to be addressed directly.

Preferred Branch 1 mechanism:

- preserve the existing `/projects/:id` route
- use explicit search parameters for the selected resource

Example concept:

```text
/projects/:projectId?doc=:documentId
/projects/:projectId?design=:designId
```

The exact parameter names must be confirmed against current routing/action behavior before implementation.

Existing `action=` behavior must continue to work.

---

# 4. Explicit Non-Goals

The following are NOT part of Branch 1.

## 4.1 IndexedDB

Do not implement IndexedDB here.

## 4.2 Offline-first persistence

Do not redesign the persistence layer.

## 4.3 Sync engine / outbox

Do not create:

- outbox
- sync queue for server synchronization
- conflict-resolution engine
- retry orchestration for offline sync

Those belong to Branch 2.

## 4.4 Migration from localStorage to IndexedDB

Do not migrate:

- documents
- boards
- drafts
- project data

to IndexedDB in this branch.

AI/API settings may continue using the existing localStorage-based implementation.

## 4.5 GitHub integration

Do not begin GitHub repository/branch/commit synchronization.

GitHub will be designed after the Local-first architecture is stable.

## 4.6 AI context-management redesign

Do not rewrite the AI context engine in this branch.

The workspace model should make future context retrieval possible, but this branch is not the implementation of that system.

## 4.7 New backend search infrastructure

Do not add Elasticsearch, a new search API, RPC search service, or similar infrastructure.

## 4.8 New folder persistence architecture

Do not create a large generic folder/collection database model merely to mimic Obsidian.

Persistent custom folders are a later architecture decision.

## 4.9 Rewrite of Editor or System Architect

Do not redesign the internals of:

- `Editor`
- `SystemArchitect`

unless a narrowly scoped adapter change is required to support the workspace shell.

Their current editing and save semantics must remain intact.

---

# 5. Design Principles

## 5.1 One project context

When the user opens a resource, the project remains the active context.

Bad:

```text
Project list
   ↓
Document page
   ↓
Back to project
   ↓
Architect page
```

Preferred:

```text
Project Workspace
├── Sidebar
│
└── Main
     ├── Document
     └── Board
```

## 5.2 Resource-first, tool-second

The project contains resources.

Editors/tools operate on resources.

```text
Resource
   ↓
appropriate editor
```

not:

```text
Tool
   ↓
its own isolated universe
```

## 5.3 Existing backend remains authoritative

Branch 1 should read/write the current data model.

Do not invent a second server-side source of truth.

## 5.4 UI normalization without database normalization

A common frontend abstraction is allowed:

```text
Document + SystemDesign
          ↓
WorkspaceResource
```

But do not force the backend tables into a new generalized schema in this branch.

## 5.5 Minimal diff

Prefer small, composable components over a giant rewrite of `ProjectWorkspace.tsx`.

## 5.6 Preserve working behavior

Existing:

- create
- rename
- delete
- save
- autosave
- draft recovery
- Architect editing
- document editing
- usage limits
- authentication

must continue to work.

---

# 6. Proposed Component Architecture

The final names must be validated against current project conventions.

Possible structure:

```text
src/
├── pages/
│   └── ProjectWorkspace.tsx
│
├── components/
│   └── ProjectWorkspace/
│       ├── ProjectWorkspaceLayout.tsx
│       ├── ProjectWorkspaceSidebar.tsx
│       ├── WorkspaceResourceList.tsx
│       ├── WorkspaceResourceItem.tsx
│       ├── WorkspaceSearch.tsx
│       ├── WorkspaceHeader.tsx
│       └── workspaceTypes.ts
│
└── hooks/
    └── useProjectWorkspace.ts
```

This is a proposal, not a mandatory file list.

The agent MUST inspect the repository before creating these files.

Avoid creating a component solely to wrap a trivial 5–10 line fragment.

---

# 7. Responsibility Boundaries

## `ProjectWorkspace.tsx`

Responsible for:

- project identity
- authentication / route access
- composition
- resource selection state
- connecting existing document/design hooks to workspace presentation

It should NOT become a dumping ground for:

- sidebar rendering
- filtering logic
- resource normalization
- keyboard handling
- every menu action

These responsibilities should be split into focused modules.

## Workspace adapter

Responsible for converting existing:

```text
documents[]
systemDesigns[]
```

into a common navigation representation.

It should be a pure transformation where possible.

Example:

```text
Document[] + SystemDesign[]
        ↓
WorkspaceResource[]
```

Pure transformations should be unit tested.

## Workspace sidebar

Responsible only for:

- navigation presentation
- selection
- grouping
- search/filter UI
- new-resource commands

It should not directly call Supabase.

## Existing hooks

Continue to own data access:

- `useDocuments`
- `useSystemDesigns`
- `useProjects`
- existing auth/usage hooks

Do not move Supabase calls into visual components.

## Existing editors

Continue to own editing behavior:

- `Editor`
- `SystemArchitect`

The workspace selects which editor is active and supplies the existing callbacks.

---

# 8. Navigation State Model

The workspace needs one explicit source of truth for navigation.

Conceptually:

```ts
type WorkspaceSelection =
  | { kind: 'none' }
  | { kind: 'document'; id: string }
  | { kind: 'design'; id: string };
```

The URL should mirror that selection.

Required invariants:

1. At most one resource is selected.
2. The selected resource MUST belong to the current project.
3. A stale/missing resource selection falls back safely to the project overview.
4. Back navigation removes the resource selection but does not leave the project.
5. Refresh restores the same selected resource when it still exists.

Do not maintain independent overlapping states such as:

```text
selectedDocument
selectedDesign
activeTab
```

unless the codebase audit proves a compatibility reason that requires transitional state.

The new design should converge toward a single selection model.

---

# 9. Project Overview

When no resource is selected:

```text
┌───────────────┬────────────────────────────────────┐
│ Project       │ Project Overview                    │
│ sidebar       │                                    │
│               │ Summary                             │
│ Overview      │ Recent resources                    │
│ Documents     │ Quick actions                       │
│ Designs       │                                     │
│               │                                     │
│ Recent        │                                     │
└───────────────┴────────────────────────────────────┘
```

The overview does not need to become another analytics dashboard.

It should be a lightweight navigation landing page.

---

# 10. Document Navigation

When a document is selected:

```text
┌───────────────┬────────────────────────────────────┐
│ Workspace     │ Document Editor                    │
│ sidebar       │                                    │
│               │ existing Editor component          │
│ Documents     │                                    │
│  • PRD        │                                    │
│  • Notes      │                                    │
│ Designs       │                                    │
│  • System     │                                    │
└───────────────┴────────────────────────────────────┘
```

The Editor remains responsible for its editing/autosave behavior.

The workspace is responsible for context and navigation.

---

# 11. System Architect Navigation

When a design is selected:

```text
┌───────────────┬────────────────────────────────────┐
│ Workspace     │ System Architect                   │
│ sidebar       │                                    │
│               │ existing SystemArchitect           │
│ Documents     │ component                           │
│ Designs       │                                    │
│  • System     │                                    │
│  • API Flow   │                                    │
└───────────────┴────────────────────────────────────┘
```

The important UX requirement is:

> The Architect editor occupies the workspace content area while the user remains in the same project workspace.

No separate project-level universe.

---

# 12. Document ↔ Design Relationship Surface

Branch 1 may provide a lightweight relationship affordance without implementing a full graph database.

Examples:

```text
Current resource
  Related project resources
  Recent resources
```

However:

**Do NOT invent automatic semantic links.**

Do not claim:

```text
"Requirements.md is related to System Architecture"
```

unless the current product already stores that relation or the user explicitly creates it.

For Branch 1, a simple "other resources in this project" context is acceptable.

True explicit links/relations can be designed alongside the future Local-first model.

---

# 13. Search Behavior

Project search should:

- operate only within the current project
- search document titles and design names
- be case-insensitive
- update without network calls
- preserve the current selection if it remains valid
- never mutate project data

Example:

```text
Search: "auth"

Documents
  Authentication Requirements
  Auth API Notes

Designs
  Authentication Flow
```

Search should not become an AI semantic search system in Branch 1.

---

# 14. Sorting

Default navigation ordering:

1. recent update time
2. stable deterministic tie-breaker by title/name

However, if the current project already has a user-visible ordering expectation, the agent must preserve it or explicitly document the change.

Do not introduce drag-and-drop ordering persistence in Branch 1.

---

# 15. Responsive Design

Desktop:

```text
Sidebar | Workspace content
```

Mobile:

```text
Top bar
  ↓
Collapsible / sheet navigation
  ↓
Workspace content
```

The existing dashboard already has mobile navigation patterns that may be reused conceptually.

The implementation must remain keyboard-accessible.

---

# 16. Accessibility Requirements

The new sidebar must:

- expose navigation semantics
- use buttons/links for interactive items
- have visible focus states
- provide accessible labels for icon-only controls
- preserve keyboard navigation
- not rely solely on hover
- keep the selected resource visually identifiable

Keyboard expectations:

- Tab reaches sidebar controls
- Enter/Space activates a resource
- Escape closes mobile navigation where relevant

Do not implement a custom keyboard-navigation framework when native semantics already solve the problem.

---

# 17. Visual Requirements

Use the existing Artix visual language.

Do not introduce:

- a new color system
- a second design system
- new UI frameworks
- arbitrary hard-coded color palettes
- unnecessary gradients just to "make it look futuristic"

Prefer existing semantic tokens and existing shadcn/ui primitives.

The workspace should feel like the existing Artix product, but with stronger information architecture.

---

# 18. Compatibility Requirements

The implementation MUST preserve:

### Authentication

Unauthenticated users must continue to be redirected according to current behavior.

### Project validation

Invalid project IDs must still fail safely.

### Usage limits

The existing document/design creation limits continue to apply.

Do not move or duplicate quota enforcement into the sidebar.

### Existing `action=` flows

Current actions such as:

```text
?action=new-document
?action=new-design
?action=new-vibe
```

must continue to function unless the code audit proves a different compatibility-safe mechanism is required.

### Existing editor save behavior

Do not change the save callback contract merely to support navigation.

### Existing design save behavior

Do not change board persistence semantics merely to support navigation.

---

# 19. Strict Implementation Restrictions

These are hard constraints.

## R1 — No IndexedDB

No IndexedDB package or database implementation.

## R2 — No offline sync rewrite

No outbox, sync engine, merge engine, conflict engine, or offline mutation queue.

## R3 — No GitHub implementation

No GitHub API integration.

## R4 — No AI provider rewrite

Do not modify:

- provider registry behavior
- API key storage architecture
- Ollama architecture
- prompt engine
- context compression
- refinement engine

except for a compile-time or navigation integration issue that is directly required by the workspace changes.

## R5 — No broad Supabase schema redesign

Do not replace:

```text
documents
system_designs
```

with a generalized server-side resources table.

Do not create a new persistence architecture.

## R6 — No destructive migration

No migration may:

- delete user documents
- delete system designs
- rewrite existing IDs
- silently drop metadata/content

## R7 — No duplicated source of truth

Do not introduce:

```text
sidebar documents state
+
independent fake document store
```

The sidebar must derive from the existing project data.

## R8 — No hidden network calls from UI presentation

Sidebar rendering/search/filtering must not issue Supabase queries.

## R9 — No editor rewrite

Do not refactor Monaco/editor internals unless explicitly required by a verified integration boundary.

## R10 — No Architect rewrite

Do not rewrite React Flow / System Architect internals.

## R11 — No broad cleanup

Do not refactor unrelated files because they "could be cleaner."

## R12 — No dependency additions without proof

Do not install a new dependency unless:

1. the current codebase has no suitable primitive,
2. the dependency is strictly necessary,
3. the implementation plan is updated with the reason.

A dependency added solely for convenience is prohibited.

## R13 — No speculative abstractions

Do not create generalized abstractions for future GitHub/IndexedDB/AI behavior.

Build only the abstraction needed for this branch.

## R14 — No fake hierarchy

Do not claim to implement custom folders if the branch only implements type-based grouping.

Be explicit about the boundary.

---

# 20. Pre-Implementation Codebase Audit — MANDATORY

Before changing any code, the agent MUST perform a read-only comparison between this plan and the actual repository.

The agent must inspect at minimum:

```text
src/pages/ProjectWorkspace.tsx
src/App.tsx
src/hooks/useDocuments.tsx
src/hooks/useSystemDesigns.tsx
src/hooks/useProjects.tsx
src/components/Editor/Editor.tsx
src/components/SystemArchitect/SystemArchitect.tsx
src/components/DashboardSidebar.tsx
src/lib/autosave.ts
src/lib/cache/debouncedSave.ts
src/lib/cache/draftRecovery.ts
src/lib/cache/saveQueue.ts
relevant existing tests
routing configuration
```

The agent should also search for:

```text
selectedDocument
selectedDesign
activeTab
?action=
new-document
new-design
new-vibe
ProjectWorkspace
SystemArchitect
```

### Audit questions

The agent must verify:

1. Is the current workspace route still `/projects/:id`?
2. Does `ProjectWorkspace` still use separate document/design state?
3. Does `SystemArchitect` still accept document context?
4. Are there additional workspace entry points not listed in this plan?
5. Are there hidden route/action dependencies?
6. Does the Editor rely on being full-screen?
7. Does the SystemArchitect rely on being full-screen?
8. Are there tests that assert the current two-tab structure?
9. Are there existing reusable tree/sidebar primitives?
10. Are there current CSS/layout constraints that could make a persistent sidebar unsafe?
11. Does any other feature navigate directly to documents/designs?
12. Are there database constraints that would be affected by resource grouping?
13. Does any current data already expose a stable ordering/folder concept?

### Audit output

Before implementation, produce a short validation report containing:

```text
Plan item
Current code evidence
Status: VERIFIED / DIFFERENT / BLOCKED
Required plan adjustment
Risk
```

The report must explicitly identify any material mismatch.

---

# 21. Audit Stop Conditions

The agent MUST NOT start implementation if any of the following is discovered:

### STOP A
The proposed navigation model would require an unplanned destructive data migration.

### STOP B
The current routing contract conflicts with the proposed URL state in a way that could break existing links.

### STOP C
The current Editor or SystemArchitect architecture fundamentally requires full-page isolation and cannot safely coexist with a workspace shell without a larger rewrite.

### STOP D
A hidden dependency exists that makes the branch substantially larger than the defined scope.

### STOP E
The existing codebase already contains a workspace/resource abstraction that makes the proposed architecture redundant or contradictory.

### STOP F
A required change would force an IndexedDB/persistence redesign to be introduced early.

In any stop condition:

> Pause implementation and revise the plan first.

Do not code around an architectural contradiction.

---

# 22. Recommended Implementation Sequence

Only after the audit passes.

## Phase 1 — Workspace view model

Create the smallest pure adapter that converts:

```text
documents[]
designs[]
```

to:

```text
WorkspaceResource[]
```

Requirements:

- no Supabase calls
- deterministic ordering
- explicit `kind`
- explicit project ownership
- no duplicated content storage

Add unit tests first.

---

## Phase 2 — Workspace shell

Introduce:

```text
ProjectWorkspaceLayout
ProjectWorkspaceSidebar
main workspace area
```

Initially keep the existing list behavior intact where possible.

Do not rewrite the editors yet.

---

## Phase 3 — Sidebar navigation

Add:

- Overview
- Documents
- Designs
- Recent
- New Document
- New Design

Use the normalized resource view model.

---

## Phase 4 — Resource selection

Replace overlapping state such as:

```text
activeTab
selectedDocument
selectedDesign
```

with one explicit workspace-selection mechanism where safe.

Keep compatibility adapters temporarily if required.

---

## Phase 5 — URL synchronization

Mirror selection in the URL.

Required behavior:

```text
open resource
   ↓
URL changes

refresh
   ↓
resource remains open

Back
   ↓
resource closes
project remains open
```

Preserve existing `action=` semantics.

---

## Phase 6 — Embed existing editors

Connect:

```text
document resource
    ↓
existing Editor

design resource
    ↓
existing SystemArchitect
```

Do not rewrite their internal behavior.

The workspace owns navigation; the editor owns editing.

---

## Phase 7 — Search/filter

Add project-local search over titles/names.

Do this after the resource adapter exists.

---

## Phase 8 — Responsive behavior

Desktop:

```text
persistent sidebar
```

Mobile:

```text
sheet/drawer navigation
```

Reuse existing design primitives.

---

## Phase 9 — Regression tests

Add tests before broad visual polishing.

---

## Phase 10 — Manual UX verification

Test with a project containing:

```text
50+ documents
20+ system designs
```

The test data can be local/test fixtures.

The objective is to verify that the workspace remains navigable when the resource count is large.

---

# 23. Testing Strategy

## 23.1 Unit tests

Test the pure resource adapter:

```text
documents + designs
        ↓
WorkspaceResource[]
```

Cases:

- empty project
- documents only
- designs only
- mixed project
- duplicate titles
- equal timestamps
- invalid/missing fields if type system permits
- deterministic ordering

## 23.2 Component tests

Test:

### Sidebar

- renders groups
- shows counts
- selects resources
- filters resources
- preserves selected state

### Resource item

- correct icon/type
- correct title
- accessible label
- selected state

### Workspace selection

- document selection
- design selection
- overview state
- stale selection recovery

## 23.3 Integration tests

Test:

```text
click document
  → Editor opens
  → sidebar remains
  → current project remains correct
```

and:

```text
click design
  → SystemArchitect opens
  → sidebar remains
  → current project remains correct
```

## 23.4 URL tests

Test:

```text
/open document URL
refresh
document remains selected
```

and:

```text
/open design URL
refresh
design remains selected
```

Also test old `action=` routes.

## 23.5 Regression tests

At minimum:

- create document
- rename document
- delete document
- create design
- rename design
- delete design
- edit/save document
- edit/save design
- existing draft recovery tests
- existing CI suite

## 23.6 E2E

At least one realistic workspace navigation test should use many resources.

The purpose is not performance benchmarking.

The purpose is to expose usability regressions caused by scaling assumptions.

---

# 24. Acceptance Criteria

Branch 1 is complete only when all of the following are true.

## Navigation

- [ ] The project has a persistent project-level navigation surface on desktop.
- [ ] Documents and system designs appear in one coherent workspace.
- [ ] The System Architect is no longer an isolated project-level mode.
- [ ] A user can move between a document and a design without leaving the project workspace.
- [ ] The selected resource remains identifiable.

## Scalability

- [ ] The sidebar remains usable with dozens of resources.
- [ ] The user does not need to scroll through one giant undifferentiated list to find a resource.
- [ ] Project-local search/filter works without network calls.
- [ ] Counts are real and derived from project data.

## Compatibility

- [ ] Existing project routes continue to work.
- [ ] Existing `action=` flows continue to work.
- [ ] Document create/rename/delete still works.
- [ ] Design create/rename/delete still works.
- [ ] Existing Editor save behavior works.
- [ ] Existing System Architect save behavior works.
- [ ] Draft recovery remains intact.
- [ ] Authentication behavior remains intact.
- [ ] Usage limits remain enforced.

## Architecture

- [ ] Sidebar presentation does not contain Supabase calls.
- [ ] Document/design data still comes from the existing hooks.
- [ ] No second persistence store is introduced.
- [ ] No IndexedDB implementation is introduced.
- [ ] No GitHub integration is introduced.
- [ ] No broad AI layer rewrite is introduced.
- [ ] No destructive schema/data migration is introduced.

## Quality

- [ ] Type-check passes.
- [ ] Lint passes.
- [ ] Unit/component tests pass.
- [ ] E2E workspace navigation test passes.
- [ ] Manual testing with a large resource set passes.

---

# 25. Verification Commands

Use the actual project scripts from `package.json`.

Expected baseline checks:

```bash
npm run lint
npm test
npm run build
```

If type-checking is available independently:

```bash
npx tsc --noEmit
```

If E2E tests are wired into CI:

```bash
npm run test:e2e
```

The agent must not claim success from a command it did not actually run.

---

# 26. Commit Strategy

Prefer focused commits.

Suggested sequence:

```text
refactor(workspace): add resource view model
feat(workspace): add project workspace shell
feat(workspace): add persistent project sidebar
feat(workspace): unify document and design navigation
feat(workspace): preserve editor and architect context
feat(workspace): add project resource search
test(workspace): add navigation and regression coverage
```

Do not create one massive "rewrite ProjectWorkspace" commit.

Each commit should leave the project buildable whenever practical.

---

# 27. Review Checklist Before Merge

The branch must be reviewed against the original problem:

> Is the project now a usable workspace for a growing number of resources?

Do not approve the branch merely because:

- the sidebar looks attractive,
- tabs were renamed,
- components were split,
- the page became more visually modern.

The review must verify information architecture.

A successful result should feel like:

```text
Project
│
├── Sidebar
│   ├── Overview
│   ├── Documents
│   ├── Designs
│   └── Recent
│
└── Main workspace
    ├── Document Editor
    └── System Architect
```

rather than:

```text
Project
├── Tab A
│   └── list of documents
└── Tab B
    └── list of designs
```

---

# 28. Why This Branch Comes Before IndexedDB

The Local-first branch will eventually redesign:

- persistence
- resource storage
- local durability
- sync
- recovery
- cross-tab coordination
- conflict handling
- future GitHub integration

It is therefore useful to establish and validate the **user-facing workspace model first**.

The sequence is:

```text
Current main
    ↓
Branch 1
Project Workspace / UX redesign
    ↓
Manual + automated verification
    ↓
Merge into main
    ↓
new stable baseline
    ↓
Branch 2
Local-first / IndexedDB architecture
```

Branch 2 should consume the validated workspace concepts rather than inventing them while simultaneously changing the persistence model.

---

# 29. Future Compatibility Requirements for Branch 2

Even though Branch 1 does not implement IndexedDB, it must avoid making Branch 2 harder.

Therefore:

### Do

Create clean conceptual boundaries around:

```text
resource selection
resource presentation
resource type
resource metadata
```

### Do not

Hard-code assumptions such as:

```text
"documents can only exist in Document Forge"
"boards can only exist in System Architect"
```

The UI should treat them as project resources.

That means the later architecture can map:

```text
Document
Board
Task
Research item
Future resource types
```

into a Local-first resource system without replacing the entire UX again.

---

# 30. Relationship With Future AI Context Architecture

Branch 1 does not fix the AI context engine.

However, this branch should leave enough structure for future context assembly.

Future conceptual flow:

```text
Current resource
      ↓
project resources
      ↓
explicit relations
      ↓
relevant context
      ↓
context builder
      ↓
AI provider
```

For Branch 1, only the first two layers are relevant.

Do not implement semantic relevance ranking, embeddings, RAG, or automatic relationship inference here.

---

# 31. Final Agent Directive

This document is an implementation plan with strict architectural boundaries.

The agent must follow this order:

```text
1. READ PLAN
      ↓
2. READ ACTUAL CODEBASE
      ↓
3. COMPARE PLAN vs CODE
      ↓
4. PRODUCE VALIDATION REPORT
      ↓
5. CHECK STOP CONDITIONS
      ↓
6. ADJUST PLAN IF NECESSARY
      ↓
7. ONLY THEN IMPLEMENT
      ↓
8. RUN TESTS
      ↓
9. RUN MANUAL UX VERIFICATION
      ↓
10. REPORT EXACTLY WHAT PASSED / FAILED
```

The agent must **not** start coding merely because the plan appears internally consistent.

The real repository is the authority on current implementation details.

If the plan and code disagree:

> **Code inspection wins. The plan must be corrected before implementation continues.**

The agent must not silently invent missing repository facts.

---

# 32. Definition of Success

The branch succeeds when Artix stops behaving like:

```text
a project page containing two unrelated lists
```

and starts behaving like:

```text
a project workspace
with coherent resource navigation
and both documents and system designs
living inside the same project context.
```

The branch should improve practical usability without prematurely committing Artix to the future IndexedDB architecture.

The next major architectural step happens only after this branch is verified and merged.
