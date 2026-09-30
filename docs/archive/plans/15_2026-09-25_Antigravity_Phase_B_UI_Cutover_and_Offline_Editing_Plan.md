# 🚀 Phase B Implementation Plan: UI Cutover to Local Authority & Offline Editing

> **Branch:** `feat/offline-first-indexeddb` (Branch remains isolated; `main` is untouched)  
> **Milestones:** M2 (Local-First Documents & System Designs) & M3 (Offline Workspace Navigation & Local Autosave)  
> **Prerequisites:** Phase A completed (IndexedDB schema and repositories operational with 346/346 passing tests).

---

## 1. Executive Summary & Objective

In **Phase A**, we built and tested `ArtixDB` and the three repositories (`DocumentRepository`, `SystemDesignRepository`, `WorkspaceFolderRepository`) in complete isolation.

In **Phase B**, we perform **The Cutover**:
We connect the live UI and workspace hooks to the local repositories.
The fundamental rule of this phase is:
> **"A user's local write to IndexedDB is the save. Cloud synchronization is a separate background concern."**

When a user edits a document or system design:
1. The update is committed immediately (< 5ms) to **IndexedDB**.
2. The UI and React Query cache update instantly with zero spinners and zero latency.
3. If the user is online, the change is mirrored to Supabase.
4. **If the user is offline, the operation still succeeds seamlessly** without throwing errors or showing failed-save toasts.
5. Edits, new documents, new designs, and folder reorganization survive browser reloads and offline sessions completely.

---

## 2. User Review Required

> [!IMPORTANT]
> **Zero Breaking Changes to Existing Hook APIs:**  
> The return signatures of `useDocuments`, `useSystemDesigns`, and `useWorkspaceFolders` will remain **100% identical** to what `ProjectWorkspace.tsx` and child components expect. Components will continue consuming `{ documents, createDocument, updateDocument, deleteDocument }`, but the implementation under the hood becomes **Local-First with Cloud Hydration**.

> [!NOTE]
> **Offline Error Toast Suppression:**  
> Currently, if `updateDocument` fails over the network, `ProjectWorkspace.tsx` displays `toast.error('Failed to save document')`. In Phase B, because local persistence in IndexedDB succeeds, network errors will no longer mark the document save as failed. A save to IndexedDB is considered a successful save.

---

## 3. Proposed Changes (Step by Step)

### 3.1 Local Storage Seeding & Hybrid Hook Layer

#### [MODIFY] [`src/hooks/useDocuments.tsx`](file:///c:/Fenix-main/src/hooks/useDocuments.tsx)
- Inject `DocumentRepository` into `useDocuments`:
  - **Query (`documentsQuery`):**
    1. Read immediately from `documentRepository.listByProject(user.id, projectId)` in IndexedDB.
    2. In the background (or on initial load when online), fetch from Supabase.
    3. Seed/merge any remote documents into IndexedDB (preserving higher local revisions).
  - **Mutation (`createDocumentMutation`):**
    1. Write immediately to `documentRepository.create(...)` in IndexedDB.
    2. Optimistically update React Query cache.
    3. If online, send `insert` to Supabase in the background; if offline, catch gracefully without failing the user action.
  - **Mutation (`updateDocumentMutation`):**
    1. Write immediately to `documentRepository.update(id, updates)` in IndexedDB.
    2. Bump `localRevision` and update local timestamp.
    3. If online, send `update` to Supabase; if offline, catch gracefully.
  - **Mutation (`deleteDocumentMutation`):**
    1. Soft-delete in `documentRepository.delete(id)`.
    2. If online, delete from Supabase; if offline, mark as deleted locally.

#### [MODIFY] [`src/hooks/useSystemDesigns.tsx`](file:///c:/Fenix-main/src/hooks/useSystemDesigns.tsx)
- Inject `SystemDesignRepository` into `useSystemDesigns`:
  - **Query:** Read immediately from `systemDesignRepository.listByProject(user.id, projectId)` in IndexedDB. Fetch and hydrate from Supabase when online.
  - **Mutations (`createDesign`, `updateDesign`, `deleteDesign`):**
    1. Immediate transactional commit to `SystemDesignRepository` in IndexedDB (storing full `boardState` including `nodes`, `edges`, `strokes`).
    2. Background write to Supabase when online.
    3. Zero latency on canvas updates; works 100% offline.

#### [MODIFY] [`src/hooks/useWorkspaceFolders.tsx`](file:///c:/Fenix-main/src/hooks/useWorkspaceFolders.tsx)
- Inject `WorkspaceFolderRepository` into `useWorkspaceFolders`:
  - Immediate local reads from IndexedDB.
  - Create, rename, and delete operations execute against `WorkspaceFolderRepository` with local case-insensitive duplicate validation.
  - Sync with Supabase when online.

---

### 3.2 Autosave & Workspace Integration

#### [MODIFY] [`src/pages/ProjectWorkspace.tsx`](file:///c:/Fenix-main/src/pages/ProjectWorkspace.tsx)
- Update `handleSaveDocument`:
  - Saves through `updateDocument`, which is now local-first.
  - Remove network-failure toast blocking (since local save succeeded).
- Update `handleSaveDesign`:
  - Saves through `updateDesign`, persisting full canvas state to IndexedDB.

---

### 3.3 Automated Verification Suite for Phase B

#### [NEW] [`src/test/workspace/offlineDocuments.test.tsx`](file:///c:/Fenix-main/src/test/workspace/offlineDocuments.test.tsx)
- Comprehensive test suite exercising:
  1. Creating and updating documents while completely offline.
  2. Verifying edits are retrieved from IndexedDB without network requests.
  3. Verifying soft deletion hides document offline.
  4. Verifying offline-created documents survive component remounts.

#### [NEW] [`src/test/workspace/offlineSystemDesigns.test.tsx`](file:///c:/Fenix-main/src/test/workspace/offlineSystemDesigns.test.tsx)
- Comprehensive test suite exercising:
  1. Canvas boardState updates saved to IndexedDB while offline.
  2. Restoring large node/edge hierarchies offline.

#### [NEW] [`src/test/workspace/offlineWorkspaceFolders.test.tsx`](file:///c:/Fenix-main/src/test/workspace/offlineWorkspaceFolders.test.tsx)
- Verifying folder creation, renaming, and nesting operations execute offline.

---

## 4. Verification Plan

### Automated Tests
1. Run new offline integration test suites:
   ```bash
   npm test -- src/test/workspace/offline* --run
   ```
2. Run full test suite across the entire project:
   ```bash
   npm test -- --run
   ```
   (Target: 100% passing across all 45+ test files).
3. Type-check:
   ```bash
   npx tsc --noEmit
   ```
4. Production build:
   ```bash
   npm run build
   ```

### Manual Verification
- Launch dev server (`npm run dev`), open a workspace, toggle browser network to "Offline" in Chrome DevTools Network tab.
- Create a new document, type content, create a new folder, draw on system design canvas.
- Reload page while remaining offline: verify all resources, tabs, and content load instantly from IndexedDB!
