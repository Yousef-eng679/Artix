import { supabase as defaultSupabaseClient } from '@/integrations/supabase/client';
import { OutboxRepository, isValidPositiveBaseVersion } from '../repositories/outboxRepository';
import { SyncMetadataRepository } from '../repositories/syncMetadataRepository';
import { ConflictRepository } from '../repositories/conflictRepository';
import { PullEngine } from './pullEngine';
import { EntityType, OutboxEntry } from '../local/types';
import { getTabCoordinator, TabCoordinator } from './tabCoordinator';
import { getUserArtixDB, getUserScopeHash } from '../local/db';
import { orderOutboxByDependency } from './dependencyOrder';
import { classifySyncError } from './errorTaxonomy';
import { getPushAdapter } from './adapters';
import { TRANSPORT_TIMEOUT_MS, withTimeout } from './transportTimeout';

export type SyncStatusState = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncStatus {
  state: SyncStatusState;
  isOnline: boolean;
  pendingCount: number;
  blockedCount?: number;
  lastSyncedAt: Date | null;
  error?: { code: string; message: string } | null;
}

export interface SyncEngineOptions {
  userId?: string;
  autoSyncOnEnqueue?: boolean;
  supabaseClient?: any;
  outboxRepo?: OutboxRepository;
  syncMetadataRepo?: SyncMetadataRepository;
  conflictRepo?: ConflictRepository;
  pullEngine?: PullEngine;
  tabCoordinator?: TabCoordinator;
  maxRetries?: number;
  batchSize?: number;
}

export { TRANSPORT_TIMEOUT_MS, withTimeout };

function getEntityTableName(entityType: EntityType): string {
  switch (entityType) {
    case 'project':
      return 'projects';
    case 'document':
      return 'documents';
    case 'system_design':
      return 'system_designs';
    case 'workspace_folder':
      return 'workspace_folders';
    default:
      return `${entityType}s`;
  }
}

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
  private userId?: string;
  private autoSyncOnEnqueue: boolean;
  private state: SyncStatusState = 'idle';
  private lastSyncedAt: Date | null = null;
  private lastError: { code: string; message: string } | null = null;
  private activeSyncPromise: Promise<void> | null = null;
  private pendingFollowUpSync = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(status: SyncStatus) => void>();
  private unsubSyncRequest?: () => void;
  private unsubLeadershipChange?: () => void;
  private unsubEnqueue?: () => void;

  private onlineHandler?: () => void;
  private offlineHandler?: () => void;
  private isDestroyed = false;

  constructor(options: SyncEngineOptions = {}) {
    this.userId = options.userId;
    this.autoSyncOnEnqueue = options.autoSyncOnEnqueue ?? Boolean(options.userId);
    this.supabase = options.supabaseClient || defaultSupabaseClient;
    this.outboxRepo = options.outboxRepo || new OutboxRepository();
    const sharedDb =
      typeof this.outboxRepo?.getDb === 'function' ? this.outboxRepo.getDb() : undefined;
    this.syncMetadataRepo = options.syncMetadataRepo || new SyncMetadataRepository(sharedDb);
    this.conflictRepo = options.conflictRepo || new ConflictRepository(sharedDb);
    this.pullEngine =
      options.pullEngine ||
      new PullEngine({
        supabaseClient: this.supabase,
        db: sharedDb,
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
    this.outboxRepo.recoverStaleLeases({
      currentTabId: this.tabCoordinator?.getTabId?.(),
      forceOrphanedByOtherTabs: this.tabCoordinator?.isLeaderTab?.() ?? false,
    }).catch((err) => {
      if (this.isDestroyed || err?.name === 'DatabaseClosedError') return;
      console.warn('[SyncEngine] Initial stale lease recovery error:', err);
    });

    // Wake automatically post-commit whenever a local mutation is enqueued (OF-09)
    if (this.autoSyncOnEnqueue && typeof this.outboxRepo?.onEnqueue === 'function') {
      this.unsubEnqueue = this.outboxRepo.onEnqueue((enqueuedUserId) => {
        if (this.isDestroyed) return;
        if (this.userId && enqueuedUserId !== this.userId) return;
        this.triggerSync(enqueuedUserId).catch((err) => {
          if (!this.isDestroyed && err?.name !== 'DatabaseClosedError') {
            console.warn('[SyncEngine] Auto-sync on outbox enqueue failed:', err);
          }
        });
      });
    }

    // React immediately when this tab is promoted to leader
    if (typeof this.tabCoordinator?.onLeadershipChange === 'function') {
      this.unsubLeadershipChange = this.tabCoordinator.onLeadershipChange((isLeader) => {
        if (isLeader && !this.isDestroyed) {
          this.triggerSync(this.userId).catch((err) => {
            if (!this.isDestroyed && err?.name !== 'DatabaseClosedError') {
              console.warn('[SyncEngine] Sync on leadership election failed:', err);
            }
          });
        } else if (!isLeader) {
          this.clearRetryTimer();
        }
      });
    }

    // Leader responds to sync requests from standby tabs
    if (typeof this.tabCoordinator?.onSyncRequest === 'function') {
      this.unsubSyncRequest = this.tabCoordinator.onSyncRequest(() => {
        this.triggerSync(this.userId).catch((err) => {
          console.warn('[SyncEngine] Sync on remote request failed:', err);
        });
      });
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async scheduleNextRetryTimer(userId?: string): Promise<void> {
    this.clearRetryTimer();
    if (
      this.isDestroyed ||
      !this.isOnline ||
      (typeof navigator !== 'undefined' && !navigator.onLine) ||
      !this.tabCoordinator.isLeaderTab() ||
      typeof this.outboxRepo?.getEarliestRetryAt !== 'function'
    ) {
      return;
    }

    try {
      const targetUserId = userId || this.userId;
      const earliestRetryAt = await this.outboxRepo.getEarliestRetryAt(targetUserId);
      if (earliestRetryAt === null || this.isDestroyed) {
        return;
      }

      const delayMs = Math.max(0, earliestRetryAt - Date.now());
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.isDestroyed) return;
        this.triggerSync(targetUserId || this.userId).catch((err) => {
          if (!this.isDestroyed && err?.name !== 'DatabaseClosedError') {
            console.warn('[SyncEngine] Scheduled retry sync failed:', err);
          }
        });
      }, delayMs);
    } catch (err: any) {
      if (!this.isDestroyed && err?.name !== 'DatabaseClosedError') {
        console.warn('[SyncEngine] Failed to inspect nextRetryAt schedule:', err);
      }
    }
  }

  private setupNetworkListeners(): void {
    if (typeof window !== 'undefined') {
      this.onlineHandler = () => {
        this.isOnline = true;
        this.notifySubscribers();
        this.triggerSync(this.userId).catch((err) => {
          console.warn('[SyncEngine] Auto-sync on reconnection failed:', err);
        });
      };

      this.offlineHandler = () => {
        this.isOnline = false;
        this.state = 'offline';
        this.clearRetryTimer();
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
    this.pendingFollowUpSync = false;
    this.clearRetryTimer();
    if (this.unsubEnqueue) {
      this.unsubEnqueue();
      this.unsubEnqueue = undefined;
    }
    if (this.unsubSyncRequest) {
      this.unsubSyncRequest();
      this.unsubSyncRequest = undefined;
    }
    if (this.unsubLeadershipChange) {
      this.unsubLeadershipChange();
      this.unsubLeadershipChange = undefined;
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
    const blockedCount =
      typeof this.outboxRepo?.getBlocked === 'function'
        ? (await this.outboxRepo.getBlocked(userId || this.userId)).length
        : 0;
    return {
      state: this.state,
      isOnline: this.isOnline,
      pendingCount,
      blockedCount,
      lastSyncedAt: this.lastSyncedAt,
      error: this.lastError,
    };
  }

  /**
   * User-initiated recovery (e.g. after upgrading plan or freeing quota): returns blocked,
   * non-conflict outbox entries to the queue with a fresh retry budget and syncs immediately.
   */
  async retryBlocked(userId?: string): Promise<number> {
    const targetUserId = userId || this.userId;
    if (!targetUserId || typeof this.outboxRepo?.retryAllBlocked !== 'function') return 0;
    const count = await this.outboxRepo.retryAllBlocked(targetUserId);
    if (count > 0) {
      this.lastError = null;
      this.notifySubscribers();
      await this.triggerSync(targetUserId);
    }
    return count;
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
   * Coalesces concurrent triggers arriving mid-flight into a single immediate follow-up pass.
   */
  async triggerSync(userId?: string): Promise<void> {
    if (this.isDestroyed) return;

    if (userId) {
      this.userId = userId;
    }
    const effectiveUserId = userId || this.userId;

    if (this.activeSyncPromise) {
      this.pendingFollowUpSync = true;
      return this.activeSyncPromise;
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.isOnline = false;
      this.state = 'offline';
      this.clearRetryTimer();
      this.notifySubscribers();
      return;
    }

    this.isOnline = true;

    // If this tab is not the elected leader, delegate sync to the leader tab
    if (!this.tabCoordinator.isLeaderTab()) {
      this.tabCoordinator.requestLeaderSync();
      return;
    }

    this.clearRetryTimer();
    this.activeSyncPromise = this.runSyncPasses(effectiveUserId).finally(() => {
      this.activeSyncPromise = null;
    });

    return this.activeSyncPromise;
  }

  private async runSyncPasses(initialUserId?: string): Promise<void> {
    try {
      do {
        this.pendingFollowUpSync = false;
        const targetUserId = initialUserId || this.userId;
        await this.drainOutbox(targetUserId);
      } while (
        this.pendingFollowUpSync &&
        !this.isDestroyed &&
        this.isOnline &&
        (typeof navigator === 'undefined' || navigator.onLine) &&
        this.tabCoordinator.isLeaderTab()
      );
    } finally {
      if (!this.isDestroyed) {
        await this.scheduleNextRetryTimer(initialUserId || this.userId);
      }
    }
  }

  /**
   * Universal pre-push reconciler for legacy or interrupted outbox entries
   * missing a valid CAS `baseServerVersion` (Audit Gap C-03).
   */
  private async reconcileMissingCasBaseline(
    entry: OutboxEntry
  ): Promise<{ action: 'proceed'; entry: OutboxEntry } | { action: 'defer' } | { action: 'handled' }> {
    if (entry.operation === 'create' || isValidPositiveBaseVersion(entry.baseServerVersion)) {
      return { action: 'proceed', entry };
    }

    // 1. Heal from local sync_metadata if a valid serverVersion is already recorded
    const meta = await this.syncMetadataRepo.get(entry.entityType, entry.entityId);
    if (meta && meta.syncState !== 'deleted_synced' && isValidPositiveBaseVersion(meta.serverVersion)) {
      await this.outboxRepo.updateBaseServerVersion(entry.id, meta.serverVersion);
      return {
        action: 'proceed',
        entry: { ...entry, baseServerVersion: meta.serverVersion },
      };
    }

    // 2. If an earlier create for this entity is still pending or in-flight, defer until create completes
    const siblingEntries = await this.outboxRepo.listByEntity(
      entry.userId,
      entry.entityType,
      entry.entityId
    );
    const hasUnpushedCreate = siblingEntries.some(
      (s) =>
        s.id !== entry.id &&
        s.operation === 'create' &&
        (s.state === 'pending' || s.state === 'in_flight')
    );
    if (hasUnpushedCreate) {
      return { action: 'defer' };
    }

    // 3. Query authoritative remote row (if table query API is available)
    if (typeof this.supabase?.from === 'function') {
      const tableName = getEntityTableName(entry.entityType);
      const tableBuilder = this.supabase.from(tableName);
      if (typeof tableBuilder?.select === 'function') {
        const sel = tableBuilder.select('*').eq('id', entry.entityId);
        const queryPromise =
          typeof sel?.maybeSingle === 'function'
            ? sel.maybeSingle()
            : typeof sel?.single === 'function'
            ? sel.single()
            : null;

        if (queryPromise) {
          const { data: remoteRow, error } = await withTimeout<any>(queryPromise);
          if (error) {
            throw error;
          }

          if (!remoteRow) {
            if (entry.operation === 'delete') {
              await this.outboxRepo.markCompleted(entry.id);
              await this.syncMetadataRepo.upsert({
                entityType: entry.entityType,
                entityId: entry.entityId,
                userId: entry.userId,
                syncState: 'deleted_synced',
              });
              return { action: 'handled' };
            }

            const neverSyncedBefore =
              !meta?.lastSyncedAt && !meta?.serverUpdatedAt && !meta?.baseSnapshot;
            if (neverSyncedBefore) {
              await this.outboxRepo.convertToCreate(entry.id, entry.payload);
              return {
                action: 'proceed',
                entry: { ...entry, operation: 'create', baseServerVersion: null },
              };
            }

            // Previously synced entity was deleted remotely on another device -> fail closed into conflict
            const conflictMeta = {
              code: 'CONFLICT',
              message: `Remote ${entry.entityType} '${entry.entityId}' was deleted while missing local CAS baseline`,
              retryable: false,
            };
            await this.outboxRepo.markFailed(entry.id, conflictMeta, this.maxRetries);
            await this.conflictRepo.recordConflict({
              entityType: entry.entityType,
              entityId: entry.entityId,
              userId: entry.userId,
              basePayload: meta?.baseSnapshot ?? null,
              localPayload: entry.payload,
              remotePayload: null,
            });
            await this.syncMetadataRepo.markConflict(entry.entityType, entry.entityId, entry.userId);
            return { action: 'handled' };
          }

          const remoteVersionStr =
            remoteRow.version !== undefined && remoteRow.version !== null
              ? String(remoteRow.version)
              : null;

          // Only adopt remote version automatically when serverUpdatedAt proves zero remote divergence
          if (
            isValidPositiveBaseVersion(remoteVersionStr) &&
            Boolean(meta?.serverUpdatedAt) &&
            remoteRow.updated_at === meta?.serverUpdatedAt
          ) {
            await this.outboxRepo.updateBaseServerVersion(entry.id, remoteVersionStr);
            await this.syncMetadataRepo.upsert({
              entityType: entry.entityType,
              entityId: entry.entityId,
              userId: entry.userId,
              serverVersion: remoteVersionStr,
            });
            return {
              action: 'proceed',
              entry: { ...entry, baseServerVersion: remoteVersionStr },
            };
          }

          // Fail closed: remote row diverged or baseline provenance is unknown -> record 3-way conflict
          const conflictMeta = {
            code: 'CONFLICT',
            message: `Cannot safely infer CAS baseline for ${entry.entityType} '${entry.entityId}'; remote state diverged`,
            retryable: false,
          };
          await this.outboxRepo.markFailed(entry.id, conflictMeta, this.maxRetries);
          await this.conflictRepo.recordConflict({
            entityType: entry.entityType,
            entityId: entry.entityId,
            userId: entry.userId,
            basePayload: meta?.baseSnapshot ?? null,
            localPayload: entry.payload,
            remotePayload: remoteRow,
          });
          await this.syncMetadataRepo.markConflict(entry.entityType, entry.entityId, entry.userId);
          return { action: 'handled' };
        }
      }
    }

    // No local or remote baseline available -> let adapter fail closed with INVALID_CAS_BASELINE
    return { action: 'proceed', entry };
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

      // Reclaim any stalled or crashed leases prior to processing the drain batch.
      await this.outboxRepo.recoverStaleLeases({
        currentTabId: this.tabCoordinator?.getTabId?.(),
        forceOrphanedByOtherTabs: true,
      });

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

        // Topologically order the batch so prerequisites (e.g. projects & folders) precede dependents
        const orderedEntries = orderOutboxByDependency(pendingEntries);
        let stopDrainBatch = false;
        let madeProgressInPass = false;
        const haltedEntityKeys = new Set<string>();

        for (const queuedEntry of orderedEntries) {
          const entityKey = `${queuedEntry.userId}:${queuedEntry.entityType}:${queuedEntry.entityId}`;
          if (haltedEntityKeys.has(entityKey)) {
            continue;
          }

          const latestEntry = await this.outboxRepo.getById(queuedEntry.id);
          if (!latestEntry) {
            continue;
          }
          if (latestEntry.state === 'blocked') {
            haltedEntityKeys.add(entityKey);
            continue;
          }

          let entry = latestEntry;

          try {
            const reconciliation = await this.reconcileMissingCasBaseline(entry);
            if (reconciliation.action === 'defer') {
              haltedEntityKeys.add(entityKey);
              continue;
            }
            if (reconciliation.action === 'handled') {
              const afterReconcile = await this.outboxRepo.getById(entry.id);
              if (afterReconcile && afterReconcile.state === 'blocked') {
                haltedEntityKeys.add(entityKey);
              }
              madeProgressInPass = true;
              continue;
            }
            entry = reconciliation.entry;
          } catch (reconcileErr: any) {
            haltedEntityKeys.add(entityKey);
            const classified = classifySyncError(reconcileErr);
            this.lastError = { code: classified.code, message: classified.message };
            await this.outboxRepo.markFailed(entry.id, classified, this.maxRetries);
            await this.syncMetadataRepo.markError(entry.entityType, entry.entityId, entry.userId);
            if (classified.code === 'AUTH_EXPIRED' || classified.retryable) {
              stopDrainBatch = true;
              break;
            }
            madeProgressInPass = true;
            continue;
          }

          // Mark in-flight with tab lease owner, unique fencing leaseToken, and 30s timeout
          const leaseOwner = this.tabCoordinator?.getTabId?.() || 'sync_engine';
          const hasRealDb = typeof this.outboxRepo?.getDb === 'function';
          const claimedLeaseToken = await this.outboxRepo.markInFlight(entry.id, leaseOwner, 30000);
          if (hasRealDb && claimedLeaseToken === null) {
            // Entry was concurrently removed or blocked before lease could be acquired
            continue;
          }
          await this.syncMetadataRepo.markSyncing(entry.entityType, entry.entityId, entry.userId);

          let serverResult: { version?: string; updated_at?: string } | null = null;
          let pushSucceeded = false;

          try {
            serverResult = await this.pushMutationToCloud(entry);
            pushSucceeded = true;
          } catch (err: any) {
            haltedEntityKeys.add(entityKey);
            console.warn(`[SyncEngine] Push failed for entry ${entry.id}:`, err);

            const classified = classifySyncError(err);

            let remotePayload: any = err?.remoteSnapshot !== undefined ? err.remoteSnapshot : null;
            if (classified.code === 'CONFLICT' && err?.remoteSnapshot === undefined) {
              try {
                const tableName = getEntityTableName(entry.entityType);
                const sel = this.supabase
                  .from(tableName)
                  .select('*')
                  .eq('id', entry.entityId);
                const queryPromise =
                  typeof sel?.maybeSingle === 'function'
                    ? sel.maybeSingle()
                    : typeof sel?.single === 'function'
                    ? sel.single()
                    : Promise.resolve({ data: null });
                const { data } = await queryPromise;
                remotePayload = data;
              } catch (fetchErr) {
                console.warn('[SyncEngine] Failed to fetch remote payload for conflict:', fetchErr);
              }
            }

            const db = hasRealDb ? this.outboxRepo.getDb() : null;
            const canTransactAtomically =
              Boolean(db) &&
              typeof this.syncMetadataRepo?.getDb === 'function' &&
              this.syncMetadataRepo.getDb() === db &&
              (classified.code !== 'CONFLICT' ||
                (typeof this.conflictRepo?.getDb === 'function' && this.conflictRepo.getDb() === db));

            let wasFenced = false;

            if (canTransactAtomically && db) {
              const tables =
                classified.code === 'CONFLICT'
                  ? [db.outbox, db.sync_metadata, db.conflicts]
                  : [db.outbox, db.sync_metadata];

              await db.transaction('rw', tables, async () => {
                const current = await db.outbox.get(entry.id);
                if (!current || (claimedLeaseToken && current.leaseToken !== claimedLeaseToken)) {
                  wasFenced = true;
                  return;
                }

                await this.outboxRepo.markFailedInTx(entry.id, classified, this.maxRetries);

                if (classified.code === 'CONFLICT') {
                  const syncMeta = await this.syncMetadataRepo.get(entry.entityType, entry.entityId);
                  await this.conflictRepo.recordConflictInTx({
                    entityType: entry.entityType,
                    entityId: entry.entityId,
                    userId: entry.userId,
                    basePayload: syncMeta?.baseSnapshot ?? null,
                    localPayload: entry.payload,
                    remotePayload,
                  });
                  await this.syncMetadataRepo.upsertInTx({
                    entityType: entry.entityType,
                    entityId: entry.entityId,
                    userId: entry.userId,
                    syncState: 'conflict',
                  });
                } else {
                  await this.syncMetadataRepo.upsertInTx({
                    entityType: entry.entityType,
                    entityId: entry.entityId,
                    userId: entry.userId,
                    syncState: 'error',
                  });
                }
              });
            } else {
              await this.outboxRepo.markFailed(entry.id, classified, this.maxRetries);
              if (classified.code === 'CONFLICT') {
                const syncMeta = await this.syncMetadataRepo.get(entry.entityType, entry.entityId);
                await this.conflictRepo.recordConflict({
                  entityType: entry.entityType,
                  entityId: entry.entityId,
                  userId: entry.userId,
                  basePayload: syncMeta?.baseSnapshot ?? null,
                  localPayload: entry.payload,
                  remotePayload,
                });
                await this.syncMetadataRepo.markConflict(
                  entry.entityType,
                  entry.entityId,
                  entry.userId
                );
              } else {
                await this.syncMetadataRepo.markError(
                  entry.entityType,
                  entry.entityId,
                  entry.userId
                );
              }
            }

            if (wasFenced) {
              // Stale zombie tab lost lease ownership; ignore failure completely without touching engine error state
              continue;
            }

            this.lastError = {
              code: classified.code,
              message: classified.message,
            };
            madeProgressInPass = true;

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

          if (pushSucceeded) {
            const db = hasRealDb ? this.outboxRepo.getDb() : null;
            const canTransactAtomically =
              Boolean(db) &&
              typeof this.syncMetadataRepo?.getDb === 'function' &&
              this.syncMetadataRepo.getDb() === db;

            let wasFenced = false;

            if (canTransactAtomically && db) {
              await db.transaction('rw', [db.outbox, db.sync_metadata], async () => {
                const current = await db.outbox.get(entry.id);
                if (!current || (claimedLeaseToken && current.leaseToken !== claimedLeaseToken)) {
                  wasFenced = true;
                  return;
                }

                await db.outbox.delete(entry.id);
                const { isFullySynced } = await this.syncMetadataRepo.acknowledgePushInTx({
                  entityType: entry.entityType,
                  entityId: entry.entityId,
                  userId: entry.userId,
                  ackLocalRevision: entry.localRevision,
                  ackMutationId: entry.mutationId,
                  serverVersion: serverResult?.version ? String(serverResult.version) : null,
                  serverUpdatedAt: serverResult?.updated_at || new Date().toISOString(),
                  baseSnapshot: entry.payload || null,
                });

                if (!isFullySynced && serverResult?.version) {
                  const siblings = await db.outbox
                    .where('[userId+entityType+entityId]')
                    .equals([entry.userId, entry.entityType, entry.entityId])
                    .toArray();
                  const nextEntry = siblings
                    .filter((e) => e.state === 'pending')
                    .sort((a, b) => a.createdAt - b.createdAt)[0];
                  if (nextEntry) {
                    await db.outbox.update(nextEntry.id, {
                      baseServerVersion: String(serverResult.version),
                      updatedAt: Date.now(),
                    });
                  }
                }
              });
            } else {
              await this.outboxRepo.markCompleted(entry.id);
              const { isFullySynced } = await this.syncMetadataRepo.acknowledgePush({
                entityType: entry.entityType,
                entityId: entry.entityId,
                userId: entry.userId,
                ackLocalRevision: entry.localRevision,
                ackMutationId: entry.mutationId,
                serverVersion: serverResult?.version ? String(serverResult.version) : null,
                serverUpdatedAt: serverResult?.updated_at || new Date().toISOString(),
                baseSnapshot: entry.payload || null,
              });

              if (!isFullySynced && serverResult?.version) {
                const remainingPending = await this.outboxRepo.getPending(undefined, entry.userId);
                const nextEntry = remainingPending
                  .filter(
                    (e) => e.entityType === entry.entityType && e.entityId === entry.entityId
                  )
                  .sort((a, b) => a.createdAt - b.createdAt)[0];
                if (nextEntry) {
                  await this.outboxRepo.updateBaseServerVersion(
                    nextEntry.id,
                    String(serverResult.version)
                  );
                }
              }
            }

            if (wasFenced) {
              continue;
            }

            this.lastSyncedAt = new Date();
            madeProgressInPass = true;
          }
        }

        if (stopDrainBatch || !madeProgressInPass) {
          if (stopDrainBatch) {
            this.state = 'error';
          } else {
            this.state = 'idle';
          }
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
      userId: userId ?? undefined,
      outboxRepo: userDb ? new OutboxRepository(userDb) : undefined,
      syncMetadataRepo: userDb ? new SyncMetadataRepository(userDb) : undefined,
      conflictRepo: userDb ? new ConflictRepository(userDb) : undefined,
      pullEngine: userDb ? new PullEngine({ supabaseClient: defaultSupabaseClient, db: userDb }) : undefined,
    });
    syncEngineInstances.set(scope, engine);
  }
  return engine;
}
