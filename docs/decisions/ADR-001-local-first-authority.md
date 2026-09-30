# ADR-001: Local-First Authority over Cloud Storage

- **Status**: `ACCEPTED` / `IMPLEMENTED`
- **Date**: 2026-09-21
- **Deciders**: Architecture Team
- **Related Files**: `src/lib/local/db.ts`, `src/lib/repositories/`, `src/hooks/useDocuments.tsx`

---

## Context

In early versions of Artix, client components queried and mutated Supabase PostgreSQL directly over REST. This model produced severe user experience degradation:
1. Typing in the document editor felt sluggish under slow network connections.
2. Dropped connections caused lost drafts and corrupted editor buffers.
3. The application was completely unusable without an active internet connection.

We needed an architecture that guarantees zero latency for user actions and full operational capability offline.

---

## Decision

We decided to transition Artix to a **Local-First Architecture** where:
- The client-side database (Dexie.js on IndexedDB) is the **primary authority** for all read and write interactions.
- User operations commit locally first (0ms latency) and are buffered in a persistent outbox.
- Remote PostgreSQL functions as an asynchronous synchronization peer rather than a synchronous API gateway.

---

## Alternatives Considered

1. **Remote-First with Optimistic UI & Local Caching**:
   - *Why rejected*: Optimistic rollbacks on network failure create jarring UI flicker. Cache invalidation across tabs becomes complex and error-prone.
2. **SQLite compiled to WebAssembly (sqlite-wasm / Origin Private File System)**:
   - *Why rejected*: OPFS has inconsistent multi-tab support across older Safari/iOS versions and significantly heavier bundle size (~1.5MB wasm overhead).
3. **Raw browser `localStorage`**:
   - *Why rejected*: 5MB storage limit, synchronous blocking I/O on the main thread, and lack of indexing or transaction support.

---

## Consequences

### Positive
- Instant UI responsiveness (0ms local write latency).
- Full application functionality while offline (creation, editing, deleting, folder reorganization).
- Seamless resilience across browser reboots and network disconnections.

### Negative / Tradeoffs
- Requires dedicated background synchronization machinery (outbox, pull engine, conflict resolution).
- Client storage quotas must be actively monitored.

---

## Current Implementation

- `src/lib/local/db.ts`: User-scoped Dexie IndexedDB instances (`ArtixDB_v2_<hash>`).
- Repositories in `src/lib/repositories/` perform atomic 3-table Dexie transactions.
- Zero direct cloud read calls in UI hooks (`src/test/architecture/networkBoundary.test.ts`).
