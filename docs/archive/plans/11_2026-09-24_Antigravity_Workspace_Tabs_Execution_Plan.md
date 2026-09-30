# Workspace Tabs — Execution-Ready Implementation Plan

> Based on [Artix_Workspace_Tabs_Architecture_and_Agent_Planning_Guide.md](file:///c:/Fenix-main/Artix_Workspace_Tabs_Architecture_and_Agent_Planning_Guide.md), validated against a full codebase audit (navigation, editor/autosave, tests, types).

## Background & Summary

Implement a VS Code / Obsidian-style tab system allowing users to open multiple documents and designs simultaneously. Tabs are **metadata pointers** (identity only), not mounted component instances. Only the active tab's resource renderer is mounted. The existing folder system, autosave pipeline, and URL contract remain intact.

### Key Architectural Decisions (from Audit)

| Aspect | Current State | Tab System Change |
|---|---|---|
| Active resource | `WorkspaceSelection` derived from `?doc=`/`?design=` URL params | URL remains single source of truth for **active** tab |
| Resource mounting | `key={id}` forces remount per resource switch | Same — only active tab's Editor/SystemArchitect is mounted |
| Navigation hook | `useWorkspaceNavigation` with PUSH/REPLACE semantics | Reused internally by `useWorkspaceTabs` |
| Dirty tracking | Two-tier: localStorage draft (instant) + debounced Supabase write | Expose via lightweight `DirtyTracker` singleton → tab indicator |
| Persistence | N/A (single resource) | Project-scoped localStorage behind adapter abstraction |
| `ProjectWorkspace.tsx` | 771 lines, handles folder/resource CRUD, selection, rendering | Surgical integration — NOT a rewrite |

---

## User Review Required

> [!IMPORTANT]
> **`ProjectWorkspace.tsx` is already 771 lines.** The tab integration adds ~80 lines (imports, hook call, TabBar placement, handler wiring). Should we extract resource CRUD handlers into a separate `useWorkspaceActions` hook in a preparatory refactor commit, or keep them inline?

> [!IMPORTANT]
> **Overview + Tabs behavior:** When user clicks "Overview" in the sidebar, the plan **deactivates** the active tab (shows ProjectOverview) but **keeps all tabs open** in the tab bar. Is this the desired UX, or should Overview close all tabs?

> [!IMPORTANT]
> **Tab click history semantics:** Clicking a tab to activate it will use **PUSH** (browser Back returns to the previous tab). This matches the current `openDocument`/`openDesign` behavior. Confirm this is desired.

## Open Questions

> [!NOTE]
> **Middle-click to close:** The guide mentions middle-click as optional. Should we include it in V1? (Low effort, ~3 lines.)

> [!NOTE]
> **Max open tabs:** Should there be a limit on the number of open tabs? (The guide doesn't specify one for V1. Recommended: no limit.)

---

## Proposed Changes

Changes are organized by phase, matching the guide's recommended sequence. Each phase is a logical commit boundary.

---

### Phase 1 — Tab Domain Types & Pure Logic

> Pure functions, zero side effects, zero UI. Comprehensive test coverage.

#### [MODIFY] [workspace.ts](file:///c:/Fenix-main/src/types/workspace.ts)

Add tab-related types, reusing the existing `ResourceKind`:

```typescript
// New types — appended to existing file
export interface WorkspaceTab {
  id: string;                // Deterministic: `${resourceKind}:${resourceId}`
  resourceKind: ResourceKind; // 'document' | 'design'
  resourceId: string;
}

export interface WorkspaceTabsState {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
}
```

> [!TIP]
> Reuses `ResourceKind` (not `WorkspaceResourceType` from the guide) for codebase consistency. The tab `id` is a deterministic composite `document:abc` / `design:xyz`, making duplicate prevention trivial.

#### [NEW] [workspaceTabs.ts](file:///c:/Fenix-main/src/lib/workspace/workspaceTabs.ts)

Pure tab state-transition functions (~100 lines):

| Function | Signature | Behavior |
|---|---|---|
| `makeTabId` | `(kind: ResourceKind, resourceId: string) → string` | Returns `${kind}:${resourceId}` |
| `parseTabId` | `(tabId: string) → { resourceKind, resourceId }` | Inverse of `makeTabId` |
| `openTab` | `(state, resource) → WorkspaceTabsState` | If tab exists → activate it. If not → append + activate. Returns new state. |
| `activateTab` | `(state, tabId) → WorkspaceTabsState` | Sets `activeTabId`. No-op if tab doesn't exist. |
| `closeTab` | `(state, tabId) → WorkspaceTabsState` | Removes tab. If it was active, selects next (right → left → null). |
| `getNextTabAfterClose` | `(tabs, closedTabId) → WorkspaceTab \| null` | Deterministic: prefer right neighbor, then left, then null. |
| `reconcileTabs` | `(state, validResourceIds: Set<string>) → WorkspaceTabsState` | Removes tabs whose resource no longer exists. Adjusts `activeTabId`. |
| `findTabForResource` | `(tabs, kind, resourceId) → WorkspaceTab \| null` | Lookup by resource identity. |

#### [NEW] [workspaceTabs.test.ts](file:///c:/Fenix-main/src/test/workspace/workspaceTabs.test.ts)

Comprehensive pure unit tests (~200 lines, ~25 test cases):

- `openTab`: open first, open second, open duplicate (activates existing), open with different kinds sharing same ID
- `closeTab`: close active (selects right), close active last (selects left), close inactive (no activeTab change), close only tab (activeTabId → null), close non-existent (no-op)
- `activateTab`: activate existing, activate non-existent (no-op)
- `reconcileTabs`: remove deleted resource's tab, remove multiple, active tab deleted → select replacement, all tabs deleted → null, no deletions → identity
- `makeTabId` / `parseTabId`: round-trip, both resource kinds
- `getNextTabAfterClose`: middle tab, first tab, last tab, single tab

**Commit:** `feat(workspace): add tab domain model and pure state transitions`
`test(workspace): add comprehensive tab state transition tests`

---

### Phase 2 — Tab Persistence Adapter

> Abstraction layer for persisting open tabs. Decoupled from localStorage for future IndexedDB migration.

#### [NEW] [tabPersistence.ts](file:///c:/Fenix-main/src/lib/workspace/tabPersistence.ts)

~40 lines:

```typescript
const STORAGE_KEY_PREFIX = 'artix.workspace.tabs.';

export function loadWorkspaceTabs(projectId: string): WorkspaceTab[] | null { ... }
export function saveWorkspaceTabs(projectId: string, tabs: WorkspaceTab[]): void { ... }
export function clearWorkspaceTabs(projectId: string): void { ... }
```

- Key format: `artix.workspace.tabs.${projectId}`
- Value: JSON array of `WorkspaceTab[]` (activeTabId is derived from URL, not persisted)
- Graceful handling: corrupt JSON → return null, localStorage quota → silently catch
- Only the **tab list** is persisted, not `activeTabId` (URL is source of truth for active tab)

#### [NEW] [tabPersistence.test.ts](file:///c:/Fenix-main/src/test/workspace/tabPersistence.test.ts)

~60 lines: load/save round-trip, project isolation, corrupt JSON recovery, empty array, quota error handling.

**Commit:** `feat(workspace): add tab persistence adapter behind abstraction`
`test(workspace): add tab persistence tests`

---

### Phase 3 — Workspace Tab State Hook + URL Integration

> React hook that composes pure functions, persistence, URL sync, and reconciliation.

#### [NEW] [useWorkspaceTabs.ts](file:///c:/Fenix-main/src/hooks/useWorkspaceTabs.ts)

~120 lines. Core architecture:

```
URL params ──────────► activeTabId (DERIVED, not stored)
                              │
Tab list state ◄──────────────┤
  (useState + localStorage)   │
                              ▼
                      activeTab object
```

**Key design: URL is the single source of truth for `activeTabId`.** The tab list is separate state. No bidirectional sync complexity.

```typescript
export function useWorkspaceTabs(projectId: string, resources: WorkspaceResource[]) {
  const [searchParams] = useSearchParams();
  const { openDocument, openDesign, openOverview } = useWorkspaceNavigation();

  // Tab list state (loaded from persistence on mount)
  const [tabs, setTabs] = useState<WorkspaceTab[]>(() =>
    loadWorkspaceTabs(projectId) ?? []
  );

  // Active tab DERIVED from URL (not stored)
  const activeTabId = useMemo(() => {
    const docId = searchParams.get('doc');
    const designId = searchParams.get('design');
    if (docId) return makeTabId('document', docId);
    if (designId) return makeTabId('design', designId);
    return null;
  }, [searchParams]);

  const activeTab = useMemo(() =>
    tabs.find(t => t.id === activeTabId) ?? null
  , [tabs, activeTabId]);

  // Auto-persist tabs on change
  useEffect(() => { saveWorkspaceTabs(projectId, tabs); }, [projectId, tabs]);

  // Auto-reconcile: remove tabs for deleted resources
  useEffect(() => { ... reconcileTabs logic ... }, [resources]);

  // Ensure URL-referenced resource has a tab (deep-link support)
  useEffect(() => { ... if URL points to resource not in tabs, add it ... }, [searchParams]);

  // Public API
  const handleOpenTab = useCallback((resource: { kind: ResourceKind; id: string }) => {
    setTabs(prev => openTabPure({ tabs: prev, activeTabId: null }, resource).tabs);
    if (resource.kind === 'document') openDocument(resource.id);
    else openDesign(resource.id);
  }, [openDocument, openDesign]);

  const handleActivateTab = useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    if (tab.resourceKind === 'document') openDocument(tab.resourceId);
    else openDesign(tab.resourceId);
  }, [tabs, openDocument, openDesign]);

  const handleCloseTab = useCallback((tabId: string) => {
    const result = closeTabPure({ tabs, activeTabId }, tabId);
    setTabs(result.tabs);
    if (activeTabId === tabId) {
      const nextTab = result.tabs.find(t => t.id === result.activeTabId);
      if (nextTab) {
        if (nextTab.resourceKind === 'document') openDocument(nextTab.resourceId);
        else openDesign(nextTab.resourceId);
      } else {
        openOverview();
      }
    }
  }, [tabs, activeTabId, openDocument, openDesign, openOverview]);

  const handleCloseOtherTabs = useCallback((tabId: string) => { ... }, []);

  return { tabs, activeTabId, activeTab, openTab: handleOpenTab,
           activateTab: handleActivateTab, closeTab: handleCloseTab };
}
```

> [!NOTE]
> **Why derive `activeTabId` from URL?** This eliminates bidirectional sync complexity. URL is already the source of truth for the active resource. Browser back/forward, deep links, and `?action=` params all work naturally without extra synchronization code.

#### [NEW] [useWorkspaceTabs.test.tsx](file:///c:/Fenix-main/src/test/workspace/useWorkspaceTabs.test.tsx)

~150 lines using `renderHook` + `MemoryRouter`:

- Open tab from sidebar → tab added + URL updated
- Open duplicate → no new tab, existing activated
- Close active tab → next tab selected, URL updated
- Close inactive tab → no URL change
- Deep link → tab auto-created
- Resource deleted → tab reconciled
- Persistence: reload → tabs restored from localStorage
- Project switch → different tab set loaded

**Commit:** `feat(workspace): add useWorkspaceTabs hook with URL sync and persistence`
`test(workspace): add tab state hook tests`

---

### Phase 4 — Dirty State Integration

> Expose resource dirty state to the tab UI without creating a second save system.

#### [NEW] [dirtyTracker.ts](file:///c:/Fenix-main/src/lib/workspace/dirtyTracker.ts)

Lightweight reactive singleton (~35 lines) compatible with React's `useSyncExternalStore`:

```typescript
type Listener = () => void;
const dirtyIds = new Set<string>();
const listeners = new Set<Listener>();

export function markDirty(id: string): void { dirtyIds.add(id); notify(); }
export function markClean(id: string): void { dirtyIds.delete(id); notify(); }
export function isDirty(id: string): boolean { return dirtyIds.has(id); }
export function subscribe(listener: Listener): () => void { ... }
export function getSnapshot(): ReadonlySet<string> { ... }
function notify() { listeners.forEach(l => l()); }
```

#### [MODIFY] [autosave.ts](file:///c:/Fenix-main/src/lib/autosave.ts)

+2 lines: import `dirtyTracker`, call `markDirty(documentId)` in `triggerSave`, call `markClean(documentId)` on save success.

#### [MODIFY] [SystemArchitect.tsx](file:///c:/Fenix-main/src/components/SystemArchitect/SystemArchitect.tsx)

+2 lines: import `dirtyTracker`, call `markDirty(design.id)` in `triggerAutoSave`, call `markClean(design.id)` on save success. Call `markClean` in cleanup.

#### [NEW] [dirtyTracker.test.ts](file:///c:/Fenix-main/src/test/workspace/dirtyTracker.test.ts)

~40 lines: mark/clean, subscribe/notify, snapshot immutability.

**Commit:** `feat(workspace): add dirty state tracker for tab indicators`

---

### Phase 5 — TabBar UI Components

> Visual tab bar rendered between the mobile header and the content area.

#### [NEW] [WorkspaceTabBar.tsx](file:///c:/Fenix-main/src/components/ProjectWorkspace/WorkspaceTabBar.tsx)

~90 lines. Renders horizontal scrollable tab bar:

```
┌────────────────────────────────────────────────────────┐
│ [📄 PRD ●  ×] [⚙ Architecture ×] [📄 API ×]          │
│      active                                            │
└────────────────────────────────────────────────────────┘
```

Props:
```typescript
interface WorkspaceTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  resources: WorkspaceResource[];     // For resolving titles
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
}
```

Behavior:
- Renders `WorkspaceTabItem` for each tab
- Horizontal scroll with `overflow-x-auto` (no wrapping)
- Resolves tab titles from `resources` array (not stored in tab — prevents stale titles after rename)
- Icons: `FileText` for documents, `Workflow` for designs (matching sidebar)
- Active tab: `bg-background border-b-2 border-primary font-medium`
- Inactive tab: `text-muted-foreground hover:bg-muted/50`
- Hidden when `tabs.length === 0` (no tabs open → no bar)
- Uses `useSyncExternalStore` with `dirtyTracker` for dirty indicators

#### [NEW] [WorkspaceTabItem.tsx](file:///c:/Fenix-main/src/components/ProjectWorkspace/WorkspaceTabItem.tsx)

~55 lines. Single tab item:

- Click → `onActivateTab(tab.id)`
- Close button (X) → `onCloseTab(tab.id)` with `e.stopPropagation()`
- Middle-click → `onCloseTab(tab.id)` (if approved in review)
- Dirty indicator: `●` dot before close button when resource has unsaved draft
- Title: resolved from resources array, fallback to "Untitled"
- `role="tab"`, `aria-selected`, `aria-label` for accessibility
- `tabIndex={0}` with keyboard Enter/Space support

#### [NEW] [WorkspaceTabBar.test.tsx](file:///c:/Fenix-main/src/test/components/WorkspaceTabBar.test.tsx)

~100 lines:
- Renders correct number of tabs
- Active tab has active styling
- Click tab → `onActivateTab` called
- Click close → `onCloseTab` called
- Resource title resolved from resources
- Dirty indicator shown when draft exists
- Hidden when no tabs
- Renamed resource → title updates (no stale title)

**Commit:** `feat(workspace): add WorkspaceTabBar and WorkspaceTabItem components`
`test(workspace): add tab bar component tests`

---

### Phase 6 — ProjectWorkspace Integration (Sidebar + Content + TabBar)

> Wire tabs into the workspace shell. Surgical changes to [ProjectWorkspace.tsx](file:///c:/Fenix-main/src/pages/ProjectWorkspace.tsx).

#### [MODIFY] [ProjectWorkspace.tsx](file:///c:/Fenix-main/src/pages/ProjectWorkspace.tsx)

Changes (~80 net lines added):

1. **Import `useWorkspaceTabs`** and `WorkspaceTabBar`.

2. **Add hook call** (after existing hooks, ~line 35):
   ```typescript
   const { tabs, activeTabId, activeTab, openTab, activateTab, closeTab } =
     useWorkspaceTabs(id, workspaceResources);
   ```

3. **Replace direct `openDocument`/`openDesign` calls** in sidebar handler:
   ```typescript
   // Before:
   onSelectResource={(res) => {
     if (res.kind === 'document') openDocument(res.id);
     else openDesign(res.id);
   }}
   // After:
   onSelectResource={(res) => {
     openTab({ kind: res.kind, id: res.id });
     setIsMobileSidebarOpen(false);
   }}
   ```

4. **Replace post-creation navigation** to go through tabs:
   ```typescript
   // In handleConfirmCreateDocument, after creation:
   openTab({ kind: 'document', id: newDoc.id });
   // (replaces openDocument(newDoc.id))
   ```

5. **Add TabBar to layout** — between mobile header and content pane, inside `ProjectWorkspaceLayout`:
   ```tsx
   <WorkspaceTabBar
     tabs={tabs}
     activeTabId={activeTabId}
     resources={workspaceResources}
     onActivateTab={activateTab}
     onCloseTab={closeTab}
   />
   ```

6. **Keep existing `selection` derivation** — it now naturally reflects the active tab since URL params remain the source of truth. No change needed to the selection `useMemo` or the conditional rendering block.

7. **Keep existing validation logic** — missing resource toast, conflict resolution, `recentlyCreatedRef` — all remain unchanged.

8. **Post-deletion handler** — when a resource is deleted, the tab is automatically reconciled by `useWorkspaceTabs`'s `reconcileTabs` effect. Remove the manual `openOverview()` call after delete (the hook handles it).

#### [MODIFY] [ProjectWorkspaceLayout.tsx](file:///c:/Fenix-main/src/components/ProjectWorkspace/ProjectWorkspaceLayout.tsx)

Add a `tabBar` slot prop:
```typescript
interface ProjectWorkspaceLayoutProps {
  sidebar: React.ReactNode;
  tabBar?: React.ReactNode;    // NEW
  children: React.ReactNode;
  // ... existing props
}
```

Render `tabBar` between the mobile header and `<main>`:
```tsx
{/* Tab Bar */}
{tabBar}

{/* Content pane */}
<main className="flex-1 h-full overflow-hidden min-w-0 relative">
  {children}
</main>
```

#### [MODIFY] [ProjectWorkspaceNavigation.test.tsx](file:///c:/Fenix-main/src/test/workspace/ProjectWorkspaceNavigation.test.tsx)

Update existing tests to account for tab bar presence in rendered output. Ensure:
- Deep link still works (resource opens in tab + renders correctly)
- Conflict resolution still works (`?doc` takes precedence)
- Missing resource still shows toast + fallback
- `recentlyCreatedRef` still suppresses false-positive 404s

**Commit:** `feat(workspace): integrate tab system into ProjectWorkspace shell`
`test(workspace): update navigation tests for tab integration`

---

### Phase 7 — Close Protection for Dirty Tabs

> Prevent accidental data loss when closing a tab with unsaved changes.

#### [NEW] [CloseTabConfirmDialog.tsx](file:///c:/Fenix-main/src/components/ProjectWorkspace/CloseTabConfirmDialog.tsx)

~40 lines. Simple confirmation dialog:

```
┌─────────────────────────────────────┐
│  This resource has unsaved changes. │
│                                     │
│        [Cancel]     [Close]         │
└─────────────────────────────────────┘
```

Uses existing Shadcn `AlertDialog` components.

#### [MODIFY] [ProjectWorkspace.tsx](file:///c:/Fenix-main/src/pages/ProjectWorkspace.tsx)

Add close-protection wrapper (~15 lines):
```typescript
const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);

const handleRequestCloseTab = useCallback((tabId: string) => {
  if (dirtyTracker.isDirty(parseTabId(tabId).resourceId)) {
    setPendingCloseTabId(tabId);  // Show confirmation
  } else {
    closeTab(tabId);
  }
}, [closeTab]);

const handleConfirmClose = useCallback(() => {
  if (pendingCloseTabId) {
    closeTab(pendingCloseTabId);
    setPendingCloseTabId(null);
  }
}, [pendingCloseTabId, closeTab]);
```

**Commit:** `feat(workspace): add dirty tab close protection`
`test(workspace): add dirty tab close confirmation tests`

---

### Phase 8 — Keyboard Shortcuts

> Centralized keyboard handler. Preserves existing editor shortcuts.

#### [NEW] [useWorkspaceKeyboard.ts](file:///c:/Fenix-main/src/hooks/useWorkspaceKeyboard.ts)

~60 lines. Single `useEffect` with `keydown` listener on `window`:

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + W` | Close active tab (with dirty check) |
| `Ctrl/Cmd + Tab` | Next tab |
| `Ctrl/Cmd + Shift + Tab` | Previous tab |
| `Ctrl/Cmd + 1..9` | Activate tab by position |

Guard: only fire when no input/textarea is focused AND no modal is open.

```typescript
export function useWorkspaceKeyboard(opts: {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  enabled: boolean;
}) { ... }
```

> [!WARNING]
> `Ctrl+W` is the browser's "close tab" shortcut. We call `e.preventDefault()` to intercept it when the workspace has focus. This is standard for web IDEs (CodeSandbox, StackBlitz, etc.) but can surprise users. The guide explicitly lists it as a V1 target.

#### [NEW] [useWorkspaceKeyboard.test.ts](file:///c:/Fenix-main/src/test/hooks/useWorkspaceKeyboard.test.ts)

~80 lines: each shortcut, disabled state, input focus guard, edge cases (no tabs, single tab).

**Commit:** `feat(workspace): add tab keyboard shortcuts`
`test(workspace): add keyboard shortcut tests`

---

### Phase 9 — Hardening & Edge Cases

> Final pass: complete invariant coverage, edge case handling, integration tests.

#### [NEW] [workspaceTabsIntegration.test.tsx](file:///c:/Fenix-main/src/test/workspace/workspaceTabsIntegration.test.tsx)

~150 lines. Integration tests covering the full flow:

- Open doc from sidebar → tab appears → Editor renders
- Open design from sidebar → tab appears → SystemArchitect renders  
- Open same resource twice → no duplicate tab
- Close active tab → next tab becomes active → correct renderer
- Deep link → tab created → resource rendered → sidebar highlights
- Browser back → previous tab activated
- Rename resource → tab title updates (no new tab)
- Delete resource → tab removed → next tab or overview
- Move resource to different folder → tab unaffected
- Refresh page → tabs restored from persistence, active tab from URL
- Project switch → different tab set
- 10+ tabs open → horizontal scroll
- Close all tabs → overview shown
- Dirty resource close → confirmation dialog → cancel → tab stays → confirm → tab closes

#### Invariant Verification Checklist (from Guide §32)

| # | Invariant | Verified By |
|---|---|---|
| 1 | No duplicate normal tabs | `workspaceTabs.test.ts` — open duplicate test |
| 2 | Active tab must exist in tabs | `workspaceTabs.test.ts` — activateTab non-existent |
| 3 | Rendered resource matches active tab | `workspaceTabsIntegration.test.tsx` — render verification |
| 4 | URL matches active resource | `useWorkspaceTabs.test.tsx` — URL sync tests |
| 5 | Folder does not own tab state | `workspaceTabsIntegration.test.tsx` — move resource test |
| 6 | Resource identity survives rename | `workspaceTabsIntegration.test.tsx` — rename test |
| 7 | Deleted resources reconciled | `workspaceTabs.test.ts` — reconcileTabs tests |

**Commit:** `test(workspace): add comprehensive tab integration tests`

#### Final Hardening Pass

- Run `npm test` — all 241+ existing tests + ~60 new tests must pass
- Run `npm run lint` — 0 new errors
- Run `npx tsc --noEmit` — 0 type errors
- Run `npm run build` — successful build

**Commit:** `chore(workspace): hardening pass — fix any lint/type issues`

---

## File Summary

### New Files (11)

| File | Lines (est.) | Purpose |
|---|---|---|
| `src/lib/workspace/workspaceTabs.ts` | ~100 | Pure tab state transition functions |
| `src/lib/workspace/tabPersistence.ts` | ~40 | localStorage adapter for tab persistence |
| `src/lib/workspace/dirtyTracker.ts` | ~35 | Reactive dirty state singleton |
| `src/hooks/useWorkspaceTabs.ts` | ~120 | React hook: tab state + URL sync + persistence |
| `src/hooks/useWorkspaceKeyboard.ts` | ~60 | Keyboard shortcut handler |
| `src/components/ProjectWorkspace/WorkspaceTabBar.tsx` | ~90 | Tab bar container |
| `src/components/ProjectWorkspace/WorkspaceTabItem.tsx` | ~55 | Single tab item |
| `src/components/ProjectWorkspace/CloseTabConfirmDialog.tsx` | ~40 | Dirty tab close confirmation |
| `src/test/workspace/workspaceTabs.test.ts` | ~200 | Pure tab logic tests |
| `src/test/workspace/tabPersistence.test.ts` | ~60 | Persistence adapter tests |
| `src/test/workspace/dirtyTracker.test.ts` | ~40 | Dirty tracker tests |
| `src/test/workspace/useWorkspaceTabs.test.tsx` | ~150 | Tab hook tests |
| `src/test/components/WorkspaceTabBar.test.tsx` | ~100 | Tab bar UI tests |
| `src/test/hooks/useWorkspaceKeyboard.test.ts` | ~80 | Keyboard tests |
| `src/test/workspace/workspaceTabsIntegration.test.tsx` | ~150 | End-to-end integration tests |

### Modified Files (6)

| File | Change Size | Description |
|---|---|---|
| `src/types/workspace.ts` | +10 lines | Add `WorkspaceTab`, `WorkspaceTabsState` types |
| `src/lib/autosave.ts` | +2 lines | Import + call `dirtyTracker.markDirty/markClean` |
| `src/components/SystemArchitect/SystemArchitect.tsx` | +3 lines | Import + call `dirtyTracker.markDirty/markClean` |
| `src/pages/ProjectWorkspace.tsx` | +80 lines | Hook integration, sidebar handler, TabBar placement |
| `src/components/ProjectWorkspace/ProjectWorkspaceLayout.tsx` | +5 lines | Add `tabBar` slot prop |
| `src/test/workspace/ProjectWorkspaceNavigation.test.tsx` | ~20 lines modified | Update for tab bar presence |

### Untouched (by design, per Guide §36)

- `Editor.tsx` — no changes
- `useWorkspaceNavigation.ts` — reused as-is
- Database / migrations — no changes
- Auth / security — no changes
- Folder system — no changes
- Autosave pipeline core (`debouncedSave.ts`, `saveQueue.ts`, `tabCloseGuard.ts`, `draftRecovery.ts`) — no changes

---

## Explicitly Out of Scope (per Guide §26)

❌ Split panes
❌ Tab groups
❌ Pinned tabs
❌ Preview tabs (single-click = preview, double-click = permanent)
❌ Drag/reorder tabs
❌ Reopen closed tabs (Ctrl+Shift+T)
❌ Cross-window / multi-window tabs
❌ VS Code-level workspace restoration
❌ Keep-alive / cached editor instances for inactive tabs

---

## Verification Plan

### Automated Tests

```bash
npm test          # All existing 241+ tests + ~60 new tab tests
npm run lint      # 0 new errors
npx tsc --noEmit  # 0 type errors
npm run build     # Successful production build
```

### Manual Verification

After implementation, the user will test locally:
1. Open multiple documents and designs — verify tabs appear
2. Click tabs to switch — verify correct resource renders
3. Close tabs — verify next tab activates
4. Close dirty tab — verify confirmation dialog
5. Deep link to a resource — verify tab auto-created
6. Browser back/forward — verify correct tab activation
7. Rename resource — verify tab title updates
8. Delete resource — verify tab removed
9. Move resource between folders — verify tab unaffected
10. Refresh page — verify tabs restored
11. Keyboard shortcuts (Ctrl+W, Ctrl+Tab, Ctrl+1-9)

---

## Commit Sequence (9 commits)

```
1. feat(workspace): add tab domain model and pure state transitions
2. feat(workspace): add tab persistence adapter
3. feat(workspace): add useWorkspaceTabs hook with URL sync and persistence
4. feat(workspace): add dirty state tracker for tab indicators
5. feat(workspace): add WorkspaceTabBar and WorkspaceTabItem components
6. feat(workspace): integrate tab system into ProjectWorkspace shell
7. feat(workspace): add dirty tab close protection
8. feat(workspace): add tab keyboard shortcuts
9. test(workspace): add comprehensive tab integration tests + hardening
```
