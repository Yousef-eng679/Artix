import { supabase as defaultSupabaseClient } from '@/integrations/supabase/client';
import { ArtixDB, getArtixDB } from '../local/db';
import { ProjectRepository } from '../repositories/projectRepository';
import { DocumentRepository } from '../repositories/documentRepository';
import { WorkspaceFolderRepository } from '../repositories/folderRepository';
import { SystemDesignRepository } from '../repositories/systemDesignRepository';
import { ConflictRepository } from '../repositories/conflictRepository';
import { SyncMetadataRepository } from '../repositories/syncMetadataRepository';
import {
  EntityType,
  OutboxOperation,
  SyncState,
  RemoteProjectSnapshot,
  RemoteDocumentSnapshot,
  RemoteWorkspaceFolderSnapshot,
  RemoteSystemDesignSnapshot,
  ConflictRecord,
} from '../local/types';
import { withTimeout } from './syncEngine';
import { TabCoordinator, getTabCoordinator } from './tabCoordinator';

export interface PullEngineOptions {
  supabaseClient?: any;
  db?: ArtixDB;
  projectRepo?: ProjectRepository;
  documentRepo?: DocumentRepository;
  folderRepo?: WorkspaceFolderRepository;
  systemDesignRepo?: SystemDesignRepository;
  conflictRepo?: ConflictRepository;
  syncMetadataRepo?: SyncMetadataRepository;
  tabCoordinator?: TabCoordinator;
  batchSize?: number;
  onHydrationChange?: (isHydrated: boolean) => void;
}

export interface SyncFeedBounds {
  minRetainedSequence: number;
  maxSequence: number;
}

export interface PullResult {
  pulledCount: number;
  newCursor: number;
  hasMore: boolean;
}

export class PullEngine {
  private supabase: any;
  private db: ArtixDB;
  private projectRepo: ProjectRepository;
  private documentRepo: DocumentRepository;
  private folderRepo: WorkspaceFolderRepository;
  private systemDesignRepo: SystemDesignRepository;
  private conflictRepo: ConflictRepository;
  private syncMetadataRepo: SyncMetadataRepository;
  private tabCoordinator?: TabCoordinator;
  private batchSize: number;
  private onHydrationChange?: (isHydrated: boolean) => void;

  constructor(options: PullEngineOptions = {}) {
    this.db = options.db || getArtixDB();
    this.supabase = options.supabaseClient || defaultSupabaseClient;
    this.projectRepo = options.projectRepo || new ProjectRepository(this.db);
    this.documentRepo = options.documentRepo || new DocumentRepository(this.db);
    this.folderRepo = options.folderRepo || new WorkspaceFolderRepository(this.db);
    this.systemDesignRepo = options.systemDesignRepo || new SystemDesignRepository(this.db);
    this.conflictRepo = options.conflictRepo || new ConflictRepository(this.db);
    this.syncMetadataRepo = options.syncMetadataRepo || new SyncMetadataRepository(this.db);
    this.tabCoordinator = options.tabCoordinator;
    this.batchSize = options.batchSize ?? 50;
    this.onHydrationChange = options.onHydrationChange;
  }

  /**
   * Returns true once an initial workspace snapshot hydration has completed on this profile.
   */
  async isHydrated(): Promise<boolean> {
    try {
      const meta = await this.db.database_meta.get('hydration_complete');
      return Boolean(meta?.value);
    } catch {
      return false;
    }
  }

  /**
   * Queries server feed retention floor and ceiling via `get_sync_feed_bounds()` RPC when available.
   */
  async getFeedBounds(_userId: string): Promise<SyncFeedBounds | null> {
    const rpcFn = this.supabase?.rpc;
    if (typeof rpcFn !== 'function') {
      return null;
    }

    try {
      const res = await withTimeout<{ data: any; error: any }>(
        rpcFn.call(this.supabase, 'get_sync_feed_bounds'),
      );
      if (res?.error || !res?.data || typeof res.data !== 'object' || Array.isArray(res.data)) {
        return null;
      }
      const minRetained = Number(res.data.min_retained_sequence);
      const maxSeq = Number(res.data.max_sequence);
      if (!Number.isFinite(minRetained) || !Number.isFinite(maxSeq)) {
        return null;
      }
      return {
        minRetainedSequence: Math.max(0, Math.trunc(minRetained)),
        maxSequence: Math.max(0, Math.trunc(maxSeq)),
      };
    } catch {
      return null;
    }
  }

  /**
   * Retrieves the current persisted server cursor from local database_meta.
   */
  async getCursor(): Promise<number> {
    const meta = await this.db.database_meta.get('server_cursor');
    return typeof meta?.value === 'number' ? meta.value : 0;
  }

  /**
   * Sets the server cursor.
   */
  async setCursor(cursor: number): Promise<void> {
    await this.db.database_meta.put({
      key: 'server_cursor',
      value: cursor,
      updatedAt: Date.now(),
    });
  }

  private async getLocalEntityRow(
    entityType: EntityType,
    entityId: string,
  ): Promise<{ isDeleted?: boolean; localRevision?: number } | null> {
    if (entityType === 'project') {
      return (await this.db.projects.get(entityId)) ?? null;
    }
    if (entityType === 'document') {
      return (await this.db.documents.get(entityId)) ?? null;
    }
    if (entityType === 'workspace_folder') {
      return (await this.db.workspace_folders.get(entityId)) ?? null;
    }
    if (entityType === 'system_design') {
      return (await this.db.system_designs.get(entityId)) ?? null;
    }
    return null;
  }

  private async querySyncChangesBatch(userId: string, currentCursor: number): Promise<{ data: any[] | null; error: any } | null> {
    const changesTable = this.supabase?.from?.('sync_changes');
    if (!changesTable || typeof changesTable.select !== 'function') {
      return null;
    }

    const executeSelect = async (columns: string) => {
      const selectQuery = changesTable.select(columns);
      if (typeof selectQuery?.eq !== 'function') return { data: [] as any[], error: null };
      const eqQuery = selectQuery.eq('user_id', userId);
      if (typeof eqQuery?.gt !== 'function') return { data: [] as any[], error: null };
      const gtQuery = eqQuery.gt('sequence', currentCursor);
      if (typeof gtQuery?.order !== 'function') return { data: [] as any[], error: null };
      const orderQuery = gtQuery.order('sequence', { ascending: true });
      if (typeof orderQuery?.limit !== 'function') return { data: [] as any[], error: null };
      return await withTimeout<{ data: any[] | null; error: any }>(orderQuery.limit(this.batchSize));
    };

    const primary = await executeSelect(
      'sequence, user_id, entity_type, entity_id, operation, entity_version, mutation_id, payload, changed_at',
    );

    if (
      primary.error &&
      (primary.error.code === '42703' ||
        String(primary.error.message || '').includes('mutation_id'))
    ) {
      return await executeSelect(
        'sequence, user_id, entity_type, entity_id, operation, entity_version, payload, changed_at',
      );
    }

    return primary;
  }

  /**
   * Pulls a single batch of changes from Supabase sync_changes feed and applies them locally.
   * Runs atomically across local entity tables, outbox, metadata, and cursor.
   */
  async pullBatch(userId: string): Promise<PullResult> {
    const currentCursor = await this.getCursor();

    const batchResponse = await this.querySyncChangesBatch(userId, currentCursor);
    if (!batchResponse) {
      return {
        pulledCount: 0,
        newCursor: currentCursor,
        hasMore: false,
      };
    }

    const { data, error } = batchResponse;

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      return {
        pulledCount: 0,
        newCursor: currentCursor,
        hasMore: false,
      };
    }

    let maxAppliedSequence = currentCursor;
    const committedNotifications: Array<{
      entityType: EntityType;
      entityId: string;
      operation: OutboxOperation;
      localRevision: number;
    }> = [];

    // Apply entire batch inside an atomic Dexie transaction
    await this.db.transaction(
      'rw',
      [
        this.db.projects,
        this.db.documents,
        this.db.system_designs,
        this.db.workspace_folders,
        this.db.outbox,
        this.db.sync_metadata,
        this.db.conflicts,
        this.db.database_meta,
      ],
      async () => {
        for (const change of data) {
          // Record this row's sequence before any branch can `continue`.
          if (change.sequence > maxAppliedSequence) {
            maxAppliedSequence = change.sequence;
          }

          const entityType = change.entity_type as EntityType;
          const entityId = change.entity_id as string;
          const operation = change.operation as OutboxOperation;
          const version = change.entity_version;
          const payload = change.payload || {};
          const echoedMutationId =
            typeof change.mutation_id === 'string' && change.mutation_id.length > 0
              ? change.mutation_id
              : null;

          const outboxEntries = (
            await this.db.outbox
              .where('[userId+entityType+entityId]')
              .equals([userId, entityType, entityId])
              .toArray()
          ).sort((a, b) => a.createdAt - b.createdAt);

          const syncMetaId = `${entityType}:${entityId}`;
          const syncMeta = await this.db.sync_metadata.get(syncMetaId);

          // ── Self-Echo Recognition (Audit Gap S-01 + Amendment C) ──
          const echoedEntry = echoedMutationId
            ? outboxEntries.find((e) => e.mutationId === echoedMutationId)
            : undefined;

          if (echoedEntry) {
            // Authoritative confirmation that our own dispatched mutation `echoedEntry` committed on server!
            await this.db.outbox.delete(echoedEntry.id);

            const remainingActive = outboxEntries.filter(
              (e) =>
                e.id !== echoedEntry.id &&
                (e.state === 'pending' || e.state === 'in_flight' || e.state === 'blocked'),
            );
            const localEntity = await this.getLocalEntityRow(entityType, entityId);
            const localRev = localEntity?.localRevision ?? echoedEntry.localRevision;
            const hasNewerLocalIntent =
              remainingActive.length > 0 || localRev > echoedEntry.localRevision;
            const ackVersionStr =
              version !== undefined && version !== null ? String(version) : null;

            if (hasNewerLocalIntent) {
              // Amendment C Non-Overwrite Guard:
              // DO NOT overwrite local entity payload (`P2`) with the echoed older payload (`P1`)!
              // Advance CAS baseline on the next causal outbox entry so `P2` pushes cleanly on top of `P1`.
              if (remainingActive.length > 0 && ackVersionStr) {
                await this.db.outbox.update(remainingActive[0].id, {
                  baseServerVersion: ackVersionStr,
                  updatedAt: Date.now(),
                });
              }

              const nextSyncState: SyncState = remainingActive.some((e) => e.state === 'blocked')
                ? 'conflict'
                : remainingActive[0]?.operation === 'delete'
                  ? 'deleted_pending'
                  : 'pending';

              await this.syncMetadataRepo.upsertInTx({
                entityType,
                entityId,
                userId,
                syncState: nextSyncState,
                serverVersion: ackVersionStr ?? syncMeta?.serverVersion ?? null,
                serverUpdatedAt: change.changed_at,
                localRevision: localRev,
                lastSyncedAt: Date.now(),
                lastAckedMutationId: echoedMutationId,
                baseSnapshot: operation === 'delete' ? null : payload,
              });
            } else {
              // No newer local work exists after `echoedEntry`; local entity already matches `P1`!
              await this.syncMetadataRepo.upsertInTx({
                entityType,
                entityId,
                userId,
                syncState: operation === 'delete' ? 'deleted_synced' : 'synced',
                serverVersion: ackVersionStr ?? syncMeta?.serverVersion ?? null,
                serverUpdatedAt: change.changed_at,
                localRevision: localRev,
                lastSyncedAt: Date.now(),
                lastAckedMutationId: echoedMutationId,
                baseSnapshot: operation === 'delete' ? null : payload,
              });
              committedNotifications.push({
                entityType,
                entityId,
                operation,
                localRevision: localRev,
              });
            }
            continue;
          }

          if (echoedMutationId && syncMeta?.lastAckedMutationId === echoedMutationId) {
            // Self-echo of a mutation already acknowledged via HTTP response: ignore cleanly without clobbering newer local edits
            continue;
          }

          const activeOutbox = outboxEntries.find(
            (e) => e.state === 'pending' || e.state === 'in_flight' || e.state === 'blocked'
          );

          if (activeOutbox) {
            const baselineVersion = activeOutbox.baseServerVersion
              ? parseInt(activeOutbox.baseServerVersion, 10)
              : (syncMeta?.serverVersion ? parseInt(syncMeta.serverVersion, 10) : 0);
            const remoteVersion = version !== undefined && version !== null ? parseInt(String(version), 10) : 0;

            if (activeOutbox.operation === 'delete' && operation === 'delete') {
              // Concurrent delete convergence: both sides deleted it!
              // Remove pending outbox delete and mark sync metadata deleted_synced
              await this.db.outbox.delete(activeOutbox.id);
              let rev: number | null = null;
              if (entityType === 'project') {
                rev = await this.projectRepo.delete(entityId, { skipOutbox: true });
              } else if (entityType === 'document') {
                rev = await this.documentRepo.delete(entityId, { skipOutbox: true });
              } else if (entityType === 'workspace_folder') {
                rev = await this.folderRepo.delete(entityId, { skipOutbox: true });
              } else if (entityType === 'system_design') {
                rev = await this.systemDesignRepo.delete(entityId, { skipOutbox: true });
              }
              await this.syncMetadataRepo.upsertInTx({
                entityType,
                entityId,
                userId,
                syncState: 'deleted_synced',
                serverVersion: version !== undefined && version !== null ? String(version) : syncMeta?.serverVersion ?? null,
                serverUpdatedAt: change.changed_at,
              });
              committedNotifications.push({
                entityType,
                entityId,
                operation: 'delete',
                localRevision: rev ?? change.sequence,
              });
              continue;
            }

            const isNewerRemote = remoteVersion > baselineVersion || operation === 'delete';

            if (isNewerRemote) {
              // Concurrent modification detected: local draft/intent must NOT be overwritten!
              const latestActive = outboxEntries
                .filter((e) => e.state === 'pending' || e.state === 'in_flight' || e.state === 'blocked')
                .slice(-1)[0] || activeOutbox;

              const conflictRecord: ConflictRecord = {
                id: crypto.randomUUID(),
                entityType,
                entityId,
                userId,
                basePayload: syncMeta?.baseSnapshot ?? null,
                localPayload: latestActive.operation === 'delete' ? { deleted: true } : latestActive.payload,
                remotePayload: operation === 'delete' ? { deleted: true } : payload,
                reason: operation === 'delete' ? 'remote_deleted' : 'version_mismatch',
                remoteVersion: version !== undefined && version !== null ? String(version) : null,
                detectedAt: Date.now(),
                resolvedAt: null,
              };

              await this.db.conflicts.add(conflictRecord);

              await this.syncMetadataRepo.upsertInTx({
                entityType,
                entityId,
                userId,
                syncState: 'conflict',
                serverVersion: version !== undefined && version !== null ? String(version) : syncMeta?.serverVersion ?? null,
                serverUpdatedAt: change.changed_at,
              });

              // Block active outbox entries for this entity to prevent CAS churn.
              // Tag them CONFLICT so blocked-queue UI routes them to conflict resolution, not "Retry".
              for (const entry of outboxEntries) {
                if (entry.state === 'pending' || entry.state === 'in_flight') {
                  await this.db.outbox.update(entry.id, {
                    state: 'blocked',
                    leaseOwner: null,
                    leaseToken: null,
                    leaseExpiresAt: null,
                    lastError: {
                      code: 'CONFLICT',
                      message: 'Concurrent modification conflict detected',
                      at: Date.now(),
                    },
                    updatedAt: Date.now(),
                  });
                }
              }

              committedNotifications.push({
                entityType,
                entityId,
                operation,
                localRevision: latestActive.localRevision,
              });
            } else {
              // Stale remote observation (remoteVersion <= baselineVersion) -> ignore cleanly, preserve local intent
            }
          } else {
            // Clean application of remote change
            const localEntity = await this.getLocalEntityRow(entityType, entityId);

            if (operation === 'delete') {
              let rev: number | null = null;
              if (entityType === 'project') {
                rev = await this.projectRepo.delete(entityId, { skipOutbox: true });
              } else if (entityType === 'document') {
                rev = await this.documentRepo.delete(entityId, { skipOutbox: true });
              } else if (entityType === 'workspace_folder') {
                rev = await this.folderRepo.delete(entityId, { skipOutbox: true });
              } else if (entityType === 'system_design') {
                rev = await this.systemDesignRepo.delete(entityId, { skipOutbox: true });
              }
              await this.syncMetadataRepo.upsertInTx({
                entityType,
                entityId,
                userId,
                syncState: 'deleted_synced',
                serverVersion: version !== undefined && version !== null ? String(version) : syncMeta?.serverVersion ?? null,
                serverUpdatedAt: change.changed_at,
              });
              committedNotifications.push({
                entityType,
                entityId,
                operation: 'delete',
                localRevision: rev ?? change.sequence,
              });
            } else {
              // Remote operation is create or update
              if (localEntity?.isDeleted) {
                // Entity is locally deleted. Check if remote version is stale!
                const baselineVersion = syncMeta?.serverVersion ? parseInt(syncMeta.serverVersion, 10) : 0;
                const remoteVersion = version !== undefined && version !== null ? parseInt(String(version), 10) : 0;
                if (remoteVersion <= baselineVersion) {
                  // Stale remote update arriving for an already confirmed tombstone!
                  // NON-RESURRECTION INVARIANT: Do not resurrect!
                  continue;
                }
              }
              // 'create' or 'update'
              if (entityType === 'project') {
                const snapshot: RemoteProjectSnapshot = {
                  id: entityId,
                  userId,
                  name: payload.name || 'Untitled Project',
                  serverVersion: String(version),
                  updatedAt: payload.updated_at || change.changed_at,
                  createdAt: payload.created_at || change.changed_at,
                };
                const proj = await this.projectRepo.applyRemoteSnapshot(snapshot);
                committedNotifications.push({
                  entityType,
                  entityId,
                  operation,
                  localRevision: proj.localRevision,
                });
              } else if (entityType === 'document') {
                const snapshot: RemoteDocumentSnapshot = {
                  id: entityId,
                  userId,
                  projectId: payload.project_id ?? null,
                  folderId: payload.folder_id ?? null,
                  title: payload.title ?? 'Untitled Document',
                  content: payload.content ?? '',
                  format: payload.format || 'markdown',
                  serverVersion: String(version),
                  updatedAt: payload.updated_at || change.changed_at,
                  createdAt: payload.created_at || change.changed_at,
                };
                const doc = await this.documentRepo.applyRemoteSnapshot(snapshot);
                committedNotifications.push({
                  entityType,
                  entityId,
                  operation,
                  localRevision: doc.localRevision,
                });
              } else if (entityType === 'workspace_folder') {
                const snapshot: RemoteWorkspaceFolderSnapshot = {
                  id: entityId,
                  userId,
                  projectId: payload.project_id,
                  name: payload.name || 'Untitled Folder',
                  parentFolderId: payload.parent_folder_id ?? null,
                  serverVersion: String(version),
                  updatedAt: payload.updated_at || change.changed_at,
                  createdAt: payload.created_at || change.changed_at,
                };
                const folder = await this.folderRepo.applyRemoteSnapshot(snapshot);
                committedNotifications.push({
                  entityType,
                  entityId,
                  operation,
                  localRevision: folder.localRevision,
                });
              } else if (entityType === 'system_design') {
                const snapshot: RemoteSystemDesignSnapshot = {
                  id: entityId,
                  userId,
                  projectId: payload.project_id,
                  folderId: payload.folder_id ?? null,
                  name: payload.name || 'New System Design',
                  boardState: payload.board_state,
                  serverVersion: String(version),
                  updatedAt: payload.updated_at || change.changed_at,
                  createdAt: payload.created_at || change.changed_at,
                };
                const design = await this.systemDesignRepo.applyRemoteSnapshot(snapshot);
                committedNotifications.push({
                  entityType,
                  entityId,
                  operation,
                  localRevision: design.localRevision,
                });
              }
            }
          }
        }

        // Commit updated cursor atomically with this batch
        await this.db.database_meta.put({
          key: 'server_cursor',
          value: maxAppliedSequence,
          updatedAt: Date.now(),
        });
      }
    );

    // Emit local & cross-tab reactivity notifications only AFTER the Dexie transaction commits
    if (committedNotifications.length > 0) {
      const coordinator = this.tabCoordinator || getTabCoordinator(userId);
      for (const ev of committedNotifications) {
        coordinator.notifyRemoteChange(ev);
      }
    }

    return {
      pulledCount: data.length,
      newCursor: maxAppliedSequence,
      hasMore: data.length === this.batchSize,
    };
  }

  /**
   * Sequentially drains all available remote changes until the feed is caught up.
   */
  async pullAll(userId: string, maxBatches = 20): Promise<{ totalPulled: number; finalCursor: number }> {
    let totalPulled = 0;
    let finalCursor = await this.getCursor();

    for (let batch = 0; batch < maxBatches; batch++) {
      const result = await this.pullBatch(userId);
      totalPulled += result.pulledCount;
      finalCursor = result.newCursor;

      if (!result.hasMore || result.pulledCount === 0) {
        break;
      }
    }

    return { totalPulled, finalCursor };
  }

  private async queryMaxSyncSequenceFallback(userId: string): Promise<number> {
    try {
      const changesTable = this.supabase?.from?.('sync_changes');
      if (!changesTable || typeof changesTable.select !== 'function') return 0;
      const selectQuery = changesTable.select('sequence');
      if (typeof selectQuery?.eq !== 'function') return 0;
      const eqQuery = selectQuery.eq('user_id', userId);
      if (typeof eqQuery?.order !== 'function') return 0;
      const orderQuery = eqQuery.order('sequence', { ascending: false });
      if (typeof orderQuery?.limit !== 'function') return 0;
      const res = await withTimeout<{ data: Array<{ sequence?: number }> | null; error: any }>(
        orderQuery.limit(1),
      );
      if (res.error || !Array.isArray(res.data) || res.data.length === 0) return 0;
      const seq = Number(res.data[0]?.sequence);
      return Number.isFinite(seq) && seq > 0 ? Math.trunc(seq) : 0;
    } catch {
      return 0;
    }
  }

  private probeLiveTableBuilder(
    tableName: 'projects' | 'workspace_folders' | 'documents' | 'system_designs',
    userId: string,
  ): PromiseLike<{ data: any[] | null; error: any }> | null {
    const fromFn = this.supabase?.from;
    if (typeof fromFn !== 'function') {
      return null;
    }

    try {
      const tableBuilder = fromFn.call(this.supabase, tableName);
      if (!tableBuilder || typeof tableBuilder.select !== 'function') {
        return null;
      }
      const selectQuery = tableBuilder.select('*');
      if (!selectQuery || typeof selectQuery.eq !== 'function') {
        return null;
      }
      const eqQuery = selectQuery.eq('user_id', userId);
      if (!eqQuery || typeof eqQuery.then !== 'function') {
        return null;
      }
      return eqQuery;
    } catch {
      return null;
    }
  }

  private async fetchLiveTableRows(
    tableName: 'projects' | 'workspace_folders' | 'documents' | 'system_designs',
    userId: string,
  ): Promise<{ supported: boolean; rows: any[] }> {
    const eqQuery = this.probeLiveTableBuilder(tableName, userId);
    if (!eqQuery) {
      return { supported: false, rows: [] };
    }

    const res = await withTimeout<{ data: any[] | null; error: any }>(Promise.resolve(eqQuery));
    if (res.error) {
      throw res.error;
    }
    const rows = (res.data || []).filter((r) => !r?.deleted_at);
    return { supported: true, rows };
  }

  private async reconcileWorkspaceSnapshot(
    userId: string,
    providedBounds?: SyncFeedBounds | null,
  ): Promise<{ supported: boolean; finalCursor: number }> {
    const currentCursor = await this.getCursor();

    // 1. Verify full-table PostgREST support lazily BEFORE invoking any RPC or table fetch
    if (!this.probeLiveTableBuilder('projects', userId)) {
      return { supported: false, finalCursor: currentCursor };
    }

    // 2. Capture feed ceiling BEFORE executing live table SELECTs so concurrent deltas (> ceiling) are caught by pullAll
    const bounds = providedBounds !== undefined ? providedBounds : await this.getFeedBounds(userId);
    const ceilingSequence = bounds
      ? Math.max(bounds.maxSequence, bounds.minRetainedSequence)
      : Math.max(currentCursor, await this.queryMaxSyncSequenceFallback(userId));

    const [projectsResult, foldersResult, documentsResult, designsResult] = await Promise.all([
      this.fetchLiveTableRows('projects', userId),
      this.fetchLiveTableRows('workspace_folders', userId),
      this.fetchLiveTableRows('documents', userId),
      this.fetchLiveTableRows('system_designs', userId),
    ]);

    const committedNotifications: Array<{
      entityType: EntityType;
      entityId: string;
      operation: OutboxOperation;
      localRevision: number;
    }> = [];

    const targetCursor = Math.max(
      currentCursor,
      ceilingSequence,
      bounds?.minRetainedSequence ?? 0,
    );

    await this.db.transaction(
      'rw',
      [
        this.db.projects,
        this.db.documents,
        this.db.system_designs,
        this.db.workspace_folders,
        this.db.outbox,
        this.db.sync_metadata,
        this.db.conflicts,
        this.db.database_meta,
      ],
      async () => {
        const userOutbox = (
          await this.db.outbox.where('userId').equals(userId).toArray()
        )
          .filter((e) => e.state === 'pending' || e.state === 'in_flight' || e.state === 'blocked')
          .sort((a, b) => a.createdAt - b.createdAt);

        const activeOutboxByKey = new Map<string, typeof userOutbox>();
        for (const entry of userOutbox) {
          const key = `${entry.entityType}:${entry.entityId}`;
          const list = activeOutboxByKey.get(key);
          if (list) {
            list.push(entry);
          } else {
            activeOutboxByKey.set(key, [entry]);
          }
        }

        const applyEntityGroup = async (
          entityType: EntityType,
          remoteRows: any[],
          localRows: Array<{ id: string; isDeleted?: boolean; localRevision: number }>,
          applyCleanRow: (remoteRow: any, versionStr: string) => Promise<number>,
          deleteLocalRow: (entityId: string) => Promise<number | null>,
        ) => {
          const remoteIds = new Set<string>();

          for (const remoteRow of remoteRows) {
            const entityId = String(remoteRow.id);
            remoteIds.add(entityId);

            const parsedVer =
              remoteRow.version !== undefined && remoteRow.version !== null
                ? parseInt(String(remoteRow.version), 10)
                : 1;
            const remoteVerNum = Number.isFinite(parsedVer) && parsedVer > 0 ? parsedVer : 1;
            const remoteVerStr = String(remoteVerNum);

            const key = `${entityType}:${entityId}`;
            const activeEntries = activeOutboxByKey.get(key) ?? [];
            const syncMeta = await this.db.sync_metadata.get(key);

            if (activeEntries.length > 0) {
              const alreadyConflictBlocked = activeEntries.some(
                (e) => e.state === 'blocked' && e.lastError?.code === 'CONFLICT',
              );
              if (alreadyConflictBlocked) {
                continue;
              }

              const firstActive = activeEntries[0];
              const latestActive = activeEntries[activeEntries.length - 1];
              const baselineVer = firstActive.baseServerVersion
                ? parseInt(firstActive.baseServerVersion, 10)
                : syncMeta?.serverVersion
                  ? parseInt(syncMeta.serverVersion, 10)
                  : 0;

              if (firstActive.operation === 'create' || remoteVerNum > baselineVer) {
                const conflictRecord: ConflictRecord = {
                  id: crypto.randomUUID(),
                  entityType,
                  entityId,
                  userId,
                  basePayload: syncMeta?.baseSnapshot ?? null,
                  localPayload:
                    latestActive.operation === 'delete' ? { deleted: true } : latestActive.payload,
                  remotePayload: remoteRow,
                  reason: 'version_mismatch',
                  remoteVersion: remoteVerStr,
                  detectedAt: Date.now(),
                  resolvedAt: null,
                };
                await this.db.conflicts.add(conflictRecord);
                await this.syncMetadataRepo.upsertInTx({
                  entityType,
                  entityId,
                  userId,
                  syncState: 'conflict',
                  serverVersion: remoteVerStr,
                  serverUpdatedAt: remoteRow.updated_at,
                });
                for (const entry of activeEntries) {
                  if (entry.state === 'pending' || entry.state === 'in_flight') {
                    await this.db.outbox.update(entry.id, {
                      state: 'blocked',
                      leaseOwner: null,
                      leaseToken: null,
                      leaseExpiresAt: null,
                      lastError: {
                        code: 'CONFLICT',
                        message: 'Concurrent modification conflict detected during snapshot sync',
                        at: Date.now(),
                      },
                      updatedAt: Date.now(),
                    });
                  }
                }
                committedNotifications.push({
                  entityType,
                  entityId,
                  operation: 'update',
                  localRevision: latestActive.localRevision,
                });
              } else if (!firstActive.baseServerVersion && firstActive.operation !== 'create') {
                await this.db.outbox.update(firstActive.id, {
                  baseServerVersion: remoteVerStr,
                  updatedAt: Date.now(),
                });
              }
              continue;
            }

            // No active outbox entries: enforce anti-resurrection on tombstones
            const existingLocal = localRows.find((r) => r.id === entityId);
            if (existingLocal?.isDeleted) {
              const baselineVer = syncMeta?.serverVersion
                ? parseInt(syncMeta.serverVersion, 10)
                : 0;
              if (remoteVerNum <= baselineVer) {
                continue;
              }
            }

            const newRev = await applyCleanRow(remoteRow, remoteVerStr);
            committedNotifications.push({
              entityType,
              entityId,
              operation: existingLocal ? 'update' : 'create',
              localRevision: newRev,
            });
          }

          // Reconcile local non-deleted rows absent from live server snapshot
          for (const localRow of localRows) {
            if (localRow.isDeleted) continue;
            if (remoteIds.has(localRow.id)) continue;

            const key = `${entityType}:${localRow.id}`;
            const activeEntries = activeOutboxByKey.get(key) ?? [];
            const syncMeta = await this.db.sync_metadata.get(key);

            if (activeEntries.length > 0) {
              if (activeEntries.some((e) => e.operation === 'create')) {
                // Unpushed offline creation -> preserve untouched!
                continue;
              }

              if (activeEntries.every((e) => e.operation === 'delete')) {
                for (const e of activeEntries) {
                  await this.db.outbox.delete(e.id);
                }
                const rev = await deleteLocalRow(localRow.id);
                await this.syncMetadataRepo.upsertInTx({
                  entityType,
                  entityId: localRow.id,
                  userId,
                  syncState: 'deleted_synced',
                  serverVersion: null,
                  serverUpdatedAt: new Date().toISOString(),
                });
                committedNotifications.push({
                  entityType,
                  entityId: localRow.id,
                  operation: 'delete',
                  localRevision: rev ?? localRow.localRevision,
                });
                continue;
              }

              const alreadyConflictBlocked = activeEntries.some(
                (e) => e.state === 'blocked' && e.lastError?.code === 'CONFLICT',
              );
              if (!alreadyConflictBlocked) {
                const latestActive = activeEntries[activeEntries.length - 1];
                const conflictRecord: ConflictRecord = {
                  id: crypto.randomUUID(),
                  entityType,
                  entityId: localRow.id,
                  userId,
                  basePayload: syncMeta?.baseSnapshot ?? null,
                  localPayload: latestActive.payload,
                  remotePayload: { deleted: true },
                  reason: 'remote_deleted',
                  remoteVersion: null,
                  detectedAt: Date.now(),
                  resolvedAt: null,
                };
                await this.db.conflicts.add(conflictRecord);
                await this.syncMetadataRepo.upsertInTx({
                  entityType,
                  entityId: localRow.id,
                  userId,
                  syncState: 'conflict',
                  serverVersion: null,
                  serverUpdatedAt: new Date().toISOString(),
                });
                for (const entry of activeEntries) {
                  if (entry.state === 'pending' || entry.state === 'in_flight') {
                    await this.db.outbox.update(entry.id, {
                      state: 'blocked',
                      leaseOwner: null,
                      leaseToken: null,
                      leaseExpiresAt: null,
                      lastError: {
                        code: 'CONFLICT',
                        message: 'Entity was deleted remotely while modified locally',
                        at: Date.now(),
                      },
                      updatedAt: Date.now(),
                    });
                  }
                }
                committedNotifications.push({
                  entityType,
                  entityId: localRow.id,
                  operation: 'delete',
                  localRevision: latestActive.localRevision,
                });
              }
              continue;
            }

            // Clean local row absent from server: soft-delete if previously synced
            if (syncMeta) {
              const rev = await deleteLocalRow(localRow.id);
              await this.syncMetadataRepo.upsertInTx({
                entityType,
                entityId: localRow.id,
                userId,
                syncState: 'deleted_synced',
                serverVersion: null,
                serverUpdatedAt: new Date().toISOString(),
              });
              committedNotifications.push({
                entityType,
                entityId: localRow.id,
                operation: 'delete',
                localRevision: rev ?? localRow.localRevision,
              });
            }
          }
        };

        const [localProjects, localFolders, localDocs, localDesigns] = await Promise.all([
          this.db.projects.where('userId').equals(userId).toArray(),
          this.db.workspace_folders.where('userId').equals(userId).toArray(),
          this.db.documents.where('userId').equals(userId).toArray(),
          this.db.system_designs.where('userId').equals(userId).toArray(),
        ]);

        await applyEntityGroup(
          'project',
          projectsResult.rows,
          localProjects,
          async (r, ver) => {
            const p = await this.projectRepo.applyRemoteSnapshot({
              id: String(r.id),
              userId,
              name: r.name || 'Untitled Project',
              serverVersion: ver,
              createdAt: r.created_at,
              updatedAt: r.updated_at,
            });
            return p.localRevision;
          },
          (id) => this.projectRepo.delete(id, { skipOutbox: true }),
        );

        await applyEntityGroup(
          'workspace_folder',
          foldersResult.rows,
          localFolders,
          async (r, ver) => {
            const f = await this.folderRepo.applyRemoteSnapshot({
              id: String(r.id),
              userId,
              projectId: r.project_id,
              name: r.name || 'Untitled Folder',
              parentFolderId: r.parent_folder_id ?? null,
              serverVersion: ver,
              createdAt: r.created_at,
              updatedAt: r.updated_at,
            });
            return f.localRevision;
          },
          (id) => this.folderRepo.delete(id, { skipOutbox: true }),
        );

        await applyEntityGroup(
          'document',
          documentsResult.rows,
          localDocs,
          async (r, ver) => {
            const d = await this.documentRepo.applyRemoteSnapshot({
              id: String(r.id),
              userId,
              projectId: r.project_id ?? null,
              folderId: r.folder_id ?? null,
              title: r.title ?? 'Untitled Document',
              content: r.content ?? '',
              format: r.format || 'markdown',
              serverVersion: ver,
              createdAt: r.created_at,
              updatedAt: r.updated_at,
            });
            return d.localRevision;
          },
          (id) => this.documentRepo.delete(id, { skipOutbox: true }),
        );

        await applyEntityGroup(
          'system_design',
          designsResult.rows,
          localDesigns,
          async (r, ver) => {
            const sd = await this.systemDesignRepo.applyRemoteSnapshot({
              id: String(r.id),
              userId,
              projectId: r.project_id,
              folderId: r.folder_id ?? null,
              name: r.name || 'New System Design',
              boardState: r.board_state,
              serverVersion: ver,
              createdAt: r.created_at,
              updatedAt: r.updated_at,
            });
            return sd.localRevision;
          },
          (id) => this.systemDesignRepo.delete(id, { skipOutbox: true }),
        );

        await this.db.database_meta.put({
          key: 'server_cursor',
          value: targetCursor,
          updatedAt: Date.now(),
        });
        await this.db.database_meta.put({
          key: 'hydration_complete',
          value: true,
          updatedAt: Date.now(),
        });
      },
    );

    if (committedNotifications.length > 0) {
      const coordinator = this.tabCoordinator || getTabCoordinator(userId);
      for (const ev of committedNotifications) {
        coordinator.notifyRemoteChange(ev);
      }
    }

    this.onHydrationChange?.(true);

    // Drain any delta sync_changes committed above targetCursor while snapshot SELECTs ran
    const tail = await this.pullAll(userId);
    return { supported: true, finalCursor: tail.finalCursor };
  }

  /**
   * Hydrates a brand-new browser profile across all 4 live tables (including pre-feed rows),
   * sets `server_cursor`, drains concurrent delta events, and records `hydration_complete = true`.
   */
  async bootstrapHydrateAll(
    userId: string,
    bounds?: SyncFeedBounds | null,
  ): Promise<{ supported: boolean; finalCursor: number }> {
    return await this.reconcileWorkspaceSnapshot(userId, bounds);
  }

  /**
   * Re-snapshots live tables when a returning device's `localCursor` has fallen below the
   * pruned `min_retained_sequence` retention floor, reconciling remote deletes & updates safely.
   */
  async resnapshotAll(
    userId: string,
    bounds?: SyncFeedBounds | null,
  ): Promise<{ supported: boolean; finalCursor: number }> {
    return await this.reconcileWorkspaceSnapshot(userId, bounds);
  }

  /**
   * High-level pull orchestrator:
   *  - Runs `bootstrapHydrateAll` if `hydration_complete` is not yet set;
   *  - Runs `resnapshotAll` if `localCursor < min_retained_sequence`;
   *  - Otherwise runs incremental `pullAll`.
   */
  async syncPull(userId: string): Promise<{ totalPulled: number; finalCursor: number }> {
    const [hydrated, currentCursor] = await Promise.all([
      this.isHydrated(),
      this.getCursor(),
    ]);

    if (!this.probeLiveTableBuilder('projects', userId)) {
      return await this.pullAll(userId);
    }

    const bounds = await this.getFeedBounds(userId);

    if (!hydrated) {
      const res = await this.bootstrapHydrateAll(userId, bounds);
      if (res.supported) {
        return { totalPulled: 0, finalCursor: res.finalCursor };
      }
      return await this.pullAll(userId);
    }

    if (bounds && currentCursor < bounds.minRetainedSequence) {
      const res = await this.resnapshotAll(userId, bounds);
      if (res.supported) {
        return { totalPulled: 0, finalCursor: res.finalCursor };
      }
    }

    return await this.pullAll(userId);
  }
}
