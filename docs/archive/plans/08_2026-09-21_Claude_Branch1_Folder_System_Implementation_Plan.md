# Artix — Project Workspace Folder System + UX Simplification
## Final Implementation Plan — Branch 1 Extension

---

## 0. Execution Context

This plan extends the current **Branch 1** workspace work on:

```text
feat/project-workspace-ux
```

The goal is to finish the workspace as a real **project-oriented development
workspace**, not merely polish the existing dashboard-like screen.

Important current-code audit facts from the repository baseline:

- `src/pages/ProjectWorkspace.tsx` originally owned the document/design tabs,
  resource selection, creation, rename, delete, and editor mounting.
- `src/hooks/useDocuments.tsx` queries `documents` by `project_id` and exposes
  create/update/delete mutations.
- `src/hooks/useSystemDesigns.tsx` queries `system_designs` by `project_id`
  and exposes create/update/delete mutations.
- `src/integrations/supabase/types.ts` is the generated database contract.
- Existing documents and system designs already belong to projects.
- The current local-first architecture direction is intentionally deferred;
  this branch continues using Supabase for persistence and localStorage only
  for existing small settings/preferences.

At the time this plan was prepared, the remote `feat/project-workspace-ux`
branch still pointed at the hardening baseline while the workspace UI shown
during manual testing was being exercised locally. Therefore the implementing
agent MUST inspect the actual working tree before editing and must not assume
that remote line numbers represent the current local implementation.

---

# 1. Goals

## G-01 — Introduce a Real Project Folder Hierarchy

Replace the flat project resource model:

```text
Project
├── Documents
└── System Designs
```

with a semantic hierarchy:

```text
Project
├── Root Resources
│   ├── Documents
│   └── Designs
│
└── Folders / Project Areas
    ├── Authentication
    │   ├── Documents
    │   └── Designs
    │
    ├── Payments
    │   ├── Documents
    │   └── Designs
    │
    └── Deployment
        ├── Documents
        └── Designs
```

A folder represents a **project area / feature / subsystem**, not a resource
type.

---

## G-02 — Make the Sidebar the Primary Project Navigation Surface

The sidebar should answer:

> "What is inside this project and where am I working?"

It should not behave like a second dashboard.

Target:

```text
Project
Search

Overview

FOLDERS
▼ Authentication
   Document
   Document
   Design

▼ Payments
   Document
   Design

▶ Deployment

ROOT
   Document
   Design

+ New Folder
```

The sidebar owns navigation and organization.

---

## G-03 — Reduce Visual Noise in the Overview

The current overview contains repeated information:

```text
Statistics
+ Create Document
+ New Design
Recent Activity
```

while the sidebar already contains the same resources and actions.

The new overview should be intentionally lightweight:

```text
Project title
Short description

Resource summary
7 resources · 4 documents · 3 designs

Continue working / Recent
[resource]
[resource]
[resource]
```

No second "dashboard inside the project".

---

## G-04 — Preserve the Existing Resource Lifecycle

The following must continue to work:

```text
URL selection
Editor
SystemArchitect
Autosave
SaveQueue
Draft recovery
Optimistic locking
Create / rename / delete
Usage limits
Browser Back / Forward
```

The folder feature is an organizational layer around existing resources. It is
not a rewrite of document or board persistence.

---

## G-05 — Keep Future Local-First Migration Clean

Folders must not be designed in a way that blocks Branch 2.

The domain model should remain compatible with:

```text
Local Repository
    ↓
IndexedDB
    ↓
Outbox
    ↓
Sync Engine
    ↓
Supabase
```

Therefore folder membership must be explicit, deterministic, and represented
as normal domain data rather than hidden UI state.

---

# 2. Engineering Rationale

### Why folders?

The project model should follow how software is actually organized.

A developer usually thinks:

```text
Authentication
Payments
Notifications
Infrastructure
```

and then wants the relevant specifications and architecture together.

Therefore:

```text
Folder
├── PRD
├── API specification
└── Architecture
```

is a better semantic unit than:

```text
Documents
└── PRD
System Designs
└── Architecture
```

### Why one-level folders initially?

Nested folders would introduce:

```text
parent_id
recursive tree traversal
move-to-subfolder rules
cyclic hierarchy prevention
breadcrumb navigation
recursive delete semantics
```

None of that is necessary to solve the user's actual organizational problem.

Initial model:

```text
Project
├── Folder A
├── Folder B
└── Folder C
```

A folder contains resources, but folders do not contain folders.

This gives useful hierarchy without turning Artix into a generic file manager.

### Why persistent backend folders?

A UI-only folder system would disappear on refresh or across devices and would
therefore be fake organization.

The folder relationship must be persistent.

---

# 3. Scope

## In Scope

### Folder Domain

- Create folder
- Rename folder
- Delete folder
- Assign document to folder
- Assign design to folder
- Move document between folders
- Move design between folders
- Move resource to project root
- Persist folder membership
- Folder-specific resource grouping
- Folder counts
- Collapsible folder groups
- Search within project resources
- Recent resources without sidebar duplication
- Overview visual simplification

### Workspace UX

- Cleaner sidebar
- Folder-first hierarchy
- Lower information density
- Content-first overview
- No duplicated resource lists
- Existing Editor/SystemArchitect remain integrated
- Existing deep links remain valid

---

## Explicitly Out of Scope

```text
❌ Nested folders
❌ Drag-and-drop tree reordering
❌ File import/export redesign
❌ IndexedDB
❌ Offline sync engine
❌ Outbox redesign
❌ Supabase synchronization redesign
❌ AI context redesign
❌ Excalidraw integration
❌ GitHub integration
❌ New backend resource types
❌ Editor internals rewrite
❌ SystemArchitect internals rewrite
❌ Global Dashboard redesign
```

The only dashboard-like surface being simplified is the **Project Workspace
Overview**, because that is part of the workspace experience.

---

# 4. Target Architecture

```text
                           PROJECT
                              │
                ┌─────────────┴─────────────┐
                │                           │
                ▼                           ▼
          ROOT RESOURCES                 FOLDERS
                │                           │
        ┌───────┴───────┐           ┌───────┼────────┐
        ▼               ▼           ▼       ▼        ▼
   Documents         Designs     Auth   Payments   Deployment
                                      │
                              ┌───────┴───────┐
                              ▼               ▼
                          Documents        Designs
```

---

# 5. Domain Model

## 5.1 Workspace Folder

Add a new persistent entity:

```ts
export interface WorkspaceFolder {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
```

Database fields:

```text
workspace_folders
├── id UUID PK
├── project_id UUID NOT NULL
├── user_id UUID NOT NULL
├── name TEXT NOT NULL
├── created_at timestamptz
└── updated_at timestamptz
```

`user_id` is retained because the existing application consistently uses
`auth.uid() = user_id` RLS boundaries.

---

## 5.2 Resource Membership

Add nullable folder membership:

```text
documents.folder_id
system_designs.folder_id
```

Semantics:

```text
folder_id = UUID → resource is inside that folder
folder_id = NULL → resource remains at project root
```

Do NOT delete resources when deleting folders.

Folder deletion must move its resources to root.

---

# 6. Database Integrity Design

## 6.1 Migration

Create a new Supabase migration under:

```text
supabase/migrations/
```

Use a new timestamped filename. Do not edit a historical migration.

Conceptually:

```sql
CREATE TABLE public.workspace_folders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (id, project_id)
);
```

Enable RLS and create policies equivalent to the existing project/resource
security model:

```text
SELECT  → auth.uid() = user_id
INSERT  → auth.uid() = user_id
UPDATE  → auth.uid() = user_id
DELETE  → auth.uid() = user_id
```

Add the update timestamp trigger using the project's existing
`update_updated_at_column()` convention.

Then add nullable membership fields:

```sql
ALTER TABLE public.documents
ADD COLUMN folder_id UUID NULL;

ALTER TABLE public.system_designs
ADD COLUMN folder_id UUID NULL;
```

Do NOT simply use a foreign key on `folder_id` alone. The relationship must
preserve project isolation.

Use a composite foreign key:

```text
documents:
(folder_id, project_id)
        ↓
workspace_folders:
(id, project_id)
```

and the same for `system_designs`.

Deletion rule:

```text
workspace folder deleted
        ↓
resources are preserved
        ↓
folder_id becomes NULL
        ↓
resources appear in ROOT
```

Use `ON DELETE SET NULL`.

This prevents accidental resource destruction.

---

# 7. Generated Supabase Type Contract

Update:

```text
src/integrations/supabase/types.ts
```

to include:

```text
workspace_folders
```

and the new nullable:

```text
documents.folder_id
system_designs.folder_id
```

Do not hand-edit unrelated generated definitions.

The agent should first determine how this repository normally regenerates
Supabase types and use the existing project mechanism.

---

# 8. Data Hooks

## 8.1 New Hook

Create:

```text
src/hooks/useWorkspaceFolders.tsx
```

Responsibilities:

```text
query folders by project
create folder
rename folder
delete folder
```

Query key:

```ts
['workspace_folders', projectId]
```

All operations must be project-scoped.

---

## 8.2 Document Hook Changes

Modify:

```text
src/hooks/useDocuments.tsx
```

Required changes:

```text
query returns folder_id
create accepts folderId?
update accepts folder_id
```

Example conceptual mutation:

```ts
updateDocument({
  id,
  folder_id: folderId
});
```

A `null` folder ID means move to root.

Do not change document content persistence behavior.

---

## 8.3 System Design Hook Changes

Modify:

```text
src/hooks/useSystemDesigns.tsx
```

Required changes:

```text
query returns folder_id
create accepts folderId?
update accepts folder_id
```

Do not modify board-state persistence.

---

# 9. Type / View-Model Changes

## 9.1 Workspace Resource

Extend:

```ts
export interface WorkspaceResource {
  id: string;
  projectId: string;
  title: string;
  kind: 'document' | 'design';
  updatedAt: string;
  createdAt?: string;
  folderId: string | null;
  meta?: {
    format?: string;
    nodeCount?: number;
  };
}
```

No raw document/design objects.

---

## 9.2 Workspace Folder View-Model

Keep folders separate from resources:

```ts
export interface WorkspaceFolder {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
```

Do not put resource arrays inside each folder object.

Avoid:

```ts
folder.resources = [...]
```

because it couples organization state to resource instances.

Instead:

```text
folders[]
resources[]
```

and derive grouping.

---

# 10. Pure Workspace Tree Utility

Create:

```text
src/lib/workspace/groupResourcesByFolder.ts
```

Conceptual API:

```ts
export interface WorkspaceResourceGroup {
  folder: WorkspaceFolder | null;
  resources: WorkspaceResource[];
}

export function groupResourcesByFolder(
  resources: WorkspaceResource[],
  folders: WorkspaceFolder[],
): WorkspaceResourceGroup[];
```

Invariants:

1. Every resource appears exactly once.
2. `folderId === null` → Root group.
3. Resource with unknown folder ID does not crash the UI.
4. Invalid/missing folder membership is surfaced to the caller or normalized
   to root according to explicit implementation policy.
5. No mutation.
6. Deterministic group ordering.
7. Resource ordering inside groups follows the existing 4-tier resource sort.

Folder ordering should be deterministic, initially by:

```text
name ASC → id ASC
```

Do not add drag-and-drop reordering in this branch.

---

# 11. Search Semantics

Search should remain resource-centric.

Example:

```text
Search: "auth"

📁 Authentication
   📄 Auth PRD
   ◇ Auth Architecture
```

Folders with no matching resources should not expand merely because their name
exists.

Recommended behavior:

```text
query empty
    ↓
normal collapsed/expanded folder state

query non-empty
    ↓
show folders containing matching resources
    ↓
temporarily reveal matching children
```

The filter itself remains pure:

```ts
filterWorkspaceResources(...)
```

No network request is allowed for searching.

---

# 12. Sidebar UX Architecture

Target:

```text
┌──────────────────────────┐
│ ←  Project Name          │
│                          │
│ 🔍 Search resources      │
│                          │
│ ▣ Overview               │
│                          │
│ FOLDERS                  │
│                          │
│ ▼ Authentication         │
│    📄 Auth PRD           │
│    📄 Auth API           │
│    ◇ Auth Architecture   │
│                          │
│ ▼ Payments               │
│    📄 Payment PRD        │
│    ◇ Payment Architecture│
│                          │
│ ▶ Deployment             │
│                          │
│ ROOT                     │
│    📄 Project Notes      │
│    ◇ Global Architecture │
│                          │
│ + New Folder             │
└──────────────────────────┘
```

### Remove from sidebar

```text
❌ Recent section
❌ duplicated quick-create footer
❌ duplicated resource type lists at the top level
```

Recent resources remain available in the lightweight Overview.

---

# 13. Folder Actions

## Folder Header

Each folder row gets:

```text
▼ Authentication        3
                         ⋮
```

Context menu:

```text
Rename
Delete
```

Delete behavior:

```text
Delete folder
      ↓
Confirm
      ↓
folder removed
      ↓
contained resources → ROOT
```

Never cascade-delete resources.

---

## New Folder

Sidebar action:

```text
+ New Folder
```

opens a small rename-style dialog:

```text
Create Folder
[ Authentication          ]
[ Cancel ] [ Create ]
```

Prevent:

```text
empty name
whitespace-only name
```

Recommended normalization:

```text
trim()
```

No need for globally unique folder names.

Folder names only need to be unique enough for the user's project UI; duplicate
names may be allowed, but the UI should remain unambiguous through resource
membership and IDs.

---

# 14. Resource Context Actions

For each resource:

```text
⋮
 ├── Open
 ├── Move to...
 ├── Rename
 └── Delete
```

`Move to...` opens:

```text
Move "Auth PRD"

○ Root

○ Authentication
○ Payments
○ Deployment

[Cancel] [Move]
```

The selection must be changed only after the move succeeds.

---

# 15. Project Overview Redesign

## Remove

```text
❌ Large three-card metric dashboard
❌ Large Create Document card
❌ Large New Design card
❌ Six-card Recent Activity wall
```

## Replace with

```text
Project Name
Short description

7 resources
4 documents · 3 designs

Continue working

┌──────────────────┐  ┌──────────────────┐
│ Auth PRD         │  │ Auth Architecture│
│ Document         │  │ Design           │
└──────────────────┘  └──────────────────┘

┌──────────────────┐  ┌──────────────────┐
│ Payment PRD      │  │ Payment Design   │
│ Document         │  │ Design           │
└──────────────────┘  └──────────────────┘
```

The overview exists to orient the user, not become another management
dashboard.

---

# 16. Main Pane Rules

The main pane remains content-first:

```text
selection = none
    → lightweight ProjectOverview

selection = document
    → Editor

selection = design
    → SystemArchitect
```

The sidebar stays mounted while resources are open.

Resource switching continues to use the resource-specific lifecycle boundary:

```tsx
<Editor key={activeDocument.id} ... />

<SystemArchitect key={activeDesign.id} ... />
```

Do not modify Editor/SystemArchitect internal state unless a concrete
regression is found.

---

# 17. URL and Navigation Rules

Keep existing resource URLs:

```text
/projects/:id
/projects/:id?doc=:documentId
/projects/:id?design=:designId
```

Folders do NOT become resource selections.

Do not introduce:

```text
?folder=
```

in this branch.

Reason:

```text
Folder = organizational UI state
Resource = actual workspace content
```

Resource deep links remain shareable and stable.

---

# 18. Folder State vs URL State

Resource selection:

```text
URL = source of truth
```

Folder expansion/collapse:

```text
UI state
```

Search query:

```text
UI state
```

Folder membership:

```text
Supabase domain state
```

This produces a clean separation:

```text
URL
 └── Which resource is open?

React UI State
 ├── Which folders are expanded?
 └── What is the current search query?

Supabase
 ├── Which folder exists?
 └── Which resource belongs to which folder?
```

---

# 19. Responsive UX

## Desktop

```text
Sidebar visible
Sidebar collapsible
Main content remains full-height
```

## Mobile

```text
Sidebar → Sheet/Drawer
       ↓
user selects resource
       ↓
drawer closes
       ↓
main content = full width
```

Folder interaction must work inside the mobile drawer.

When opening a folder:

```text
tap folder → expand
```

When opening a resource:

```text
tap resource
    ↓
navigate
    ↓
drawer closes
```

---

# 20. Component Architecture

Target structure:

```text
src/components/ProjectWorkspace/
├── ProjectWorkspaceLayout.tsx
├── ProjectWorkspaceSidebar.tsx
├── WorkspaceSearch.tsx
├── WorkspaceFolderItem.tsx
├── WorkspaceResourceItem.tsx
├── WorkspaceMoveResourceDialog.tsx
├── ProjectOverview.tsx
└── WorkspaceCreateFolderDialog.tsx
```

Responsibilities:

### `ProjectWorkspaceLayout`

Only shell/responsive composition.

### `ProjectWorkspaceSidebar`

Navigation + folder tree + resource grouping.

### `WorkspaceFolderItem`

Folder row, expand/collapse, folder actions.

### `WorkspaceResourceItem`

Resource navigation + resource actions.

### `WorkspaceMoveResourceDialog`

Move resource between root/folders.

### `WorkspaceCreateFolderDialog`

Create folder.

### `ProjectOverview`

Lightweight project landing screen only.

---

# 21. Navigation Controller

Continue using:

```text
useWorkspaceNavigation
```

Resource operations:

```ts
openOverview()
openDocument(id)
openDesign(id)
```

Do not add folder selection to the resource navigation controller.

Folder actions should be separate:

```text
createFolder()
renameFolder()
deleteFolder()
moveResource()
```

This prevents navigation concerns from being mixed with persistence mutations.

---

# 22. Interaction Rules

## Clicking a Resource

```text
Click resource
    ↓
openDocument / openDesign
    ↓
URL push
    ↓
editor mounts with resource-specific key
```

## Clicking Folder

```text
Click folder header
    ↓
toggle expanded state
```

No navigation.

## Rename Folder

```text
Open menu
    ↓
Rename
    ↓
Dialog
    ↓
Mutation
    ↓
invalidate folders query
```

## Delete Folder

```text
Open menu
    ↓
Delete
    ↓
Confirmation
    ↓
mutation
    ↓
resources move to root via DB ON DELETE SET NULL
    ↓
invalidate folders + resources
```

---

# 23. Code Edit Map

## New Files

```text
src/hooks/useWorkspaceFolders.tsx

src/lib/workspace/groupResourcesByFolder.ts

src/components/ProjectWorkspace/WorkspaceFolderItem.tsx
src/components/ProjectWorkspace/WorkspaceMoveResourceDialog.tsx
src/components/ProjectWorkspace/WorkspaceCreateFolderDialog.tsx

supabase/migrations/<new_timestamp>_workspace_folders.sql
```

Potential tests:

```text
src/test/workspace/workspaceFolders.test.ts
src/test/workspace/groupResourcesByFolder.test.ts
src/test/workspace/WorkspaceFolderItem.test.tsx
src/test/workspace/WorkspaceMoveResourceDialog.test.tsx
```

---

## Modified Files

Likely:

```text
src/types/workspace.ts
src/pages/ProjectWorkspace.tsx
src/hooks/useDocuments.tsx
src/hooks/useSystemDesigns.tsx
src/integrations/supabase/types.ts
```

And the existing Branch 1 workspace components where already present:

```text
src/components/ProjectWorkspace/
```

Potentially:

```text
src/lib/workspace/resourceAdapter.ts
src/lib/workspace/filterResources.ts
```

only if the current local implementation needs folder metadata support.

Do not touch unrelated files without a concrete dependency.

---

# 24. Implementation Sequence

```text
Phase 0
Current Working Tree Audit
       ↓
Phase 1
Database + Type Contract
       ↓
Phase 2
Folder Data Hooks
       ↓
Phase 3
Pure Resource/Folder Grouping
       ↓
Phase 4
Sidebar Folder UX
       ↓
Phase 5
Move/Rename/Delete/Create interactions
       ↓
Phase 6
Overview simplification
       ↓
Phase 7
Navigation + Editor/SystemArchitect integration verification
       ↓
Phase 8
Full regression + manual UX validation
```

---

# 25. Phase 0 — Mandatory Audit

Before editing:

```bash
git status
git branch --show-current
git diff
git diff --name-status
```

Then inspect the actual current implementation of:

```text
ProjectWorkspace.tsx
ProjectWorkspaceLayout.tsx
ProjectWorkspaceSidebar.tsx
WorkspaceResourceItem.tsx
ProjectOverview.tsx
resourceAdapter.ts
filterResources.ts
useDocuments.tsx
useSystemDesigns.tsx
```

Also inspect the actual local database migration/type state.

Stop if the local implementation differs materially from the assumptions in
this plan.

Report:

```text
Current workspace implementation
Current selection/navigation implementation
Current tests
Current uncommitted files
Existing branch status
```

Do not overwrite local work merely to match this plan.

---

# 26. Phase 1 — Database and Type Contract

Implement:

```text
workspace_folders
documents.folder_id
system_designs.folder_id
```

with:

```text
RLS
project ownership
composite project-safe FK
ON DELETE SET NULL
updated_at trigger
```

Then update generated Supabase types through the repository's normal
generation process.

Verification:

```text
migration applies
type generation succeeds
existing tables remain readable
existing documents/designs remain valid
```

---

# 27. Phase 2 — Folder Data Layer

Implement `useWorkspaceFolders`.

Add folder_id support to documents/designs.

Verify:

```text
create folder
rename folder
delete folder
move resource to folder
move resource to root
```

Every mutation must be project-scoped.

Invalidate only the affected query families.

Avoid unnecessary global invalidations.

---

# 28. Phase 3 — Pure Organization Logic

Implement:

```text
groupResourcesByFolder
```

Tests:

```text
empty
root only
single folder
multiple folders
mixed documents/designs
unknown folder ID
stable sorting
duplicate names
resource appears exactly once
```

No React dependency.

No Supabase dependency.

---

# 29. Phase 4 — Sidebar UX

Implement:

```text
Folders
  ↓
Resources
```

Remove duplicated:

```text
Recent
Document type master list
Design type master list
redundant footer actions
```

Keep:

```text
Overview
Search
Folders
Root
New Folder
```

Folder rows must visually distinguish:

```text
expanded
collapsed
hover
context menu
```

Resource active state remains tied to URL-derived selection.

---

# 30. Phase 5 — Resource Organization Interactions

Implement:

```text
New Folder
Rename Folder
Delete Folder
Move Resource
Move to Root
```

Safety rules:

```text
Delete folder ≠ delete resources
Move failure ≠ update UI as if successful
Rename failure ≠ optimistic permanent label
```

Show clear error toasts on mutation failures.

---

# 31. Phase 6 — Overview Simplification

Use the screenshot direction as the target:

```text
Less cards
Less duplicated information
Less decorative density
More whitespace
Resource-oriented content
```

Overview should show:

```text
Project identity
Small resource summary
Recent / Continue Working
```

No repeated resource management UI.

---

# 32. Phase 7 — Navigation and Editor Integrity

Verify:

```text
Document A → Document B
Design A → Design B
Document → Design
Design → Document
```

For every transition:

```text
URL
sidebar active state
main content
```

must agree.

Use resource-specific keys:

```tsx
key={activeDocument.id}
key={activeDesign.id}
```

Preserve current `onBack` replace semantics.

Preserve Browser Back/Forward semantics.

---

# 33. Automated Test Matrix

## Folder Data Tests

```text
create folder
rename folder
delete folder
project isolation
RLS behavior where testable
```

## Grouping Tests

```text
root resources
folder resources
mixed resource types
invalid membership
deterministic ordering
```

## Sidebar Tests

```text
folder appears
folder count is correct
folder expands
folder collapses
resource opens
folder context menu works
resource context menu works
search filters resources
search hides empty folders
```

## Move Tests

```text
root → folder
folder A → folder B
folder → root
move error
```

## Navigation Tests

```text
doc A → doc B
design A → design B
deep links
browser history
invalid IDs
cross-project IDs
```

## Persistence Regression

```text
edit resource
switch resource
return to resource
saved/recoverable state remains intact
```

---

# 34. Behavioral Acceptance Criteria

The feature is complete only when:

```text
[ ] Users can create named project folders.
[ ] Folders persist after refresh.
[ ] Documents can belong to folders.
[ ] Designs can belong to folders.
[ ] Resources can move between folders.
[ ] Resources can move back to root.
[ ] Deleting a folder preserves its resources.
[ ] The sidebar is folder-first.
[ ] Documents and designs coexist within the same folder.
[ ] Search works across all visible project resources.
[ ] Recent resources are not duplicated in the sidebar.
[ ] Overview has substantially lower visual noise.
[ ] Opening a resource keeps the sidebar mounted.
[ ] Document A → B renders B.
[ ] Design A → B renders B.
[ ] URL matches the open resource.
[ ] Browser history remains correct.
[ ] Autosave and draft recovery remain operational.
[ ] No existing unrelated tests are weakened or deleted.
[ ] All new folder/workspace tests pass.
[ ] npm test passes.
[ ] npm run lint passes.
[ ] npx tsc --noEmit passes.
[ ] npm run build passes.
[ ] Required GitHub CI checks pass.
[ ] No IndexedDB/local-first implementation was introduced.
[ ] No AI-context redesign was introduced.
[ ] No Excalidraw integration was introduced.
```

---

# 35. Strict Agent Restrictions

The implementing agent MUST NOT:

```text
❌ Rewrite Editor.tsx
❌ Rewrite SystemArchitect.tsx
❌ Replace React Flow
❌ Introduce IndexedDB
❌ Introduce an outbox
❌ Rewrite Supabase synchronization
❌ Add nested folders
❌ Add drag-and-drop folder hierarchy
❌ Create a new global project-management abstraction
❌ Move documents/designs into a generic polymorphic database table
❌ Replace URL resource state with local selection state
❌ Add ?folder= as a navigation source of truth
❌ Modify unrelated tests to make CI green
❌ Delete or skip failing tests
❌ Change test configuration to hide failures
❌ Push before local verification
```

Allowed:

```text
✅ New folder table
✅ folder_id membership fields
✅ Folder-specific UI components
✅ Pure grouping utilities
✅ Focused workspace tests
✅ Small existing workspace component edits
✅ Required type/schema updates
```

---

# 36. Test Integrity Protocol

Every implementation phase must report:

```text
Production files changed:
Tests added:
Existing tests modified:
Existing tests deleted:
Test configuration modified:
Verification commands:
Results:
```

Expected default:

```text
Existing tests modified: 0
Existing tests deleted: 0
Test configuration modified: 0
```

Any exception requires a concrete explanation before proceeding.

---

# 37. Local Verification Protocol

No push until:

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
```

and manual testing succeeds.

Manual test project:

```text
Authentication
├── Auth PRD
├── Auth API
└── Auth Architecture

Payments
├── Payment PRD
└── Payment Architecture
```

Verify:

```text
create folder
rename folder
move document
move design
move to root
delete folder
refresh
search
open document
open design
switch resources
browser back/forward
mobile drawer
```

---

# 38. Recommended Commit Sequence

```text
feat(workspace): add persistent project folders

feat(workspace): add folder-aware resource grouping and navigation

feat(workspace): add resource move and folder management actions

refactor(workspace): simplify project overview and reduce visual density

test(workspace): add folder organization and workspace regression coverage
```

Each commit should be independently understandable and locally verified.

---

# 39. Final Architecture Diagram

```text
                             ┌─────────────────────┐
                             │       PROJECT       │
                             └──────────┬──────────┘
                                        │
                         ┌──────────────┴──────────────┐
                         │                             │
                         ▼                             ▼
                ┌────────────────┐           ┌──────────────────┐
                │ Root Resources │           │ Project Folders  │
                └───────┬────────┘           └────────┬─────────┘
                        │                              │
                  ┌─────┴─────┐             ┌────────┼────────┐
                  ▼           ▼             ▼        ▼        ▼
             Documents    Designs      Auth      Payments  Deploy
                                             │        │        │
                                           ┌─┴─┐    ┌─┴─┐    ┌─┴─┐
                                           ▼   ▼    ▼   ▼    ▼   ▼
                                          Docs Design Docs Design Docs Design


                         ┌────────────────────────────────────┐
                         │       PROJECT WORKSPACE SHELL      │
                         │                                    │
                         │ ┌────────────────┐ ┌─────────────┐ │
                         │ │ Project        │ │             │ │
                         │ │ Sidebar        │ │ Main Pane   │ │
                         │ │                │ │             │ │
                         │ │ Search         │ │ Overview    │ │
                         │ │ Overview       │ │     OR      │ │
                         │ │ Folders        │ │ Editor      │ │
                         │ │   ├ Docs       │ │     OR      │ │
                         │ │   └ Designs    │ │ SystemArch  │ │
                         │ │ Root           │ │             │ │
                         │ │ + New Folder   │ │             │ │
                         │ └────────────────┘ └─────────────┘ │
                         └────────────────────────────────────┘
```

---

# 40. Final State Authority Model

```text
                         URL
                          │
                          ▼
                 Resource Selection
                  (derived only)
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
       Document ID                  Design ID
            │                           │
            ▼                           ▼
         Editor                  SystemArchitect
            │                           │
            └─────────────┬─────────────┘
                          │
                          ▼
                   Project Workspace

React UI State:
- folder expanded/collapsed
- search query
- transient dialogs

Persistent Domain State:
- projects
- folders
- documents
- system designs
- folder membership

Future Branch 2:
Persistent Domain State
        ↓
IndexedDB Repository
        ↓
Outbox / Sync Engine
        ↓
Supabase
```

---

# 41. Decision Rationale Summary

### Decision: Folder = semantic project area

Because documents and designs usually describe the same subsystem.

### Decision: One-level folders

Because it solves the organization problem without recursive hierarchy
complexity.

### Decision: Root resources remain supported

Because not every resource belongs to a specific area.

### Decision: Folder deletion preserves resources

Because organization metadata must never become a destructive operation.

### Decision: Folders are persistent domain data

Because fake UI-only folders would not survive refresh or future sync.

### Decision: Folder state is not URL selection

Because opening a resource is navigation; expanding a folder is UI state.

### Decision: Overview becomes lighter

Because the sidebar is now the navigation surface and the overview should orient,
not duplicate management controls.

### Decision: No global Dashboard rewrite

Because the current problem is specifically the Project Workspace hierarchy
and mixing a global-dashboard redesign into this branch would increase scope.

---

# 42. Implementation Gate

Before the agent begins coding, require this sequence:

```text
READ THIS PLAN
      ↓
READ CURRENT WORKING TREE
      ↓
COMPARE PLAN ↔ ACTUAL CODE
      ↓
REPORT MISMATCHES
      ↓
IMPLEMENT DATABASE CONTRACT
      ↓
IMPLEMENT DATA LAYER
      ↓
IMPLEMENT PURE GROUPING
      ↓
IMPLEMENT SIDEBAR
      ↓
IMPLEMENT MOVE / FOLDER ACTIONS
      ↓
SIMPLIFY OVERVIEW
      ↓
RUN TESTS
      ↓
MANUAL UX VERIFICATION
      ↓
REVIEW DIFF
      ↓
COMMIT
      ↓
PUSH
```

No phase may silently expand into Local-First, IndexedDB, AI-context
architecture, Excalidraw, GitHub integration, or unrelated refactoring.
