# Observability, Error Taxonomy & Diagnostics

> **Status**: `IMPLEMENTED`  
> **Version**: `v2.5.0`  
> **Verified Against**: `src/lib/sync/errorTaxonomy.ts`, `src/hooks/useSyncStatus.tsx`, `src/lib/sync/userSyncRuntime.ts`, `src/contexts/UserSyncRuntimeContext.tsx`, `src/components/SyncStatusBanner.tsx`

---

## 1. Overview

Because Artix operates locally first and synchronizes asynchronously in the background, client observability tracks:
- Local IndexedDB durability (`navigator.storage.persist()`) and byte-level storage estimates (`usageBytes`, `quotaBytes`).
- Outbox queue depth (`pendingCount`), blocked entries (`blockedCount`), lease ownership, and backoff timers (`nextRetryAt`).
- Deterministic classification of network, rate-limit, auth, quota, schema, and CAS conflict errors.
- Multi-tab Web Locks leadership and cloud-sync pause states during offline sessions.

---

## 2. Synchronization Error Taxonomy (`src/lib/sync/errorTaxonomy.ts`)

Every error encountered by `SyncEngine` or `PullEngine` is normalized by `classifySyncError(error: unknown): ClassifiedSyncError` into one of **17** deterministic `SyncErrorCode` values:

```typescript
export type SyncErrorCode =
  | 'NETWORK_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'REQUEST_TIMEOUT'
  | 'ETIMEDOUT'
  | 'AUTH_EXPIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'UNRESOLVED_CONFLICT_MARKERS'
  | 'DUPLICATE_NAME'
  | 'CONFLICT'
  | 'SERVER_ERROR'
  | 'STORAGE_QUOTA'
  | 'SCHEMA_ERROR'
  | 'RATE_LIMITED'
  | 'TIER_LIMIT_EXCEEDED'
  | 'UNKNOWN';

export interface ClassifiedSyncError {
  code: SyncErrorCode;
  category: SyncErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
  /** Server-requested minimum delay before retrying (from `Retry-After`), capped at MAX_SYNC_BACKOFF_MS. */
  retryAfterMs?: number;
  rawError?: unknown;
}

export const MAX_SYNC_BACKOFF_MS = 300_000; // 5-minute ceiling
```

### Key Classification Rules
- **Rate Limiting (`RATE_LIMITED`, HTTP `429`)**: Marked `retryable: true`. `parseRetryAfterMs()` parses HTTP `Retry-After` headers (delta-seconds or HTTP-date) clamped to `[0, MAX_SYNC_BACKOFF_MS]` (`300,000ms`), and `SyncEngine` reschedules `nextRetryAt` without burning permanent `attemptCount` exhaustion.
- **Server Plan Quotas (`TIER_LIMIT_EXCEEDED`)**: Matches PostgreSQL `check_plan_tier_limit()` exceptions (`Free tier ... limit (...) reached` / `Pro tier project limit (100) reached`). Marked `retryable: false`, moving the outbox entry to `blocked` and surfacing an Upgrade CTA in `SyncStatusBanner`.
- **Local Browser Storage Exhaustion (`STORAGE_QUOTA`)**: Matched strictly via `isLocalQuotaExceeded()` (`DOMException` `name === 'QuotaExceededError'` or `code === 22`, unwrapping Dexie `.inner` causes) — never by substring matching `"quota"` in server error strings.
- **Unresolved Conflict Markers (`UNRESOLVED_CONFLICT_MARKERS`)**: Blocks pushes when a document still contains `<<<<<<<` / `=======` / `>>>>>>>` markers (`retryable: false`).
- **CAS & Constraint Errors**:
  - `INVALID_CAS_BASELINE` / SQLSTATE `22023` / HTTP `400` -> `VALIDATION_FAILED` (`retryable: false`).
  - SQLSTATE `23505` on `workspace_folders_project_name_idx` -> `DUPLICATE_NAME` (`retryable: false`); other unique/409 collisions -> `CONFLICT` (`retryable: false`).
  - PostgREST `PGRST202` / PostgreSQL `42883` / `42703` -> `SCHEMA_ERROR` (`retryable: false`).
- **Auth & Transport**:
  - HTTP `401` / `PGRST301` / expired JWT -> `AUTH_EXPIRED` (`retryable: false` until session refresh).
  - HTTP `403` / RLS `42501` -> `FORBIDDEN` (`retryable: false`).
  - `OFFLINE_SESSION_PAUSED` / `!navigator.onLine` / `TypeError: Failed to fetch` / `5xx` -> `NETWORK_UNAVAILABLE`, `NETWORK_ERROR`, `REQUEST_TIMEOUT`, `ETIMEDOUT`, or `SERVER_ERROR` (`retryable: true`).

---

## 3. Client-Side Health, Runtime & Banner Surfaces

### `useSyncStatus()` (`src/hooks/useSyncStatus.tsx`)
Returns `UseSyncStatusReturn`:
- `isOnline: boolean` — Current connectivity state tracked by `SyncEngine`.
- `isSyncing: boolean` — `true` while an active push/pull cycle is running.
- `pendingCount: number` — Count of `pending` / `in_flight` outbox mutations for the active user.
- `blockedCount: number` — Count of `blocked` / `failed` outbox mutations awaiting user action or retry.
- `lastSyncedAt: Date | null` — Timestamp of the most recent completed sync cycle.
- `error: { code: string; message: string } | null` — Most recent classified sync error.
- `triggerSync(): Promise<void>` — Immediately triggers a sync cycle.
- `retryBlocked(): Promise<number>` — Re-queues blocked/failed entries via `OutboxRepository.retryAllBlocked()` and triggers sync.

### `SyncStatusBanner` (`src/components/SyncStatusBanner.tsx`)
Mounted in `Dashboard` and `ProjectWorkspaceLayout` to surface actionable recovery controls whenever `blockedCount > 0` or a non-transient error occurs:
- Displays tailored guidance for `TIER_LIMIT_EXCEEDED` (links to `/pricing`), `STORAGE_QUOTA`, `UNRESOLVED_CONFLICT_MARKERS`, and general blocked mutations, alongside a 1-click **Retry Sync** button wired to `retryBlocked()`.

### `useUserSyncRuntime()` (`src/contexts/UserSyncRuntimeContext.tsx` & `src/lib/sync/userSyncRuntime.ts`)
- **`RuntimeState`**: `'uninitialized' | 'starting' | 'running' | 'degraded' | 'errored' | 'stopped'`.
- **`RuntimeStatus`**: `{ state, userId, isStarted, isHydrated, isDegraded, isCloudSyncPaused, storagePersisted, usageBytes, quotaBytes, error, migration }`.
- **Context Value**: Exposes `{ runtime, db, projectRepo, documentRepo, folderRepo, systemDesignRepo, outboxRepo, syncEngine, tabCoordinator, realtimeSync, isReady, isHydrated, runtimeStatus, isDegraded, runtimeError }`.
