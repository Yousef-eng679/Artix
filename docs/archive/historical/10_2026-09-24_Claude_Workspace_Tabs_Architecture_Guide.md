# Artix Workspace Tabs — Architecture & Agent Planning Guide

## 1. Purpose

Implement a real workspace tab system in Artix, similar in interaction model to tabs in Obsidian and VS Code.

The goal is to let a user work with multiple Artix resources at the same time:

```text
[ PRD.md ] [ Auth Design ] [ API.md ] [ Deployment ]
     ^ active
```

The user should be able to:
- Open a document or system design in a tab.
- Switch between already-open tabs.
- Avoid duplicate tabs for the same resource.
- Close tabs.
- See which tab is active.
- Preserve correct URL/deep-link behavior.
- Support unsaved/dirty-state indicators and close protection.
- Persist open-tab state appropriately.
- Use keyboard navigation.
- Keep the existing Folder system and resource architecture intact.

This is a workspace/navigation subsystem, not a rewrite of the Editor, System Architect, database, authentication, or folder model.

---

## 2. Core Product Model

Artix must distinguish three concepts:

```text
Resource
    ↓
Folder = where the resource is organized
    ↓
Tab = what the user currently has open
```

These are deliberately separate.

**Resource:** a document or system design stored by Artix.

**Folder:** the semantic project area containing a resource.

**Tab:** a temporary/current workspace representation of a resource.

Moving a resource between folders must not affect its open tab.

Renaming a resource must update the tab title.

Deleting a resource must reconcile/remove its tab.

---

## 3. Target Workspace UX

```text
┌──────────────────────────────────────────────────────────────┐
│ Sidebar │  📄 PRD   │ ⚙ Architecture │ 📄 Auth │ +         │
│         │            │      ACTIVE     │          │           │
├─────────┴────────────────────────────────────────────────────┤
│                                                              │
│                     Active Resource                          │
│                                                              │
│                    Editor / Design                           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

The Sidebar remains the project/resource discovery mechanism.

The TabBar represents the user's currently open workspace.

The content area renders the active resource.

---

## 4. Architectural Principle

Do **not** make tabs React component instances.

Bad:

```ts
tabs = [
  <Editor />,
  <Editor />,
  <SystemArchitect />
]
```

Good:

```ts
type WorkspaceTab = {
  id: string
  resourceType: 'document' | 'design'
  resourceId: string
}
```

The tab stores identity.

The renderer decides what component to render:

```text
Tab
 ↓
Resource identity
 ↓
Resource renderer
 ├── document → Editor
 └── design   → SystemArchitect
```

This keeps the tab system generic and allows future Artix workspace resources such as Git diff, AI session, research, test results, or previews without redesigning the tab system.

---

## 5. Proposed Domain Model

Start with a small explicit model:

```ts
type WorkspaceResourceType = 'document' | 'design'

type WorkspaceTab = {
  id: string
  resourceType: WorkspaceResourceType
  resourceId: string
}

type WorkspaceTabsState = {
  tabs: WorkspaceTab[]
  activeTabId: string | null
}
```

Do not implement speculative fields such as `pinned` or `preview` in V1.

---

## 6. Tab Identity and Duplicate Prevention

The resource identity is:

```text
resourceType + resourceId
```

Therefore:

```text
document:123
```

and:

```text
design:123
```

are different resources.

A normal resource can have at most one open tab.

```text
Open A → [A]
Open B → [A] [B]
Open A → [A] [B]
          ^
        active
```

Never create:

```text
[A] [B] [A]
```

unless a future explicitly-designed duplicate-view feature exists.

---

## 7. Tab Manager

Create a dedicated abstraction such as:

```text
useWorkspaceTabs()
```

It should own tab operations rather than scattering tab logic across UI components.

Core operations:

```ts
openTab(resource)
activateTab(tabId)
closeTab(tabId)
```

Useful internal helpers:

```ts
findTabForResource(resource)
getNextTabAfterClose(tabId)
reconcileTabs(resources)
```

Do not implement future features merely for speculative extensibility.

---

## 8. Open Tab Behavior

```text
Sidebar/resource click
        ↓
openTab(resource)
        ↓
Does matching tab exist?
   ├── yes → activate existing tab
   └── no  → create tab + activate it
```

Opening a resource must not unexpectedly change folder state.

---

## 9. Active Tab

Only one tab is active at a time:

```ts
activeTabId: string | null
```

The active tab controls the content renderer.

Inactive tabs are metadata only in V1.

---

## 10. Do Not Keep Every Heavy Editor Mounted

V1 should not mount every open editor/design simultaneously.

Avoid:

```text
10 tabs
→ 10 Editors mounted
→ 10 heavy React trees
```

Prefer:

```text
Tab metadata
    ↓
Active tab only
    ↓
Mount active resource renderer
```

This matters especially for System Architect.

If later requirements prove that a specific editor's runtime state must remain mounted, add a targeted preservation mechanism later. Do not introduce keep-alive complexity in V1.

---

## 11. URL Architecture

The URL should represent the **active resource**, not the entire tab collection.

Conceptually:

```text
URL
 ↓
Active tab
 ↓
Active resource
```

while:

```text
Persisted workspace state
 ↓
Open tabs
```

Example:

```text
/projects/123?doc=auth-prd
```

or:

```text
/projects/123?design=auth-architecture
```

Do not serialize the complete open-tab list into the URL.

The URL answers:

> Where am I now?

It should not answer:

> What is the complete internal state of my workspace?

---

## 12. Deep-Link Contract

A direct URL must still work.

Example:

```text
/projects/123?doc=auth-prd
```

Expected:

```text
URL
 ↓
Resolve resource
 ↓
Create/open corresponding tab
 ↓
Set activeTabId
 ↓
Render resource
 ↓
Sidebar reflects active resource
```

Preserve the existing invariant:

```text
URL
 ↓
Active selection
 ↓
Sidebar active resource
 ↓
Rendered resource
```

After Tabs, active selection is represented through the active tab/resource relationship.

---

## 13. Browser History

History semantics must be intentional.

The implementation must distinguish `push` from `replace` according to existing Artix navigation contracts.

Example:

```text
Document A
→ Document B
→ Design C
```

Then browser Back should follow the intended history.

Do not change existing history semantics without an explicit reason and test.

---

## 14. Sidebar Integration

The Sidebar remains responsible for discovering resources.

It does **not** become the owner of tabs.

```text
Sidebar
  ↓
openTab(resource)
  ↓
Tab Manager
  ↓
active tab
  ↓
content
```

The existing Folder hierarchy remains the organization model.

---

## 15. Folder/Tab Separation

Keep this distinction explicit:

```text
Folder = organization
Tab    = workspace state
Resource = actual project object
```

### Move

Moving a resource between folders leaves its open tab intact.

### Rename

Renaming a resource changes the displayed tab title but not tab identity.

### Delete

Deleting a resource removes/reconciles its corresponding tab.

---

## 16. Tab UI

Create isolated UI components:

```text
WorkspaceTabBar
WorkspaceTab
```

A tab contains:

```text
icon + resource title + close control
```

Example:

```text
[📄 PRD.md ×] [⚙ Auth Architecture ×] [📄 API.md ×]
```

The active tab must have an obvious visual state.

Use the existing Artix/Workspace design language.

---

## 17. Resource Titles

The tab is not the source of truth for the resource title.

Prefer:

```text
Tab
 ↓
resourceId
 ↓
resource query/cache
 ↓
current title
```

This prevents stale titles after renames.

---

## 18. Dirty / Unsaved State

Tabs should expose whether the resource has unsaved changes.

Example:

```text
[📄 PRD.md ● ×]
```

The tab system must not implement editor save logic.

Use the existing Artix autosave/draft infrastructure where applicable.

Conceptually:

```text
Editor/autosave
       ↓
dirty state
       ↓
Tab UI
       ↓
visual indicator
```

Do not create a second save system for tabs.

---

## 19. Closing Dirty Tabs

```text
User clicks X
        ↓
Check dirty state
        ↓
Dirty?
 ├── no  → close
 └── yes → confirmation
```

Example:

```text
This document has unsaved changes.

[Cancel] [Close]
```

Do not weaken save guarantees just to make tab closing easy.

---

## 20. Persistence

Tabs may persist across reloads, but persistence must be project-scoped.

```text
Project A → [A, B, C]
Project B → [X, Y]
```

Never let Project A restore Project B's tabs.

Do not scatter direct `localStorage` calls through UI components.

Prefer an abstraction:

```ts
loadWorkspaceTabs(projectId)
saveWorkspaceTabs(projectId, state)
```

V1 may use localStorage if appropriate, but keep persistence behind an adapter because Artix's longer-term architecture is moving toward:

```text
React UI
 ↓
Local Repository
 ↓
IndexedDB
 ↓
Sync Engine
 ↓
Supabase
```

Do not permanently couple the tab system to localStorage.

---

## 21. Refresh / Restore

If persistence is implemented:

```text
Open A
Open B
Activate B
Refresh
```

Expected:

```text
[A] [B]
     ^
   active
```

Handle stale resources:

```text
Persisted tab
     ↓
Resource missing
     ↓
Remove/reconcile tab
```

Do not render a permanently broken tab.

---

## 22. Resource Deletion Reconciliation

If:

```text
[A] [B] [C]
```

and B is deleted:

```text
[A] [C]
```

If B was active, select an appropriate remaining tab deterministically.

Cover this with tests.

---

## 23. Resource Rename Reconciliation

If:

```text
[Login PRD]
```

is renamed to:

```text
Authentication PRD
```

the existing tab must update its displayed title.

Do not create a new tab.

---

## 24. Keyboard Shortcuts

V1 target:

```text
Ctrl/Cmd + W
→ close active tab

Ctrl/Cmd + Tab
→ next tab

Ctrl/Cmd + Shift + Tab
→ previous tab

Ctrl/Cmd + 1..9
→ activate tab by position
```

Use a centralized keyboard handling point.

Do not attach competing global keydown handlers to individual tabs/editors.

Editor-specific shortcuts must remain functional.

---

## 25. Mouse Behavior

V1:

```text
Left click
→ activate

Close button
→ close
```

Middle-click close can be added if it fits naturally.

Do not add drag/reorder complexity to V1.

---

## 26. Explicitly Out of Scope for V1

Do not implement:

```text
❌ Split panes
❌ Tab groups
❌ Pinned tabs
❌ Preview tabs
❌ Drag/reorder
❌ Reopen closed tabs
❌ Cross-window tabs
❌ Multi-window workspaces
❌ VS Code-level workspace restoration
```

These are separate features.

---

## 27. Split Panes Are a Separate System

Do not confuse tabs with editor groups/split panes.

Future:

```text
┌──────────────────────┬──────────────────────┐
│ PRD   Auth   API     │ Architecture         │
│                      │                      │
│ Document Editor      │ System Architect     │
└──────────────────────┴──────────────────────┘
```

This is not part of the current implementation.

---

## 28. Recommended Module Boundaries

Determine exact filenames after inspecting the current repository.

The intended boundary is approximately:

```text
Workspace/
├── ProjectWorkspace
├── WorkspaceSidebar
├── WorkspaceTabBar
├── WorkspaceTab
├── WorkspaceContent
└── hooks/
    └── useWorkspaceTabs
```

A pure tab-operations module may also be appropriate:

```text
workspaceTabs.ts
```

Do not blindly create these exact files if the existing Artix structure has a better location.

---

## 29. Mandatory Repository Audit Before Coding

Before editing production code, inspect at minimum:

```text
ProjectWorkspace.tsx
useWorkspaceNavigation.ts
ProjectWorkspaceSidebar
ProjectWorkspaceLayout
Editor
SystemArchitect
document/design hooks
autosave
draftRecovery
navigation tests
workspace tests
```

Determine:

1. Where selected-resource state currently lives.
2. How URL synchronization works.
3. Which operations use push vs replace.
4. How Documents are loaded.
5. How Designs are loaded.
6. Whether editor state depends on mounting.
7. How autosave determines dirty/saved state.
8. How resource deletion propagates.
9. How resource rename propagates.
10. Which tests encode current navigation contracts.
11. Whether any code assumes only one active resource.
12. Which existing abstractions can be reused.

Do not infer these from filenames alone.

---

# 30. Implementation Phases

## Phase 0 — Repository Audit

No production code changes yet.

Document:

```text
Current navigation state
Current URL contract
Current resource rendering
Current autosave/dirty contract
Current tests
```

Identify assumptions that only one resource can be active.

---

## Phase 1 — Pure Tab Domain Logic

Implement and test:

```text
open
activate
close
duplicate prevention
active-tab selection
```

Prefer pure functions where possible.

Examples:

```text
open A → [A], active A
open B → [A,B], active B
open A → [A,B], active A
close A → [B], active B
```

No complex UI yet.

---

## Phase 2 — Workspace Tab State

Create the `useWorkspaceTabs` boundary.

Responsibilities:

```text
tabs
activeTabId
openTab
activateTab
closeTab
```

Keep persistence separate.

---

## Phase 3 — URL Integration

Connect:

```text
URL ↔ active tab ↔ resource
```

Verify deep links and browser history.

Do not put the complete tab array in the URL.

---

## Phase 4 — TabBar UI

Implement:

```text
WorkspaceTabBar
WorkspaceTab
```

Only after the underlying state model is stable.

---

## Phase 5 — Sidebar Integration

Change resource clicks to:

```text
openTab(resource)
```

Preserve all Folder navigation behavior.

---

## Phase 6 — Content Rendering

Render the active resource through existing components:

```text
active document → Editor
active design   → SystemArchitect
```

Avoid unnecessary changes inside those components.

---

## Phase 7 — Dirty State

Integrate existing autosave/draft mechanisms.

Add:

```text
dirty indicator
close protection
```

Only after confirming the real save-state contract.

---

## Phase 8 — Persistence

Add project-scoped persistence behind an abstraction.

Test:

```text
reload
project switching
stale resource cleanup
```

---

## Phase 9 — Keyboard Interaction

Add the target shortcuts and verify editor shortcuts still work.

---

## Phase 10 — Hardening

Test:

```text
multiple tabs
duplicate opening
deep links
refresh
browser back/forward
rename
delete
folder move
dirty resource
project switching
empty tab state
resource loading
resource missing
```

---

# 31. Testing Strategy

Use:

```text
Pure Unit
   ↓
Component
   ↓
Workspace Integration
   ↓
Dedicated E2E environment
```

### Unit

Test tab state transitions.

### Component

Test:
- active tab rendering
- close button
- title
- dirty indicator
- click behavior

### Integration

Test:

```text
Sidebar
 ↓
Tab Manager
 ↓
Active Resource
 ↓
Editor/Design
```

### E2E

Use the dedicated authenticated Playwright environment already planned for Artix.

Do not move heavy E2E infrastructure into the normal CI workflow merely because Tabs are being added.

---

# 32. Critical Invariants

### Invariant 1 — No duplicate normal tabs

```text
count(openTabs(resource)) <= 1
```

### Invariant 2 — Active tab must exist

If `activeTabId !== null`, that ID must exist in `tabs`.

### Invariant 3 — Active resource must match active tab

The rendered resource must be derived from the active tab.

### Invariant 4 — URL must match active resource

In a stable workspace state:

```text
URL resource == active tab resource
```

### Invariant 5 — Folder does not own tab state

Moving a resource between folders must not destroy/recreate its tab.

### Invariant 6 — Resource identity survives rename

Rename changes metadata, not tab identity.

### Invariant 7 — Deleted resources cannot remain as permanent tabs

Deletion must trigger reconciliation.

---

# 33. Performance Constraints

Avoid unnecessary:

```text
React remounts
query invalidation
editor recreation
global state updates
localStorage writes
```

Do not store large document contents inside tab state.

Bad:

```ts
tab = {
  content: hugeDocumentContent
}
```

Good:

```ts
tab = {
  resourceType: 'document',
  resourceId: '123'
}
```

Resource data continues to use the existing query/cache/data layer.

---

# 34. Security Constraints

Tabs must not bypass authorization.

A persisted resource ID is not proof of access.

Artix must resolve persisted IDs through the normal authorization/data layer.

Never expose a resource merely because its ID exists in persisted tab state.

The tab system is navigation state, not an authorization layer.

---

# 35. Failure Handling

Explicitly handle:

```text
Tab resource loading
Tab resource missing
Tab resource deleted
Tab resource unauthorized
Tab resource renamed
```

The UI should not crash on these states.

Stale persisted tabs should be cleaned up.

Unauthorized resources must not be exposed through persisted IDs.

---

# 36. Agent Rules

The implementing agent MUST:

1. Inspect the current repository before editing.
2. Reuse existing navigation/resource abstractions where possible.
3. Keep Tabs isolated from Editor implementation.
4. Keep Tabs isolated from Folder semantics.
5. Avoid changing database/auth/security behavior unless required by an identified contract.
6. Avoid rewriting `ProjectWorkspace` wholesale.
7. Avoid introducing a global state library just for Tabs.
8. Avoid storing full resource contents inside tabs.
9. Avoid putting the entire tab list in the URL.
10. Avoid mounting all editors simultaneously.
11. Preserve existing autosave behavior.
12. Preserve existing deep-link behavior.
13. Preserve existing push/replace history semantics unless deliberately changed and tested.
14. Never weaken an existing test to make the suite pass.
15. Add tests for every new navigation invariant.
16. Keep E2E work in the dedicated environment rather than normal CI.
17. Do not implement out-of-scope features.
18. Keep commits logically separated.
19. Run relevant tests after each architectural stage.
20. Do not push changes unless explicitly instructed by the user.

---

# 37. Commit Strategy

Prefer small logical commits.

Suggested sequence:

```text
feat(workspace): add tab domain model
test(workspace): add tab state transition tests

feat(workspace): integrate tab state with navigation
test(workspace): cover tab navigation history

feat(workspace): add workspace tab bar
test(workspace): add tab bar component coverage

feat(workspace): open resources from sidebar in tabs
test(workspace): cover sidebar to tab integration

feat(workspace): add dirty tab state
test(workspace): cover dirty tab close protection

feat(workspace): persist workspace tabs
test(workspace): cover tab restoration

feat(workspace): add tab keyboard navigation
test(workspace): cover keyboard tab switching
```

Adapt commit boundaries to the actual implementation rather than forcing them mechanically.

---

# 38. Definition of Done

The V1 Tabs feature is complete when:

- [ ] A document can be opened as a tab.
- [ ] A design can be opened as a tab.
- [ ] Reopening an already-open resource activates its existing tab.
- [ ] Multiple tabs can coexist.
- [ ] Active tab is visually clear.
- [ ] Tabs can be closed.
- [ ] Closing the active tab selects a deterministic replacement.
- [ ] URL reflects the active resource.
- [ ] Direct resource URLs open the correct tab.
- [ ] Browser history behavior is intentional and tested.
- [ ] Sidebar active state remains synchronized.
- [ ] Editor renders the active document.
- [ ] System Architect renders the active design.
- [ ] Resource renames update tab titles.
- [ ] Resource deletion removes/reconciles tabs.
- [ ] Folder movement does not break tabs.
- [ ] Dirty resources show an indicator.
- [ ] Dirty resources have close protection.
- [ ] Tab state is persisted according to the selected persistence strategy.
- [ ] Persistence is project-scoped.
- [ ] Stale persisted resources are reconciled.
- [ ] Basic keyboard shortcuts work.
- [ ] Existing editor shortcuts remain functional.
- [ ] Unit tests cover tab state transitions.
- [ ] Integration tests cover Sidebar → Tab → Resource.
- [ ] Existing tests remain green.
- [ ] Dedicated E2E coverage is updated when the authenticated E2E environment is available.
- [ ] Split panes, pinned tabs, tab groups, and drag/reorder remain out of V1.
- [ ] No unrelated production refactor was performed.

---

# 39. Final Architectural Goal

```text
                        Artix Workspace
                              │
               ┌──────────────┴──────────────┐
               │                             │
          Project Sidebar              Workspace Tabs
               │                             │
        Resource discovery             Open resources
               │                             │
               └──────────────┬──────────────┘
                              │
                         Active Tab
                              │
                       Resource Identity
                              │
                  ┌───────────┴───────────┐
                  │                       │
              Document                  Design
                  │                       │
                Editor              System Architect
```

The critical architectural boundaries are:

```text
Folder
  ≠
Tab
  ≠
Resource
  ≠
Editor
```

This separation is the foundation for future Artix workspace capabilities without forcing another major navigation rewrite.
