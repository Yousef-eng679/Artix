# Workspace & Multi-Tab Editor Subsystem

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/pages/ProjectWorkspace.tsx`, `src/components/ProjectWorkspace/`, `src/components/Editor/`, `src/components/Editor/monacoSetup.ts`, `src/components/ConflictResolutionModal.tsx`, `src/components/SyncStatusBanner.tsx`, `src/lib/workspace/`

---

## 1. Overview

The Workspace is the primary user-facing workstation in Artix. It unifies project navigation, hierarchical folder structures, multi-tab document editing, and visual architecture design into a single responsive shell.

---

## 2. Workspace Shell & Navigation Architecture

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ProjectWorkspace Shell                            │
├───────────────────┬─────────────────────────────────────────────────────────┤
│                   │ WorkspaceTabBar (`WorkspaceTabBar.tsx`)                 │
│                   │ [Doc: API Contract] [Design: Gateway] [Doc: DB Schema*]│
│                   ├─────────────────────────────────────────────────────────┤
│ ProjectSidebar    │                                                         │
│                   │ Active Resource Editor Surface                          │
│ 📁 Specifications │                                                         │
│   ├── 📄 Arch Spec│ ┌───────────────────────────┬─────────────────────────┐ │
│   └── 📄 DB Schema│ │ Monaco Editor             │ Split-Pane Live Preview │ │
│ 📁 Diagrams       │ │ (Syntax Highlighting,     │ (AST-Escaped Markdown   │ │
│   └── 📐 Core Flow│ │  Auto-Indentation,        │  & Safe-URI Protocol    │ │
│                   │ │  Key Bindings)            │  Preview Rendering)     │ │
│                   │ └───────────────────────────┴─────────────────────────┘ │
└───────────────────┴─────────────────────────────────────────────────────────┘
```

---

## 3. The Multi-Tab Subsystem

Managed by `useWorkspaceTabs` (`src/hooks/useWorkspaceTabs.ts`) and `workspaceTabs.ts`:

### 3.1 Tab Data Model (`src/types/workspace.ts`)
```typescript
export type ResourceKind = 'document' | 'design';

export interface WorkspaceTab {
  id: string;               // Unique tab ID (`document:<uuid>` or `design:<uuid>` via buildTabId)
  resourceKind: ResourceKind;
  resourceId: string;       // Target document or design UUID
}

export interface WorkspaceTabsState {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
}
```
*(Tab titles and dirty indicators are resolved dynamically at render time from live workspace resources and `src/lib/workspace/dirtyTracker.ts`, preventing stale titles after renames.)*

### 3.2 Tab Lifecycle Operations
- **Open Resource & Cold Deep-Link Guard**: Opening a resource focuses an existing tab or appends a new one. On cold deep links (`/projects/:id?doc=:docId`), `ProjectWorkspace.tsx` waits for initial online hydration (`isInitialOnlineHydrating`) and post-hydration query refetches (`isInitialRefetchPending`) before reconciling tabs or stripping URL parameters.
- **Close Tab**: If clean, closes immediately; if dirty in `dirtyTracker`, renders `CloseTabConfirmDialog`.
- **Keyboard Shortcuts (`useWorkspaceKeyboard.ts`)**:
  - `Ctrl/Cmd + W`: Closes current active tab.
  - `Ctrl/Cmd + Tab`: Cycles forward through open tabs.
  - `Ctrl/Cmd + Shift + Tab`: Cycles backward through open tabs.
  - `Ctrl/Cmd + 1..9`: Jumps directly to tab index.
- **User-Scoped Persistence (`tabPersistence.ts`)**: Open tabs for each project are serialized to `localStorage` under `artix.workspace.tabs.<userScopeHash>.<projectId>`, preventing cross-account tab state leakage on shared browsers.

---

## 4. Document Forge Editor

Powered by locally bundled Monaco Editor (`src/components/Editor/monacoSetup.ts` + `@monaco-editor/react`):

### 4.1 Offline Bundled Setup & Supported Formats
- **Zero-CDN Monaco Bundle (`monacoSetup.ts`)**: Imports `monaco-editor` (`0.57.0`), registers a local Vite web worker (`editor.worker?worker`), and preloads `markdown` and `xml` tokenizers so the editor mounts and accepts typing on offline cold starts.
- **Supported `DocumentFormat` Modes (`src/components/Editor/languageMap.ts`)**:
  - `'markdown'` (`.md`)
  - `'xml'` (`.xml`)
  - `'text'` (`.txt`, Monaco `'plaintext'`)
- **Document Export (`src/lib/documentExport.ts` + `ExportDialog.tsx`)**: Exports native `.md`/`.xml`/`.txt` on all tiers, and styled `.html` / print-ready `.pdf` on the Pro tier.

### 4.2 Split-Pane Live Preview, Auto-Save & Stale-Buffer Guard
- **Preview Toggle**: A dedicated toggle in `Editor.tsx` shows/hides the 50/50 split preview pane and persists the boolean preference in `localStorage` under `'artix.editor.showPreview'`.
- **Stale-Buffer Overwrite Protection (`StaleBufferError`)**: `Editor.tsx` tracks the `localRevision` its buffer was derived from and passes `expectedLocalRevision` to `DocumentRepository.update()` (1000ms debounce). If a remote pull or peer tab updates the document while the local buffer is **clean**, the editor silently replaces its buffer with the new content; if the local buffer is **dirty**, auto-save pauses and `data-testid="stale-buffer-banner"` offers **Load remote (discard mine)**, **Keep mine**, or **Save mine as copy**.
- **Conflict & Sync Status Centers**: `ProjectWorkspaceLayout.tsx` (and `Dashboard.tsx`) mounts `<ConflictResolutionCenter />` (`ConflictResolutionModal.tsx`) and `<SyncStatusBanner />` (`SyncStatusBanner.tsx`).

### 4.3 XSS Sanitization Invariant
To prevent malicious script injection in user-rendered Markdown:
- `MarkdownPreview.tsx` renders Markdown through `react-markdown` (`remark-gfm`) without `rehype-raw`, so raw inline HTML (`<script>`, event attributes, `<iframe>`) is escaped as inert text rather than parsed into DOM elements.
- Link and media URLs are filtered through `sanitizeMarkdownUrl` (`urlTransform`), allowing only `http:`, `https:`, `mailto:`, and relative references while stripping `javascript:`, `vbscript:`, `data:`, and protocol-relative `//` URLs.
- Verified by `src/test/security.test.ts`.

---

## 5. Hierarchical Folder DAG Subsystem

Folders form a hierarchical Directed Acyclic Graph (DAG) managed by `src/lib/workspace/groupResourcesByFolder.ts` and `FolderRepository`:

- Folders can be nested arbitrarily (`parentFolderId`) with cycle detection and case-insensitive sibling name uniqueness.
- Resources (documents, system designs) reference a `folderId` or `null` for root-level items.
- Moving resources between folders updates local IndexedDB atomically and schedules a topologically ordered outbox push mutation.
- Deleting a folder (`FolderRepository.delete`) runs a 5-table atomic Dexie transaction that soft-deletes the folder and descendant subfolders while moving child documents and system designs to root (`folderId = null`, matching PostgreSQL `ON DELETE SET NULL`).
