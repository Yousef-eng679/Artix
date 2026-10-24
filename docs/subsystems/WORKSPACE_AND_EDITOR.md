# Workspace & Multi-Tab Editor Subsystem

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/pages/ProjectWorkspace.tsx`, `src/components/ProjectWorkspace/`, `src/components/Editor/`, `src/lib/workspace/`

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

### 3.1 Tab Data Model
```typescript
export interface WorkspaceTab {
  id: string;               // Unique tab ID (e.g. `doc:doc-123` or `design:des-456`)
  resourceId: string;       // Target document or design UUID
  resourceType: 'document' | 'system_design';
  title: string;            // Tab header label
  isDirty?: boolean;        // True if local unsaved edits exist in this tab
  pinned?: boolean;         // True if tab cannot be closed by middle-click
}
```

### 3.2 Tab Lifecycle Operations
- **Open Resource**: If already open, focuses existing tab; otherwise appends a new tab.
- **Close Tab**: If `isDirty` is false, closes immediately; if `isDirty` is true, renders `CloseTabConfirmDialog`.
- **Keyboard Shortcuts (`useWorkspaceKeyboard.ts`)**:
  - `Ctrl + W`: Closes current active tab.
  - `Ctrl + Tab`: Cycles sequentially through open tabs.
  - `Ctrl + Shift + Tab`: Cycles in reverse order.
  - `Ctrl + S`: Immediately flushes active document editor buffer to IndexedDB.
- **Persistence (`tabPersistence.ts`)**: The list of open tabs for each project is serialized to `localStorage` under `artix_tabs_project_<projectId>`. When reopening a project, open tabs restore automatically.

---

## 4. Document Forge Editor

Powered by Monaco Editor (`@monaco-editor/react`):

### 4.1 Multi-Language Support
Configured via `src/components/Editor/languageMap.ts`:
- Markdown (`.md`)
- TypeScript (`.ts`, `.tsx`)
- SQL schemas (`.sql`)
- JSON / YAML (`.json`, `.yaml`)
- XML specifications (`.xml`)

### 4.2 Split-Pane Live Preview & Persistent Layout
- **Preview Toggle**: A dedicated button in `EditorToolbar.tsx` toggles the preview pane on and off.
- **Preference Persistence**: User layout preferences (`showPreview: true/false`, slider ratio) persist in `localStorage` across page reloads.

### 4.3 XSS Sanitization Invariant
To prevent malicious script injection in user-rendered Markdown:
- `MarkdownPreview.tsx` renders Markdown through `react-markdown` without `rehype-raw`, so raw inline HTML (`<script>`, event attributes, `<iframe>`) is escaped as inert text rather than parsed into DOM elements.
- Link and media URLs are filtered through `sanitizeMarkdownUrl` (`urlTransform`), allowing only `http:`, `https:`, `mailto:`, and relative references.
- `javascript:`, `vbscript:`, `data:`, and protocol-relative `//` URLs are stripped.
- Verified by `src/test/security.test.ts`.

---

## 5. Hierarchical Folder DAG Subsystem

Folders form a hierarchical Directed Acyclic Graph (DAG) managed by `src/lib/workspace/groupResourcesByFolder.ts`:

- Folders can be nested arbitrarily (`parentFolderId`).
- Resources (documents, system designs) reference a `folderId` or null for root-level items.
- Moving resources between folders updates local IndexedDB atomically and schedules a topologically ordered outbox push mutation.
- Deleting a folder recursively moves or cascade-deletes descendant items with full outbox payload auditing (`affectedDocumentIds`).
