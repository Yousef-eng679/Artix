import { RealtimeChannel } from '@supabase/supabase-js';
import { supabase as defaultSupabaseClient } from '@/integrations/supabase/client';
import { getSyncEngine, SyncEngine } from './syncEngine';
import { getTabCoordinator, TabCoordinator } from './tabCoordinator';

export class RealtimeSyncManager {
  private supabase: any;
  private syncEngine: SyncEngine;
  private tabCoordinator: TabCoordinator;
  private channel: RealtimeChannel | null = null;
  private userId: string | null = null;

  constructor(options: {
    supabaseClient?: any;
    syncEngine?: SyncEngine;
    tabCoordinator?: TabCoordinator;
  } = {}) {
    this.supabase = options.supabaseClient || defaultSupabaseClient;
    this.syncEngine = options.syncEngine || getSyncEngine();
    this.tabCoordinator = options.tabCoordinator || getTabCoordinator();
  }

  /**
   * Initializes real-time listener for user-scoped changes on documents, designs, and folders.
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
          () => this.handleRemoteChange('document')
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'system_designs', filter: `user_id=eq.${userId}` },
          () => this.handleRemoteChange('system_design')
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'workspace_folders', filter: `user_id=eq.${userId}` },
          () => this.handleRemoteChange('workspace_folder')
        )
        .subscribe();
    } catch (err) {
      console.warn('[RealtimeSyncManager] Failed to subscribe to Realtime channel:', err);
    }
  }

  private handleRemoteChange(_entityType: string): void {
    // Only the leader tab pulls remote changes to avoid duplicate network fetches
    if (this.tabCoordinator.isLeaderTab()) {
      this.syncEngine.triggerSync(this.userId || undefined).catch((err) => {
        console.warn('[RealtimeSyncManager] Pull on realtime event failed:', err);
      });
    }
  }

  /**
   * Unsubscribes and cleans up channel.
   */
  stop(): void {
    if (this.channel) {
      try {
        this.supabase.removeChannel(this.channel);
      } catch {
        // channel removed
      }
      this.channel = null;
    }
    this.userId = null;
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
