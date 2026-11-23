# Multi-Tab Coordination & Web Locks Leader Protocol

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/sync/tabCoordinator.ts`, `src/test/sync/tabCoordinator.test.ts`, `src/test/sync/leaderWorkerCorrectness.test.ts`, `src/test/sync/pullUiReactivityAndCrossTab.test.tsx`, `src/test/sync/multiAccountEvictionAndStorageScope.test.tsx`

---

## 1. Overview

Users commonly open several browser tabs pointing to the same workspace (e.g. one tab editing a document, another viewing a system design canvas). Without coordination:
- Multiple tabs would attempt to drain the outbox concurrently, issuing duplicate push requests and triggering artificial 409 conflicts.
- Local edits in Tab A would not appear in Tab B until a manual page refresh.

Artix resolves multi-tab concurrency through **Single-Leader Worker Architecture** managed by `TabCoordinator` (`src/lib/sync/tabCoordinator.ts`).

---

## 2. Web Locks API Leader Election

Instead of fragile, timer-based heartbeat mechanisms (which fail when tabs are throttled in background tabs), Artix utilizes the native browser **Web Locks API** (`navigator.locks`):

```text
Tab 1 (Opens First)                      Tab 2 (Opens Later)
        │                                         │
navigator.locks.request(                          navigator.locks.request(
  'artix_sync_leader_lock_<hash>',                  'artix_sync_leader_lock_<hash>',
  () => { isLeader = true }                         () => { isLeader = true }
)                                                 )
        │                                         │
[LOCK GRANTED BY BROWSER KERNEL]                  [LOCK QUEUED / PENDING]
Holds exclusive lock indefinitely.                Remains in Standby state.
Executes SyncEngine push drain.                   Writes to IndexedDB; sends REQUEST_SYNC.
```

### Zero-Latency Failover Invariant
When the leader tab is closed, killed by the user, or crashes:
1. The browser's operating system process automatically frees all held Web Locks.
2. The browser kernel immediately invokes the waiting callback in Tab 2.
3. Tab 2's `onLeadershipChange` listener fires with `isLeader = true`.
4. Tab 2 immediately inspects the outbox, claims any expired leases, and resumes synchronization with **zero latency and zero timeout polling** (Scenario G verified).

---

## 3. Cross-Tab Event Bus (`BroadcastChannel`)

While Web Locks handles leadership election, `BroadcastChannel` (`artix_cross_tab_sync_<userScope>`) handles peer-to-peer message passing:

```typescript
export type CrossTabMessage =
  | CrossTabChangeEvent
  | CrossTabSyncRequestEvent
  | CrossTabLeaderEvent;

export interface CrossTabChangeEvent {
  type: 'ENTITY_CHANGED';
  tabId: string;
  entityType: 'project' | 'document' | 'system_design' | 'workspace_folder';
  entityId: string;
  operation: 'create' | 'update' | 'delete';
  localRevision: number;
  timestamp: number;
}

export interface CrossTabSyncRequestEvent {
  type: 'REQUEST_SYNC';
  tabId: string;
  userId?: string;
  timestamp: number;
}

export interface CrossTabLeaderEvent {
  type: 'LEADER_ELECTED';
  tabId: string;
  timestamp: number;
}
```

### Event Flow on Local Edit & Remote Pull
1. User types in Tab B (Standby tab).
2. Tab B writes the change to local IndexedDB (`localRevision: 5`).
3. After the Dexie transaction commits, Tab B broadcasts `ENTITY_CHANGED` carrying the real `localRevision` (`5`) via `BroadcastChannel`.
4. Tab A (Leader tab) receives `ENTITY_CHANGED`, invalidates its React Query cache, and updates open editors/canvases (clean buffers hot-reload; dirty buffers surface a stale-buffer banner).
5. Tab B sends `REQUEST_SYNC` to Tab A, waking `SyncEngine` to push Revision 5 to Supabase.
6. Conversely, when `PullEngine` commits a remote batch on the leader tab, it invokes `coordinator.notifyRemoteChange(...)` **post-commit** (`tabId: 'remote-pull'`) with each entity's persisted `localRevision`, notifying both local-tab listeners and peer standby tabs.
7. Only the leader tab triggers pulls from `RealtimeSyncManager` wakeups (`if (coordinator.getIsLeader())`), and on account switch or sign-out `evictTabCoordinator(userId)` releases the Web Lock, closes the `BroadcastChannel`, and evicts the per-user singleton.

---

## 4. Broadcast Deduplication Filter

To prevent message amplification storms when multiple components or tabs trigger rapid mutations, `TabCoordinator` maintains a 3000ms recent-event deduplication filter:

```typescript
const signature = `${message.entityType}:${message.entityId}:${message.operation}:${message.localRevision}`;
const now = Date.now();
const lastSeen = this.recentEvents.get(signature);

if (lastSeen && now - lastSeen < 3000) {
  return; // Suppress duplicate event within 3000ms window
}

this.recentEvents.set(signature, now);
```

Stale signatures are garbage-collected when the cache exceeds 200 entries.

---

## 5. Fallback in Non-Supporting Environments

In Node.js test environments or headless test runners where `navigator.locks` is absent:
```typescript
if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
  // Use native Web Locks
  this.acquireLeaderLock();
} else {
  // Fallback: Default current instance to leader
  this.isLeader = true;
}
```
For integration testing, `TabCoordinator` exposes `setLeaderForTesting(boolean)` to simulate failover scenarios programmatically. Even if a tab stalls or runs in a fallback environment, storage-layer `leaseToken` fencing in `OutboxRepository` / `SyncEngine` prevents any stale leader from committing out-of-date push acknowledgements or error transitions.
