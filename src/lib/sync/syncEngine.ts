import { supabase as defaultSupabaseClient } from '@/integrations/supabase/client';
import { OutboxRepository } from '../repositories/outboxRepository';
import { SyncMetadataRepository } from '../repositories/syncMetadataRepository';
import { ConflictRepository } from '../repositories/conflictRepository';
import { PullEngine } from './pullEngine';
import { OutboxEntry } from '../local/types';
import { getTabCoordinator, TabCoordinator } from './tabCoordinator';
import { getUserArtixDB, getUserScopeHash } from '../local/db';
import { orderOutboxByDependency } from './dependencyOrder';
import { classifySyncError } from './errorTaxonomy';
import { getPushAdapter } from './adapters';

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
  conflictRepo?: ConflictRepository;
  pullEngine?: PullEngine;
  tabCoordinator?: TabCoordinator;
  maxRetries?: number;
  batchSize?: number;
}

export { TRANSPORT_TIMEOUT_MS, withTimeout } from './transportTimeout';

export class SyncEngine {
  private supabase: any;
  private outboxRepo: OutboxRepository;
  private syncMetadataRepo: SyncMetadataRepository;
  private conflictRepo: ConflictRepository;
  private pullEngine: PullEngine;
  private tabCoordinator: TabCoordinator;
  private maxRetries: number;
  private batchSize: number;

  private isOnline: boolean;
  private state: SyncStatusState = 'idle';
  private lastSyncedAt: Date | null = null;
  private lastError: { code: string; message: string } | null = null;
  private activeSyncPromise: Promise<void> | null = null;
  private listeners = new Set<(status: SyncStatus) => void>();
  private unsubSyncRequest?: () => void;

  private onlineHandler?: () => void;
  private offlineHandler?: () => void;
  private isDestroyed = false;

  constructor(options: SyncEngineOptions = {}) {
    this.supabase = options.supabaseClient || defaultSupabaseClient;
    this.outboxRepo = options.outboxRepo || new OutboxRepository();
    this.syncMetadataRepo = options.syncMetadataRepo || new SyncMetadataRepository();
    this.conflictRepo = options.conflictRepo || new ConflictRepository();
    this.pullEngine =
      options.pullEngine ||
      new PullEngine({
        supabaseClient: this.supabase,
        conflictRepo: this.conflictRepo,
        syncMetadataRepo: this.syncMetadataRepo,
      });
    this.tabCoordinator = options.tabCoordinator || getTabCoordinator();
    this.maxRetries = options.maxRetries ?? 5;
    this.batchSize = options.batchSize ?? 20;

    this.isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    this.state = this.isOnline ? 'idle' : 'offline';

    this.setupNetworkListeners();

    // Reclaim any crashed in-flight leases on startup
    this.outboxRepo.recoverStaleLeases().catch((err) => {
      if (this.isDestroyed || err?.name === 'DatabaseClosedError') return;
      console.warn('[SyncEngine] Initial stale lease recovery error:', err);
    });

    // Leader responds to sync requests from standby tabs
    this.unsubSyncRequest = this.tabCoordinator.onSyncRequest(() => {
      this.triggerSync().catch((err) => {
        console.warn('[SyncEngine] Sync on remote request failed:', err);
      });
    });
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
    this.isDestroyed = true;
    if (this.unsubSyncRequest) {
      this.unsubSyncRequest();
      this.unsubSyncRequest = undefined;
    }
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
    if (this.isDestroyed) return;

    if (this.activeSyncPromise) {
      return this.activeSyncPromise;
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.isOnline = false;
      this.state = 'offline';
      this.notifySubscribers();
      return;
    }

    // If this tab is not the elected leader, delegate sync to the leader tab
    if (!this.tabCoordinator.isLeaderTab()) {
      this.tabCoordinator.requestLeaderSync();
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
    if (this.isDestroyed) return;

    this.state = 'syncing';
    this.lastError = null;
    this.notifySubscribers();

    try {
      // Catch up on remote changes from durable sync_changes feed prior to pushing local mutations
      if (userId) {
        try {
          await this.pullEngine.pullAll(userId);
        } catch (pullErr: any) {
          if (!this.isDestroyed && pullErr?.name !== 'DatabaseClosedError') {
            console.warn('[SyncEngine] Pull feed sync error prior to push:', pullErr);
          }
        }
      }

      if (this.isDestroyed) return;

      // Reclaim any stalled or crashed leases prior to processing the drain batch
      await this.outboxRepo.recoverStaleLeases();

      while (true) {
        // Check network availability
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          this.isOnline = false;
          this.state = 'offline';
          break;
        }

        const pendingEntries = await this.outboxRepo.getPending(this.batchSize, userId, { readyOnly: true });
        if (pendingEntries.length === 0) {
          this.state = 'idle';
          break;
        }

        // Topologically order the batch so prerequisites (e.g. folders) precede dependents
        const orderedEntries = orderOutboxByDependency(pendingEntries);
        let stopDrainBatch = false;

        for (const entry of orderedEntries) {
          // Mark in-flight with tab lease owner and 30s timeout
          const leaseOwner = this.tabCoordinator?.getTabId?.() || 'sync_engine';
          await this.outboxRepo.markInFlight(entry.id, leaseOwner, 30000);
          await this.syncMetadataRepo.markSyncing(entry.entityType, entry.entityId, entry.userId);

          try {
            const serverResult = await this.pushMutationToCloud(entry);

            // Mutation pushed successfully
            await this.outboxRepo.markCompleted(entry.id);
            const { isFullySynced } = await this.syncMetadataRepo.acknowledgePush({
              entityType: entry.entityType,
              entityId: entry.entityId,
              userId: entry.userId,
              ackLocalRevision: entry.localRevision,
              serverVersion: serverResult?.version ? String(serverResult.version) : null,
              serverUpdatedAt: serverResult?.updated_at || new Date().toISOString(),
              baseSnapshot: entry.payload || null,
            });

            // If there is newer local work pending for this entity, refresh its CAS baseline to the newly acknowledged server version
            if (!isFullySynced && serverResult?.version) {
              const pendingEntries = await this.outboxRepo.getPending(undefined, entry.userId);
              const nextEntry = pendingEntries.find(
                (e) => e.entityType === entry.entityType && e.entityId === entry.entityId
              );
              if (nextEntry) {
                await this.outboxRepo.updateBaseServerVersion(nextEntry.id, String(serverResult.version));
              }
            }

            this.lastSyncedAt = new Date();
          } catch (err: any) {
            console.warn(`[SyncEngine] Push failed for entry ${entry.id}:`, err);

            const classified = classifySyncError(err);
            this.lastError = {
              code: classified.code,
              message: classified.message,
            };

            await this.outboxRepo.markFailed(entry.id, classified, this.maxRetries);

            if (classified.code === 'CONFLICT') {
              let remotePayload: any = null;
              try {
                const tableName =
                  entry.entityType === 'document'
                    ? 'documents'
                    : entry.entityType === 'system_design'
                    ? 'system_designs'
                    : 'workspace_folders';
                const sel = this.supabase
                  .from(tableName)
                  .select('*')
                  .eq('id', entry.entityId);
                const queryPromise = typeof sel?.maybeSingle === 'function'
                  ? sel.maybeSingle()
                  : typeof sel?.single === 'function'
                  ? sel.single()
                  : Promise.resolve({ data: null });
                const { data } = await queryPromise;
                remotePayload = data;
              } catch (fetchErr) {
                console.warn('[SyncEngine] Failed to fetch remote payload for conflict:', fetchErr);
              }

              const syncMeta = await this.syncMetadataRepo.get(entry.entityType, entry.entityId);

              await this.conflictRepo.recordConflict({
                entityType: entry.entityType,
                entityId: entry.entityId,
                userId: entry.userId,
                basePayload: syncMeta?.baseSnapshot ?? null,
                localPayload: entry.payload,
                remotePayload,
              });

              await this.syncMetadataRepo.markConflict(entry.entityType, entry.entityId, entry.userId);
            } else {
              await this.syncMetadataRepo.markError(entry.entityType, entry.entityId, entry.userId);
            }

            if (classified.code === 'AUTH_EXPIRED') {
              this.state = 'error';
              stopDrainBatch = true;
              break;
            }

            if (classified.retryable) {
              stopDrainBatch = true;
              break; // Stop draining batch until network/transient issue resolves
            }
          }
        }

        if (stopDrainBatch) {
          this.state = 'error';
          break;
        }
      }
    } catch (unexpected: any) {
      if (this.isDestroyed || unexpected?.name === 'DatabaseClosedError' || unexpected?.inner?.name === 'DatabaseClosedError') {
        return;
      }
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
   * Pulls changes from remote change feed.
   */
  async pullChanges(userId: string): Promise<{ totalPulled: number; finalCursor: number }> {
    return await this.pullEngine.pullAll(userId);
  }

  /**
   * Pushes a single outbox mutation to Supabase via modular entity push adapter.
   * All network requests are bounded by TRANSPORT_TIMEOUT_MS to prevent loop starvation.
   */
  async pushMutationToCloud(entry: OutboxEntry): Promise<{ version?: string; updated_at?: string } | null> {
    const adapter = getPushAdapter(entry.entityType);
    return await adapter.push(entry, this.supabase);
  }
}

// User-scoped instance cache for application runtime
const syncEngineInstances = new Map<string, SyncEngine>();

export function getSyncEngine(userId?: string | null): SyncEngine {
  const scope = userId ? getUserScopeHash(userId) : 'default';
  let engine = syncEngineInstances.get(scope);
  if (!engine) {
    const userDb = userId ? getUserArtixDB(userId) : undefined;
    engine = new SyncEngine({
      outboxRepo: userDb ? new OutboxRepository(userDb) : undefined,
      syncMetadataRepo: userDb ? new SyncMetadataRepository(userDb) : undefined,
      conflictRepo: userDb ? new ConflictRepository(userDb) : undefined,
      pullEngine: userDb ? new PullEngine({ supabaseClient: defaultSupabaseClient, db: userDb }) : undefined,
    });
    syncEngineInstances.set(scope, engine);
  }
  return engine;
}
