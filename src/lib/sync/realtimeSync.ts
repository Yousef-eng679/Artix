import { RealtimeChannel } from '@supabase/supabase-js';
import { supabase as defaultSupabaseClient } from '@/integrations/supabase/client';
import { getSyncEngine, SyncEngine } from './syncEngine';
import { getTabCoordinator, TabCoordinator } from './tabCoordinator';

export interface RealtimeSyncManagerOptions {
  supabaseClient?: any;
  syncEngine?: SyncEngine;
  tabCoordinator?: TabCoordinator;
  debounceMs?: number;
}

export type RealtimeConnectionStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR' | 'DISCONNECTED';

export class RealtimeSyncManager {
  private supabase: any;
  private syncEngine: SyncEngine;
  private tabCoordinator: TabCoordinator;
  private channel: RealtimeChannel | null = null;
  private userId: string | null = null;
  private debounceMs: number;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTrailingSync = false;
  private lastTriggerTime = 0;
  private status: RealtimeConnectionStatus = 'DISCONNECTED';
  private wasPreviouslySubscribed = false;

  constructor(options: RealtimeSyncManagerOptions = {}) {
    this.supabase = options.supabaseClient || defaultSupabaseClient;
    this.syncEngine = options.syncEngine || getSyncEngine();
    this.tabCoordinator = options.tabCoordinator || getTabCoordinator();
    this.debounceMs = options.debounceMs ?? 50;
  }

  /**
   * Returns the current channel connection status.
   */
  getStatus(): RealtimeConnectionStatus {
    return this.status;
  }

  /**
   * Returns true if the channel is currently subscribed.
   */
  isConnected(): boolean {
    return this.status === 'SUBSCRIBED';
  }

  /**
   * Initializes real-time listener for user-scoped changes on documents, designs, folders, and sync_changes.
   */
  start(userId: string): void {
    if (this.userId === userId && this.channel) {
      return;
    }

    this.stop();
    this.userId = userId;

    if (!this.supabase || typeof this.supabase.channel !== 'function') {
      return;
    }

    try {
      this.channel = this.supabase
        .channel(`user-sync-${userId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'documents', filter: `user_id=eq.${userId}` },
          () => this.handleRemoteChange('documents')
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'system_designs', filter: `user_id=eq.${userId}` },
          () => this.handleRemoteChange('system_designs')
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'workspace_folders', filter: `user_id=eq.${userId}` },
          () => this.handleRemoteChange('workspace_folders')
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'sync_changes', filter: `user_id=eq.${userId}` },
          () => this.handleRemoteChange('sync_changes')
        );

      if (this.channel && typeof (this.channel as any).subscribe === 'function') {
        (this.channel as any).subscribe((status: string, err?: any) => {
          this.handleChannelStatusChange(status as RealtimeConnectionStatus, err);
        });
      }
    } catch (err) {
      console.warn('[RealtimeSyncManager] Failed to subscribe to Realtime channel:', err);
    }
  }

  /**
   * Handles channel subscription status changes.
   * If reconnecting after a disconnect/timeout, schedules a catch-up pull.
   */
  handleChannelStatusChange(status: RealtimeConnectionStatus, err?: any): void {
    const previousStatus = this.status;
    this.status = status;

    if (err) {
      console.warn(`[RealtimeSyncManager] Realtime channel status ${status}:`, err);
    }

    if (status === 'SUBSCRIBED') {
      // If we reconnected after being disconnected or on subscription transition,
      // trigger pull to catch up on any missed events
      if (this.wasPreviouslySubscribed || previousStatus === 'CHANNEL_ERROR' || previousStatus === 'TIMED_OUT') {
        this.dispatchSync();
      }
      this.wasPreviouslySubscribed = true;
    }
  }

  /**
   * Schedules a sync trigger with leading-edge immediate trigger and trailing debouncing.
   */
  private handleRemoteChange(_entityType: string): void {
    if (!this.tabCoordinator.isLeaderTab()) {
      return;
    }

    const now = Date.now();
    const timeSinceLast = now - this.lastTriggerTime;

    if (timeSinceLast >= this.debounceMs) {
      // Leading edge: fire immediately
      this.lastTriggerTime = now;
      this.dispatchSync();
    } else {
      // Subsequent events in burst: queue trailing edge
      this.pendingTrailingSync = true;
      if (!this.debounceTimer) {
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          if (this.pendingTrailingSync) {
            this.pendingTrailingSync = false;
            this.lastTriggerTime = Date.now();
            this.dispatchSync();
          }
        }, this.debounceMs - timeSinceLast);
      }
    }
  }

  private dispatchSync(): void {
    if (this.tabCoordinator.isLeaderTab()) {
      this.syncEngine.triggerSync(this.userId || undefined).catch((err) => {
        console.warn('[RealtimeSyncManager] Pull on realtime event failed:', err);
      });
    }
  }

  /**
   * Unsubscribes and cleans up channel and timers.
   */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingTrailingSync = false;

    if (this.channel) {
      try {
        this.supabase.removeChannel(this.channel);
      } catch {
        // channel removed
      }
      this.channel = null;
    }
    this.status = 'DISCONNECTED';
    this.userId = null;
    this.wasPreviouslySubscribed = false;
  }
}

// Global manager singleton
let globalRealtimeManager: RealtimeSyncManager | null = null;

export function getRealtimeSyncManager(): RealtimeSyncManager {
  if (!globalRealtimeManager) {
    globalRealtimeManager = new RealtimeSyncManager();
  }
  return globalRealtimeManager;
}
