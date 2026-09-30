# Observability, Error Taxonomy & Diagnostics

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/sync/errorTaxonomy.ts`, `src/hooks/useSyncStatus.tsx`

---

## 1. Overview

Because Artix operates locally first and synchronizes in the background, observability cannot rely exclusively on standard HTTP request logs. The client must monitor:
- Local database health and storage quotas.
- Outbox queue depths and lease expirations.
- Background sync errors, HTTP statuses, and CAS conflict counts.
- Multi-tab leadership changes.

---

## 2. Synchronization Error Taxonomy (`src/lib/sync/errorTaxonomy.ts`)

Every error encountered by `SyncEngine` or `PullEngine` is classified into an actionable category:

```typescript
export type SyncErrorKind = 
  | 'NETWORK' 
  | 'AUTH' 
  | 'CONFLICT' 
  | 'VALIDATION' 
  | 'STORAGE' 
  | 'UNKNOWN';

export function classifySyncError(error: any): {
  kind: SyncErrorKind;
  isTransient: boolean;
  message: string;
  statusCode?: number;
} {
  const status = error?.status || error?.statusCode;
  const code = error?.code;

  if (status === 409 || code === 'CONFLICT') {
    return { kind: 'CONFLICT', isTransient: false, message: error.message, statusCode: 409 };
  }
  if (status === 401 || status === 403 || code === 'PGRST301') {
    return { kind: 'AUTH', isTransient: false, message: 'Authentication expired', statusCode: status };
  }
  if (code === 'ETIMEDOUT' || code === 'FETCH_ERROR' || error?.name === 'TypeError') {
    return { kind: 'NETWORK', isTransient: true, message: 'Network connection unavailable', statusCode: 0 };
  }
  if (error?.name === 'QuotaExceededError') {
    return { kind: 'STORAGE', isTransient: false, message: 'Browser storage quota exceeded' };
  }
  return { kind: 'UNKNOWN', isTransient: true, message: error?.message || 'Unknown sync error' };
}
```

---

## 3. Client-Side Health & Status Hooks

- **`useSyncStatus` (`src/hooks/useSyncStatus.tsx`)**:
  - Exposes `isOnline`: Current browser network status (`navigator.onLine`).
  - Exposes `pendingCount`: Number of mutations currently waiting in the outbox.
  - Exposes `syncState`: Overall state (`synced`, `syncing`, `conflict`, `error`).
- **`useUserSyncRuntime` (`src/contexts/UserSyncRuntimeContext.tsx`)**:
  - Exposes `isLeader`: Whether current tab is the elected Web Lock leader.
  - Exposes `status`: Current lifecycle phase (`initializing | running | migrating | blocked | quota_exceeded | degraded | stopped`).
