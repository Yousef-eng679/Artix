# System Architect Canvas Subsystem

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/components/SystemArchitect/SystemArchitect.tsx`, `src/components/SystemArchitect/ArchitectNode.tsx`, `src/components/SystemArchitect/AlgorithmNodeTemplates.ts`, `src/components/SystemArchitect/DrawingCanvas.tsx`, `src/hooks/useSystemDesigns.tsx`, `src/lib/repositories/systemDesignRepository.ts`

---

## 1. Overview

The **System Architect** is an interactive visual canvas built inside Artix for blueprinting cloud architectures, microservice graphs, distributed event flows, and algorithm data structures.

Architectural designs are saved as first-class workspace entities, synchronized locally via IndexedDB (`ArtixDB.system_designs`) and replicated to Supabase PostgreSQL via `public.apply_sync_mutation` with strict CAS version protection.

---

## 2. Canvas Engine Architecture

Powered by React Flow (`@xyflow/react`) and `@dagrejs/dagre`:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SystemArchitect Canvas                             │
├────────────────────────────┬────────────────────────────────────────────────┤
│ Mode & Template Toolbar    │ Interactive Node-Graph & Freehand Canvas       │
│  [System Mode | Algo Mode] │                                                │
│  [+ Database]              │  ┌──────────────┐       ┌──────────────┐       │
│  [+ Server]                │  │  API Gateway ├──────►│    Server    │       │
│  [+ Frontend]              │  └──────────────┘       └──────┬───────┘       │
│  [+ Cloud / API / Storage] │                                │               │
│  [+ Custom (6 colors)]     │                                ▼               │
│  [Draw / Erase Overlay]    │                         ┌──────────────┐       │
│  [Auto Layout | AI Gen]    │                         │   Database   │       │
│                            │                         └──────────────┘       │
├────────────────────────────┴────────────────────────────────────────────────┤
│ Canvas Controls: MiniMap | Zoom Controls | Auto-Save & Stale-Buffer Guard   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Dual-Mode Node Catalog (`ArchitectNode.tsx` & `AlgorithmNodeTemplates.ts`)

All canvas nodes render through `src/components/SystemArchitect/ArchitectNode.tsx` (`type: 'architect'`), backed by two mode-selectable template catalogs in `src/components/SystemArchitect/AlgorithmNodeTemplates.ts`:

| Mode | Template Categories | Persistable Node Attributes |
|---|---|---|
| **System Mode** (`systemDesignTemplates`, 7 templates) | `database`, `server`, `frontend`, `cloud`, `api`, `storage`, and `custom` (with 6-color palette: `blue`, `green`, `purple`, `cyan`, `orange`, `pink`) | Inline-editable `label` (`updateNodeLabel`), `color`, `customColor`, `icon`, `nodeType`, `position` |
| **Algorithm Mode** (`algorithmTemplates`, 17 templates across 4 categories) | **Sorting** (`array`, `comparator`, `swap`, `partition`), **Graph & Tree** (`tree-node`, `graph-vertex`, `visited`, `queue-bfs`, `stack-dfs`), **Data Structures** (`linked-node`, `stack`, `queue`, `hash-table`, `heap`), **General** (`variable`, `pointer`, `condition`, `output`) | Inline-editable `label`, category color, `position` |

- **Collision-Free UUIDs**: New nodes and edges are assigned `node-${crypto.randomUUID()}` and `edge-${crypto.randomUUID()}` identifiers so concurrent edits across tabs or devices never collide on counter-based IDs.
- **Auto Layout (`@dagrejs/dagre`)**: One-click layout arranges graphs left-to-right (`LR`) in System Mode and top-to-bottom (`TB`) in Algorithm Mode.
- **AI Architecture Generator**: `ArchitectureGeneratorDialog.tsx` compiles natural-language system or algorithm prompts into laid-out `BoardState` graphs.

---

## 4. Canvas State Model (`BoardState`)

Defined in `src/hooks/useSystemDesigns.tsx`:

```typescript
export interface BoardState {
  nodes: Array<{
    id: string;
    type?: string;
    position: { x: number; y: number };
    data: {
      label: string;
      color?: string;
      customColor?: string;
      icon?: string;
      nodeType?: string;
      [key: string]: unknown;
    };
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    label?: string;
    animated?: boolean;
    style?: Record<string, unknown>;
  }>;
  strokes?: Array<{
    id?: string;
    points: Array<{ x: number; y: number }>;
    color: string;
    width: number;
  }>;
}
```

---

## 5. Resilient Auto-Save Pipeline & Stale-Buffer Protection

When nodes, inline labels, custom colors, edges, or freehand strokes (`DrawingCanvas.tsx`) are modified:
1. `SystemArchitect.tsx` tracks a canonical JSON baseline (`lastSavedBoardJsonRef`) and suppresses redundant saves on initial mount or mid-drag (`isDraggingNodeRef` defers auto-save until `onNodeDragStop`).
2. A debounced timer (**1000ms**) invokes `SystemDesignRepository.update(designId, { boardState }, { expectedLocalRevision })`.
3. `SystemDesignRepository` verifies `expectedLocalRevision === existing.localRevision` (throwing `StaleBufferError` if a remote pull updated the board while local edits were dirty) and commits an atomic 3-table Dexie transaction (`[system_designs, outbox, sync_metadata]`).
4. **External Change Handling**:
   - If the canvas buffer is **clean** when a remote pull or cross-tab broadcast updates `localRevision`, the canvas hot-reloads the new `boardState` automatically.
   - If the canvas buffer is **dirty**, auto-save pauses and `data-testid="stale-buffer-banner"` offers **Load remote (discard mine)**, **Keep mine**, or **Save mine as copy**.
5. If the user closes the tab with unsaved changes, `src/lib/cache/tabCloseGuard.ts` flushes a crash-recovery draft strictly to user-scoped `localStorage`.
