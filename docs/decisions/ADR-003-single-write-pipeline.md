# ADR-003: Single Unidirectional Write Pipeline

- **Status**: `ACCEPTED` / `IMPLEMENTED`
- **Date**: 2026-09-26
- **Deciders**: Architecture Team
- **Related Files**: `src/lib/repositories/`, `src/hooks/useDocuments.tsx`, `src/test/repositories/atomicMutation.test.ts`

---

## Context

In early prototypes, mutations occurred through disparate pathways: some components called Supabase REST endpoints, while others wrote to local state or `localStorage`. This resulted in race conditions where the UI showed one state, the outbox had another, and IndexedDB had a third.

---

## Decision

We instituted a **Single Unidirectional Write Pipeline**:
1. All entity mutations MUST pass through domain repository methods (`create`, `update`, `delete`).
2. Every repository mutation MUST execute inside an **atomic 3-table Dexie transaction**:
   ```typescript
   await db.transaction('rw', [db.entities, db.outbox, db.sync_metadata], async () => { ... });
   ```
3. Direct cloud writes from UI components or hooks are strictly prohibited.

---

## Alternatives Considered

1. **Dual Writes (Write to Local DB and Fire-and-Forget Cloud Request)**:
   - *Why rejected*: If the local write succeeds but the cloud request fails mid-transit, state drifts. If the network is down, the cloud request errors out, complicating error management in UI components.
2. **Event Sourcing with Full CQRS**:
   - *Why rejected*: Excessive complexity for document specifications. Storing complete event logs locally consumes browser storage quotas rapidly.

---

## Consequences

### Positive
- Guaranteed atomicity: an entity cannot be updated locally without scheduling an outbox mutation and marking sync metadata pending.
- Complete decoupling of UI components from network latency or cloud errors.
- Clean and testable architecture.

### Negative / Tradeoffs
- Every domain mutation requires maintaining consistent types across entity, outbox, and sync metadata tables.

---

## Current Implementation

- `src/lib/repositories/documentRepository.ts`
- `src/lib/repositories/systemDesignRepository.ts`
- `src/lib/repositories/folderRepository.ts`
- Verified by `src/test/repositories/atomicMutation.test.ts`.
