import { EntityType, OutboxOperation } from '../local/types';

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
  private channel: BroadcastChannel | null = null;
  private isLeader = false;
  private lockAbortController: AbortController | null = null;
  private changeListeners = new Set<(event: CrossTabChangeEvent) => void>();
  private syncRequestListeners = new Set<() => void>();

  constructor(channelName = 'artix_cross_tab_sync') {
    this.tabId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random()}`;
    this.channelName = channelName;

    this.initBroadcastChannel();
    this.acquireLeaderLock();
  }

  getTabId(): string {
    return this.tabId;
  }

  isLeaderTab(): boolean {
    return this.isLeader;
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
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      this.lockAbortController = new AbortController();

      navigator.locks
        .request(
          'artix_sync_leader_lock',
          { signal: this.lockAbortController.signal },
          () => {
            this.isLeader = true;

            // Keep lock held indefinitely until tab closes or abort is triggered
            return new Promise<void>((resolve) => {
              if (this.lockAbortController) {
                this.lockAbortController.signal.addEventListener('abort', () => {
                  this.isLeader = false;
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
          this.isLeader = false;
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
    this.isLeader = false;

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
  }
}

// Global coordinator singleton
let globalCoordinator: TabCoordinator | null = null;

export function getTabCoordinator(): TabCoordinator {
  if (!globalCoordinator) {
    globalCoordinator = new TabCoordinator();
  }
  return globalCoordinator;
}
