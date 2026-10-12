# Artix Application & Session Lifecycle

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/sync/userSyncRuntime.ts`, `src/contexts/UserSyncRuntimeContext.tsx`, `src/test/sync/userSyncRuntimeLifecycle.test.tsx`

---

## 1. Overview

Artix decouples browser session initialization from persistent data ownership. The synchronization runtime, local database instances, and cloud connections are strictly scoped to the authenticated user's session lifecycle.

---

## 2. Complete Lifecycle Flow

```text
Browser Launch
      │
      ▼
┌──────────────┐
│  React App   │ ──► Auth Provider Mounts (`src/hooks/useAuth.tsx`)
└──────┬───────┘
       │
       ├─── No User / Logged Out
       │        │
       │        ▼
       │   Render Public Routes (/auth, /pricing)
       │   Zero Database Instances Active
       │
       └─── User Authenticated (`user.id` present)
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
                                ├── 1. Compute User Scope Hash (`getUserScopeHash`)
                                ├── 2. Open User DB (`ArtixDB_v2_<hash>`)
                                ├── 3. Execute Legacy DB Migrations (`migrateLegacyArtixDB`)
                                ├── 4. Recover Crashed Outbox Leases
                                ├── 5. Initialize Repositories (Document, Design, Folder, etc.)
                                ├── 6. Instantiate Engines (SyncEngine, PullEngine, TabCoordinator)
                                ├── 7. Acquire Web Lock Leadership (`acquireLeaderLock`)
                                └── 8. Start Realtime Listener (`RealtimeSyncManager.start`)
                                │
                                ▼
       ┌────────────────────────────────────────────────────────┐
       │                Runtime State: 'running'                │
       │  React hooks consume repositories from Context API     │
       └────────────────────────────────────────────────────────┘
```

---

## 3. Detailed Lifecycle Transitions

### 3.1 Startup & Authentication Initialization
When a user signs in:
1. `UserSyncRuntimeProvider` detects the transition from `user = null` to `user = { id: '...' }`.
2. Provider sets runtime status to `initializing`.
3. Calls `openUserRuntime(userId)`:
   - Computes deterministic 32-bit FNV-1a hash of `userId`.
   - Opens Dexie database named `ArtixDB_v2_<hash>`.
   - If a legacy unpartitioned `ArtixDB` exists from older versions, atomically migrates records to the user-scoped database without data loss.
4. **Crash Recovery**: Queries `outbox` table for any records stuck in `in_flight` state with expired leases (`leaseExpiresAt < Date.now()`). Reclaims them back to `state: 'pending'` and clears `leaseOwner`.
5. Status transitions to `running`. The React tree is granted access to the active repositories.

### 3.2 Account Switching (User A -> User B)
Artix guarantees **zero cross-tenant cache leakage**:
1. When User A signs out and User B signs in:
   ```typescript
   // Inside openUserRuntime(newUserId):
   if (activeRuntime && activeRuntime.userId !== newUserId) {
     await activeRuntime.stop(); // Cleanly closes User A's runtime & DB
     activeRuntime = null;
   }
   ```
2. User A's Realtime channel is unsubscribed.
3. User A's in-flight background sync tasks are aborted.
4. User A's IndexedDB connection is closed and evicted from memory cache (`dbInstances.delete(...)`).
5. User B's isolated database `ArtixDB_v2_<hash_B>` is initialized.
6. Verified by Scenario H in `src/test/sync/correctnessMatrix.test.ts`.

### 3.3 Sign-Out & Shutdown
When a user signs out:
1. `closeUserRuntime(userId)` is invoked.
2. In-flight leases are voluntarily relinquished.
3. The Web Lock (`navigator.locks`) is aborted and released.
4. The database connection is explicitly closed:
   ```typescript
   await db.close();
   ```
5. Status transitions to `stopped`.

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

## 5. Runtime Status Taxonomy (`RuntimeStatus`)

Exposed to UI components via `useUserSyncRuntime().status`:

| Status | Meaning | UI Presentation |
|---|---|---|
| `initializing` | Opening Dexie database, validating schema, recovering leases. | Displays subtle spinner in workspace status bar. |
| `running` | Fully operational; local storage and sync engine active. | Shows green "Online / Local Ready" status badge. |
| `migrating` | Transferring legacy records to user-partitioned database. | Non-blocking background migration notice. |
| `blocked` | Another tab is blocking a required schema upgrade. | Warns user: "Please close other Artix tabs to complete upgrade." |
| `quota_exceeded` | Browser storage quota exceeded (`QuotaExceededError`). | Prompts user to clear local cache or free disk space. |
| `degraded` | Database open but IndexedDB running in volatile fallback. | Warns that changes may not persist across restarts. |
| `stopped` | User logged out; database closed and runtime halted. | Rendered in unauthenticated public view. |
