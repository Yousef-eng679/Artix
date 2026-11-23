# Artix Application & Session Lifecycle

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/sync/userSyncRuntime.ts`, `src/contexts/UserSyncRuntimeContext.tsx`, `src/hooks/useAuth.tsx`, `src/lib/auth/offlineSession.ts`, `src/test/sync/userSyncRuntimeLifecycle.test.tsx`, `src/test/sync/offlineLifecycleMatrix.test.ts`, `src/test/sync/multiAccountEvictionAndStorageScope.test.tsx`

---

## 1. Overview

Artix decouples browser session initialization from persistent data ownership. The synchronization runtime, local database instances, and cloud connections are strictly scoped to the authenticated user's session lifecycle—and remain available offline even when a cached JWT has expired (`recoverOfflineSessionFromStorage`).

---

## 2. Complete Lifecycle Flow

```text
Browser Launch (`src/main.tsx`: purges legacy `supabase-api-cache` via `clearSensitiveBrowserCaches`)
      │
      ▼
┌──────────────┐
│  React App   │ ──► Auth Provider Mounts (`src/hooks/useAuth.tsx`)
└──────┬───────┘
       │
       ├─── No User & No Stored Session
       │        │
       │        ▼
       │   Render Public Routes (/auth, /pricing)
       │   Zero Database Instances Active
       │
       └─── User Authenticated (Live Session OR Offline Recovered Session)
                │
                ▼
       ┌────────────────────────────────────────────────────────┐
       │             UserSyncRuntimeProvider Mounts             │
       │     (`src/contexts/UserSyncRuntimeContext.tsx`)        │
       └────────────────────────┬───────────────────────────────┘
                                │
                                ▼
       ┌────────────────────────────────────────────────────────┐
       │              openUserRuntime(userId, options)          │
       │         (`src/lib/sync/userSyncRuntime.ts`)            │
       └────────────────────────┬───────────────────────────────┘
                                │
                                ├── 1. Request Durable Storage (`navigator.storage.persist()`)
                                ├── 2. Open User DB (`ArtixDB_v2_<hash>`, schema v3, 8 tables)
                                ├── 3. Execute Legacy DB Migration (`migrateLegacyArtixDB` + CAS heal)
                                ├── 4. Recover Crashed Outbox Leases (`recoverStaleLeases`)
                                ├── 5. Initialize Repositories (Project, Folder, Document, Design, Outbox, Conflict, Meta)
                                ├── 6. Read `database_meta['hydration_complete']` (`isHydrated`)
                                ├── 7. Instantiate Engines (SyncEngine, PullEngine, TabCoordinator)
                                ├── 8. Acquire Web Lock Leadership (`acquireLeaderLock`)
                                └── 9. Start Realtime Listener (`RealtimeSyncManager.start`, paused if offline JWT expired)
                                │
                                ▼
       ┌────────────────────────────────────────────────────────┐
       │                Runtime State: 'running'                │
       │  React hooks consume repositories from Context API     │
       └────────────────────────────────────────────────────────┘
```

---

## 3. Detailed Lifecycle Transitions

### 3.1 Startup, Offline Cold-Start & Authentication Initialization
1. **Online Startup**: `useAuth` calls `supabase.auth.getSession()`. When `user.id` is present, `UserSyncRuntimeProvider` transitions runtime state to `'starting'` and invokes `openUserRuntime(userId)`.
2. **Offline Expired-JWT Continuity (`src/lib/auth/offlineSession.ts`)**: If the user cold-starts the app offline (or token refresh fails due to network loss) after their cached JWT's `exp` timestamp has elapsed:
   - `recoverOfflineSessionFromStorage()` parses the persisted Supabase session token (`sb-<host>-auth-token`) in `localStorage` and restores the user identity with `isOfflineSession = true`.
   - `UserSyncRuntimeProvider` opens the user's `ArtixDB_v2_<hash>` database and pauses cloud traffic (`runtime.setCloudSyncPaused(true)`) so all local projects, folders, documents, and designs remain 100% readable and editable offline.
   - When connectivity returns, `useAuth` attempts `supabase.auth.refreshSession()`. If the refresh succeeds, cloud sync unpauses and drains the outbox; if the server rejects the refresh with a fatal `4xx` (`invalid_grant`), `reauthRequired = true` surfaces the non-destructive `reauth-sync-banner` without wiping local IndexedDB drafts.
3. **Database Initialization & Crash Recovery**:
   - Requests `navigator.storage.persist()` and samples `navigator.storage.estimate()`.
   - Opens `ArtixDB_v2_<hash>` (schema v3, 8 tables) and runs `migrateLegacyArtixDB` (including healing legacy null `baseServerVersion` values from `sync_metadata`).
   - Reclaims any `in_flight` outbox entries whose 30-second lease has expired (`leaseExpiresAt < Date.now()`) back to `state: 'pending'`.
   - Reads `database_meta['hydration_complete']` and exposes `isHydrated` so deep-linked routes (`/projects/:id?doc=:docId`) wait for initial hydration before reconciling workspace tabs.

### 3.2 Account Switching (User A -> User B)
Artix guarantees **zero cross-tenant cache or storage leakage**:
1. When User A signs out or switches to User B:
   - `closeUserRuntime(userA)` stops Realtime subscriptions, aborts in-flight sync and retry timers, releases the Web Lock, closes the `BroadcastChannel` (`evictTabCoordinator(userA)`), evicts the `SyncEngine` singleton, and closes/evicts `ArtixDB_v2_<hash_A>` (`closeUserArtixDB(userA)`).
   - `useAuth` clears the TanStack `queryClient.clear()` and `dirtyTracker.clearAll()`, and purges sensitive browser caches (`clearSensitiveBrowserCaches()`).
   - All `localStorage` draft keys and workspace tab keys are partitioned by `getUserScopeHash(userId)` (`artix.workspace.tabs.<userHash>.<projectId>`).
2. User B's isolated database `ArtixDB_v2_<hash_B>` is then mounted cleanly (verified by Scenario H in `correctnessMatrix.test.ts` and `multiAccountEvictionAndStorageScope.test.tsx`).

### 3.3 Sign-Out & Shutdown
When a user signs out:
1. `closeUserRuntime(userId)` is invoked.
2. In-flight timers, Realtime channels, `TabCoordinator`, and `SyncEngine` singletons are torn down and evicted.
3. The Web Lock (`navigator.locks`) is aborted and released.
4. The Dexie database connection is closed and removed from `dbInstances`, `queryClient` and `dirtyTracker` are cleared, and `clearSensitiveBrowserCaches()` removes any legacy caches.
5. Runtime state transitions to `'stopped'`.

---

## 4. Multi-Tab Lifecycle & Storage Upgrades

```text
Tab 1 (Active Leader)                      Tab 2 (Standby)
       │                                         │
Holds Web Lock: artix_sync_leader_lock           Waits on Web Lock (navigator.locks)
       │                                         │
Performs Local Writes                             Performs Local Writes
Drains Outbox to Cloud                            Sends REQUEST_SYNC via BroadcastChannel
       │                                         │
[Tab 1 Closes or Crashes]                        │
       │                                         │
Browser Kernel Releases Lock ───────────────────► Instantly Claims Web Lock!
                                                 Becomes Leader
                                                 Reclaims Crashed Leases
                                                 Resumes Cloud Outbox Drain
```

### IndexedDB `versionchange` Handling
When an application deployment introduces an updated IndexedDB schema version, open tabs must not block the database upgrade:
```typescript
this.on('versionchange', () => {
  console.warn(`[ArtixDB] Database schema version change detected for ${dbName}. Closing connection.`);
  this.close();
});
```
1. Browser fires `versionchange` on older tabs when a new tab opens with an updated schema version.
2. Artix immediately closes idle connections.
3. The upgrading tab proceeds without `blocked` deadlocks.

---

## 5. Runtime State Taxonomy (`RuntimeState` & `RuntimeStatus`)

Defined in `src/lib/sync/userSyncRuntime.ts` (`export type RuntimeState = 'uninitialized' | 'starting' | 'running' | 'degraded' | 'errored' | 'stopped'`) and exposed via `useUserSyncRuntime().runtimeStatus`:

| `RuntimeState` | Meaning | Additional `RuntimeStatus` Telemetry |
|---|---|---|
| `uninitialized` | Runtime instance created before `start()` is invoked. | `isReady: false`, `isHydrated: false` |
| `starting` | Opening `ArtixDB_v2_<hash>`, requesting `storage.persist()`, running legacy migration, and recovering expired leases. | `isReady: false` |
| `running` | Fully operational; local storage, repositories, and leader/standby sync coordination active. | `isReady: true`, `isHydrated`, `isCloudSyncPaused`, `storagePersisted`, `usageBytes`, `quotaBytes` |
| `degraded` | Database open and local reads/writes active, but storage quota is unhealthy (`>90%`) or legacy migration encountered a non-fatal warning. | `isReady: true`, `error` / `migration` diagnostic |
| `errored` | Fatal IndexedDB open error (`onStorageQuotaExceeded` or corrupted storage). | `isReady: false`, `error` |
| `stopped` | User logged out or runtime torn down; database closed and background engines halted. | `isReady: false` |
