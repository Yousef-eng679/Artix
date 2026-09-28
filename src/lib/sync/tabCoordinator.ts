import { EntityType, OutboxOperation } from '../local/types';
import { getUserScopeHash } from '../local/db';

export interface CrossTabChangeEvent {
  type: 'ENTITY_CHANGED';
  tabId: string;
  entityType: EntityType;
  entityId: string;
  operation: OutboxOperation;
  localRevision: number;
}

export interface CrossTabSyncRequestEvent {
  type: 'REQUEST_SYNC';
  tabId: string;
}

export interface CrossTabLeaderEvent {
  type: 'LEADER_HEARTBEAT';
  leaderTabId: string;
}

export type CrossTabMessage =
  | CrossTabChangeEvent
  | CrossTabSyncRequestEvent
  | CrossTabLeaderEvent;

export class TabCoordinator {
  private tabId: string;
  private channelName: string;
  private userScope: string;
  private channel: BroadcastChannel | null = null;
  private isLeader = false;
  private lockAbortController: AbortController | null = null;
  private changeListeners = new Set<(event: CrossTabChangeEvent) => void>();
  private syncRequestListeners = new Set<() => void>();
  private leadershipChangeListeners = new Set<(isLeader: boolean) => void>();
  private recentEvents = new Map<string, number>();

  constructor(channelName?: string, userScope = 'default') {
    this.userScope = userScope;
    this.tabId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random()}`;
    this.channelName = channelName || (userScope !== 'default' ? `artix_cross_tab_sync_${userScope}` : 'artix_cross_tab_sync');

    this.initBroadcastChannel();
    this.acquireLeaderLock();
  }

  getTabId(): string {
    return this.tabId;
  }

  isLeaderTab(): boolean {
    return this.isLeader;
  }

  /**
   * Directly sets leadership state for unit/integration testing.
   */
  setLeaderForTesting(leader: boolean): void {
    const changed = this.isLeader !== leader;
    this.isLeader = leader;
    if (changed) {
      this.notifyLeadershipChange(leader);
    }
  }

  /**
   * Subscribes to leadership state changes.
   */
  onLeadershipChange(callback: (isLeader: boolean) => void): () => void {
    this.leadershipChangeListeners.add(callback);
    return () => {
      this.leadershipChangeListeners.delete(callback);
    };
  }

  private notifyLeadershipChange(isLeader: boolean): void {
    for (const listener of this.leadershipChangeListeners) {
      try {
        listener(isLeader);
      } catch (err) {
        console.error('[TabCoordinator] Error in leadership change listener:', err);
      }
    }
  }

  private initBroadcastChannel(): void {
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(this.channelName);
        this.channel.onmessage = (event: MessageEvent<CrossTabMessage>) => {
          this.handleChannelMessage(event.data);
        };
      } catch (err) {
        console.warn('[TabCoordinator] BroadcastChannel initialization failed:', err);
      }
    }
  }

  private handleChannelMessage(message: CrossTabMessage): void {
    if (!message || (message as any).tabId === this.tabId) {
      return; // Ignore messages from this same tab
    }

    if (message.type === 'ENTITY_CHANGED') {
      const signature = `${message.entityType}:${message.entityId}:${message.operation}:${message.localRevision}`;
      const now = Date.now();
      const lastSeen = this.recentEvents.get(signature);
      if (lastSeen && now - lastSeen < 3000) {
        return; // Suppress duplicate events within 3000ms window
      }
      this.recentEvents.set(signature, now);

      if (this.recentEvents.size > 200) {
        for (const [sig, ts] of this.recentEvents.entries()) {
          if (now - ts > 10000) this.recentEvents.delete(sig);
        }
      }

      for (const listener of this.changeListeners) {
        try {
          listener(message);
        } catch (err) {
          console.error('[TabCoordinator] Error in change listener:', err);
        }
      }
    } else if (message.type === 'REQUEST_SYNC') {
      if (this.isLeader) {
        for (const listener of this.syncRequestListeners) {
          try {
            listener();
          } catch (err) {
            console.error('[TabCoordinator] Error in sync request listener:', err);
          }
        }
      }
    }
  }

  private acquireLeaderLock(): void {
    const lockName = this.userScope !== 'default' ? `artix_sync_leader_lock_${this.userScope}` : 'artix_sync_leader_lock';
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      this.lockAbortController = new AbortController();

      navigator.locks
        .request(
          lockName,
          { signal: this.lockAbortController.signal },
          () => {
            this.isLeader = true;
            this.notifyLeadershipChange(true);

            // Keep lock held indefinitely until tab closes or abort is triggered
            return new Promise<void>((resolve) => {
              if (this.lockAbortController) {
                this.lockAbortController.signal.addEventListener('abort', () => {
                  this.isLeader = false;
                  this.notifyLeadershipChange(false);
                  resolve();
                });
              }
            });
          }
        )
        .catch((err) => {
          // Lock aborted or not acquired; remain standby
          if (err.name !== 'AbortError') {
            console.warn('[TabCoordinator] Leader lock error:', err);
          }
          if (this.isLeader) {
            this.isLeader = false;
            this.notifyLeadershipChange(false);
          }
        });
    } else {
      // In environments without Web Locks API (e.g. Node tests), default this tab to leader
      this.isLeader = true;
    }
  }

  /**
   * Broadcasts an entity mutation event to all other open tabs.
   */
  broadcastChange(params: {
    entityType: EntityType;
    entityId: string;
    operation: OutboxOperation;
    localRevision: number;
  }): void {
    if (!this.channel) return;

    try {
      this.channel.postMessage({
        type: 'ENTITY_CHANGED',
        tabId: this.tabId,
        entityType: params.entityType,
        entityId: params.entityId,
        operation: params.operation,
        localRevision: params.localRevision,
      } as CrossTabChangeEvent);
    } catch (err) {
      console.warn('[TabCoordinator] Failed to broadcast change:', err);
    }
  }

  /**
   * Standby tabs call this to ask the leader tab to trigger cloud synchronization.
   */
  requestLeaderSync(): void {
    if (this.isLeader) {
      for (const listener of this.syncRequestListeners) {
        listener();
      }
      return;
    }

    if (this.channel) {
      try {
        this.channel.postMessage({
          type: 'REQUEST_SYNC',
          tabId: this.tabId,
        } as CrossTabSyncRequestEvent);
      } catch (err) {
        console.warn('[TabCoordinator] Failed to request leader sync:', err);
      }
    }
  }

  /**
   * Subscribe to changes coming from other tabs.
   */
  onCrossTabChange(callback: (event: CrossTabChangeEvent) => void): () => void {
    this.changeListeners.add(callback);
    return () => {
      this.changeListeners.delete(callback);
    };
  }

  /**
   * Leader tab subscribes to sync requests triggered by other tabs.
   */
  onSyncRequest(callback: () => void): () => void {
    this.syncRequestListeners.add(callback);
    return () => {
      this.syncRequestListeners.delete(callback);
    };
  }

  /**
   * Cleans up channel and releases leader lock.
   */
  destroy(): void {
    if (this.lockAbortController) {
      this.lockAbortController.abort();
      this.lockAbortController = null;
    }
    const wasLeader = this.isLeader;
    this.isLeader = false;
    if (wasLeader) {
      this.notifyLeadershipChange(false);
    }

    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        // channel closed
      }
      this.channel = null;
    }

    this.changeListeners.clear();
    this.syncRequestListeners.clear();
    this.leadershipChangeListeners.clear();
  }
}

// User-scoped coordinator cache
const userCoordinators = new Map<string, TabCoordinator>();

export function getTabCoordinator(userId?: string | null): TabCoordinator {
  const scope = userId ? getUserScopeHash(userId) : 'default';
  let coordinator = userCoordinators.get(scope);
  if (!coordinator) {
    coordinator = new TabCoordinator(undefined, scope);
    userCoordinators.set(scope, coordinator);
  }
  return coordinator;
}

export function resetTabCoordinatorsForTesting(): void {
  for (const coord of userCoordinators.values()) {
    coord.destroy();
  }
  userCoordinators.clear();
}
