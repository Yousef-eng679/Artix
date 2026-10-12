# Sync Architecture Network Write & Read Path Inventory (Phase 0)

**Document Status:** Phase 0 Baseline Inventory  
**Target Invariant:** All direct Supabase network read and write paths for syncable entities are strictly mapped and scheduled for elimination in Phase 1.

---

## 1. Inventory Summary

| Entity | Hook / File | Call Type | Line(s) | Current Method | Target In Phase 1 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `workspace_folders` | `src/hooks/useWorkspaceFolders.tsx` | **Write (Create)** | 99–103 | `supabase.from('workspace_folders').insert(...)` | **REMOVE** — Local Dexie + Outbox only |
| `workspace_folders` | `src/hooks/useWorkspaceFolders.tsx` | **Write (Rename)** | 174–177 | `supabase.from('workspace_folders').update(...)` | **REMOVE** — Local Dexie + Outbox only |
| `workspace_folders` | `src/hooks/useWorkspaceFolders.tsx` | **Write (Delete)** | 217–220 | `supabase.from('workspace_folders').delete(...)` | **REMOVE** — Local Dexie + Outbox only |
| `workspace_folders` | `src/hooks/useWorkspaceFolders.tsx` | **Read (Query)** | 35–40 | `supabase.from('workspace_folders').select(...)` | **REMOVE** — Query reads Dexie only |
| `system_designs` | `src/hooks/useSystemDesigns.tsx` | **Write (Create)** | 130–139 | `supabase.from('system_designs').insert(...)` | **REMOVE** — Local Dexie + Outbox only |
| `system_designs` | `src/hooks/useSystemDesigns.tsx` | **Write (Update)** | 192–196 | `supabase.from('system_designs').update(...)` | **REMOVE** — Local Dexie + Outbox only |
| `system_designs` | `src/hooks/useSystemDesigns.tsx` | **Write (Delete)** | 230–235 | `supabase.from('system_designs').delete(...)` | **REMOVE** — Local Dexie + Outbox only |
| `system_designs` | `src/hooks/useSystemDesigns.tsx` | **Read (Query)** | 67–72 | `supabase.from('system_designs').select(...)` | **REMOVE** — Query reads Dexie only |
| `documents` | `src/hooks/useDocuments.tsx` | **Write (Create)** | 114–125 | `supabase.from('documents').insert(...)` | **REMOVE** — Local Dexie + Outbox only |
| `documents` | `src/hooks/useDocuments.tsx` | **Write (Update)** | 185–195 | `supabase.from('documents').update(...)` | **REMOVE** — Local Dexie + Outbox only |
| `documents` | `src/hooks/useDocuments.tsx` | **Write (Delete)** | 224–227 | `supabase.from('documents').delete(...)` | **REMOVE** — Local Dexie + Outbox only |
| `documents` | `src/hooks/useDocuments.tsx` | **Read (Query)** | 39–46 | `supabase.from('documents').select(...)` | **REMOVE** — Query reads Dexie only |

---

## 2. Authorized Future Network Path

Only **one** subsystem is authorized to communicate with Supabase for syncable workspace entities:

```text
src/lib/sync/syncEngine.ts -> pushMutationToCloud()
  ├── documents: upsert / update / delete
  ├── system_designs: upsert / update / delete
  └── workspace_folders: insert / update / delete
```

All UI hooks (`useDocuments`, `useSystemDesigns`, `useWorkspaceFolders`) must read and write strictly to the local repository.
