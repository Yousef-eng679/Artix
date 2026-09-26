import { supabase as defaultSupabaseClient } from '@/integrations/supabase/client';
import { OutboxRepository } from '../repositories/outboxRepository';
import { SyncMetadataRepository } from '../repositories/syncMetadataRepository';
import { OutboxEntry } from '../local/types';

export type SyncStatusState = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncStatus {
  state: SyncStatusState;
  isOnline: boolean;
  pendingCount: number;
  lastSyncedAt: Date | null;
  error?: { code: string; message: string } | null;
}

export interface SyncEngineOptions {
  supabaseClient?: any;
  outboxRepo?: OutboxRepository;
  syncMetadataRepo?: SyncMetadataRepository;
  maxRetries?: number;
  batchSize?: number;
}

export class SyncEngine {
  private supabase: any;
  private outboxRepo: OutboxRepository;
  private syncMetadataRepo: SyncMetadataRepository;
  private maxRetries: number;
  private batchSize: number;

  private isOnline: boolean;
  private state: SyncStatusState = 'idle';
  private lastSyncedAt: Date | null = null;
  private lastError: { code: string; message: string } | null = null;
  private activeSyncPromise: Promise<void> | null = null;
  private listeners = new Set<(status: SyncStatus) => void>();

  private onlineHandler?: () => void;
  private offlineHandler?: () => void;

  constructor(options: SyncEngineOptions = {}) {
    this.supabase = options.supabaseClient || defaultSupabaseClient;
    this.outboxRepo = options.outboxRepo || new OutboxRepository();
    this.syncMetadataRepo = options.syncMetadataRepo || new SyncMetadataRepository();
    this.maxRetries = options.maxRetries ?? 5;
    this.batchSize = options.batchSize ?? 20;

    this.isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    this.state = this.isOnline ? 'idle' : 'offline';

    this.setupNetworkListeners();
  }

  private setupNetworkListeners(): void {
    if (typeof window !== 'undefined') {
      this.onlineHandler = () => {
        this.isOnline = true;
        this.notifySubscribers();
        this.triggerSync().catch((err) => {
          console.warn('[SyncEngine] Auto-sync on reconnection failed:', err);
        });
      };

      this.offlineHandler = () => {
        this.isOnline = false;
        this.state = 'offline';
        this.notifySubscribers();
      };

      window.addEventListener('online', this.onlineHandler);
      window.addEventListener('offline', this.offlineHandler);
    }
  }

  /**
   * Cleans up event listeners and background handlers.
   */
  destroy(): void {
    if (typeof window !== 'undefined') {
      if (this.onlineHandler) window.removeEventListener('online', this.onlineHandler);
      if (this.offlineHandler) window.removeEventListener('offline', this.offlineHandler);
    }
    this.listeners.clear();
  }

  /**
   * Subscribe to sync status updates.
   */
  subscribe(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Get current sync status snapshot.
   */
  getStatus(): SyncStatus {
    return {
      state: this.state,
      isOnline: this.isOnline,
      pendingCount: 0, // dynamic count populated via getStatusWithPending()
      lastSyncedAt: this.lastSyncedAt,
      error: this.lastError,
    };
  }

  /**
   * Get full status with accurate pending count from outbox.
   */
  async getStatusWithPending(userId?: string): Promise<SyncStatus> {
    const pendingCount = await this.outboxRepo.countPending(userId);
    return {
      state: this.state,
      isOnline: this.isOnline,
      pendingCount,
      lastSyncedAt: this.lastSyncedAt,
      error: this.lastError,
    };
  }

  private notifySubscribers(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (err) {
        console.error('[SyncEngine] Subscriber notification error:', err);
      }
    }
  }

  /**
   * Calculates exponential backoff in milliseconds:
   * attempt 1: 1s, attempt 2: 2s, attempt 3: 4s, attempt 4: 8s ... up to 30s.
   */
  getBackoffDelay(attemptCount: number): number {
    const exponent = Math.max(0, attemptCount - 1);
    return Math.min(1000 * Math.pow(2, exponent), 30000);
  }

  /**
   * Initiates synchronization of pending mutations to Supabase.
   */
  async triggerSync(userId?: string): Promise<void> {
    if (this.activeSyncPromise) {
      return this.activeSyncPromise;
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.isOnline = false;
      this.state = 'offline';
      this.notifySubscribers();
      return;
    }

    this.activeSyncPromise = this.drainOutbox(userId).finally(() => {
      this.activeSyncPromise = null;
    });

    return this.activeSyncPromise;
  }

  /**
   * Sequentially drains outbox entries to Supabase.
   */
  private async drainOutbox(userId?: string): Promise<void> {
    this.state = 'syncing';
    this.lastError = null;
    this.notifySubscribers();

    try {
      while (true) {
        // Check network availability
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          this.isOnline = false;
          this.state = 'offline';
          break;
        }

        const pendingEntries = await this.outboxRepo.getPending(this.batchSize, userId);
        if (pendingEntries.length === 0) {
          this.state = 'idle';
          break;
        }

        let encounteredNetworkError = false;

        for (const entry of pendingEntries) {
          // Mark in-flight
          await this.outboxRepo.markInFlight(entry.id);
          await this.syncMetadataRepo.markSyncing(entry.entityType, entry.entityId, entry.userId);

          try {
            const serverResult = await this.pushMutationToCloud(entry);

            // Mutation pushed successfully
            await this.outboxRepo.markCompleted(entry.id);
            await this.syncMetadataRepo.markSynced(
              entry.entityType,
              entry.entityId,
              entry.userId,
              serverResult?.version || null,
              serverResult?.updated_at || new Date().toISOString(),
              entry.localRevision
            );

            this.lastSyncedAt = new Date();
          } catch (err: any) {
            console.warn(`[SyncEngine] Push failed for entry ${entry.id}:`, err);

            const isNetworkError =
              !this.isOnline ||
              err?.message?.includes('fetch') ||
              err?.message?.includes('network') ||
              err?.status === 0;

            const errorPayload = {
              code: err?.code || (isNetworkError ? 'NETWORK_ERROR' : 'SYNC_FAILED'),
              message: err?.message || 'Failed to synchronize mutation',
            };

            this.lastError = errorPayload;

            if (isNetworkError) {
              await this.outboxRepo.markFailed(entry.id, errorPayload, this.maxRetries);
              await this.syncMetadataRepo.markError(entry.entityType, entry.entityId, entry.userId);
              encounteredNetworkError = true;
              break; // Stop draining until network recovers
            } else {
              // Non-transient or client error (e.g. 4xx) -> mark blocked so subsequent items can proceed
              await this.outboxRepo.markFailed(entry.id, errorPayload, 1);
              await this.syncMetadataRepo.markError(entry.entityType, entry.entityId, entry.userId);
            }
          }
        }

        if (encounteredNetworkError) {
          this.state = 'error';
          break;
        }
      }
    } catch (unexpected) {
      console.error('[SyncEngine] Unexpected sync loop failure:', unexpected);
      this.state = 'error';
    } finally {
      if (this.state === 'syncing') {
        this.state = 'idle';
      }
      this.notifySubscribers();
    }
  }

  /**
   * Pushes a single outbox mutation to Supabase depending on entity type and operation.
   */
  private async pushMutationToCloud(entry: OutboxEntry): Promise<{ version?: string; updated_at?: string } | null> {
    const { entityType, entityId, operation, payload } = entry;
    const body = (payload as Record<string, any>) || {};

    if (entityType === 'document') {
      if (operation === 'create') {
        const { data, error } = await this.supabase
          .from('documents')
          .upsert({
            id: entityId,
            user_id: entry.userId,
            project_id: entry.projectId,
            folder_id: body.folderId ?? body.folder_id ?? null,
            title: body.title || 'Untitled Document',
            content: body.content || '',
            format: body.format || 'markdown',
            updated_at: new Date().toISOString(),
          })
          .select('updated_at')
          .single();

        if (error) throw error;
        return { updated_at: data?.updated_at };
      } else if (operation === 'update') {
        const updateData: Record<string, any> = {
          updated_at: new Date().toISOString(),
        };
        if (body.title !== undefined) updateData.title = body.title;
        if (body.content !== undefined) updateData.content = body.content;
        if (body.format !== undefined) updateData.format = body.format;
        if (body.folderId !== undefined) updateData.folder_id = body.folderId;
        if (body.folder_id !== undefined) updateData.folder_id = body.folder_id;

        const { data, error } = await this.supabase
          .from('documents')
          .update(updateData)
          .eq('id', entityId)
          .select('updated_at')
          .single();

        if (error) throw error;
        return { updated_at: data?.updated_at };
      } else if (operation === 'delete') {
        const { error } = await this.supabase.from('documents').delete().eq('id', entityId);
        if (error) throw error;
        return null;
      }
    }

    if (entityType === 'system_design') {
      if (operation === 'create') {
        const { data, error } = await this.supabase
          .from('system_designs')
          .upsert({
            id: entityId,
            user_id: entry.userId,
            project_id: entry.projectId,
            folder_id: body.folderId ?? body.folder_id ?? null,
            name: body.name || 'New System Design',
            board_state: body.boardState ?? body.board_state ?? { nodes: [], edges: [], strokes: [] },
            updated_at: new Date().toISOString(),
          })
          .select('updated_at')
          .single();

        if (error) throw error;
        return { updated_at: data?.updated_at };
      } else if (operation === 'update') {
        const updateData: Record<string, any> = {
          updated_at: new Date().toISOString(),
        };
        if (body.name !== undefined) updateData.name = body.name;
        if (body.boardState !== undefined) updateData.board_state = body.boardState;
        if (body.board_state !== undefined) updateData.board_state = body.board_state;
        if (body.folderId !== undefined) updateData.folder_id = body.folderId;
        if (body.folder_id !== undefined) updateData.folder_id = body.folder_id;

        const { data, error } = await this.supabase
          .from('system_designs')
          .update(updateData)
          .eq('id', entityId)
          .select('updated_at')
          .single();

        if (error) throw error;
        return { updated_at: data?.updated_at };
      } else if (operation === 'delete') {
        const { error } = await this.supabase.from('system_designs').delete().eq('id', entityId);
        if (error) throw error;
        return null;
      }
    }

    if (entityType === 'workspace_folder') {
      if (operation === 'create') {
        const { data, error } = await this.supabase
          .from('workspace_folders')
          .upsert({
            id: entityId,
            user_id: entry.userId,
            project_id: entry.projectId,
            name: body.name,
            parent_folder_id: body.parentFolderId ?? body.parent_folder_id ?? null,
            updated_at: new Date().toISOString(),
          })
          .select('updated_at')
          .single();

        if (error) throw error;
        return { updated_at: data?.updated_at };
      } else if (operation === 'update') {
        const updateData: Record<string, any> = {
          updated_at: new Date().toISOString(),
        };
        if (body.name !== undefined) updateData.name = body.name;
        if (body.parentFolderId !== undefined) updateData.parent_folder_id = body.parentFolderId;
        if (body.parent_folder_id !== undefined) updateData.parent_folder_id = body.parent_folder_id;

        const { data, error } = await this.supabase
          .from('workspace_folders')
          .update(updateData)
          .eq('id', entityId)
          .select('updated_at')
          .single();

        if (error) throw error;
        return { updated_at: data?.updated_at };
      } else if (operation === 'delete') {
        const { error } = await this.supabase.from('workspace_folders').delete().eq('id', entityId);
        if (error) throw error;
        return null;
      }
    }

    return null;
  }
}

// Global singleton instance for application runtime
let globalSyncEngine: SyncEngine | null = null;

export function getSyncEngine(): SyncEngine {
  if (!globalSyncEngine) {
    globalSyncEngine = new SyncEngine();
  }
  return globalSyncEngine;
}
