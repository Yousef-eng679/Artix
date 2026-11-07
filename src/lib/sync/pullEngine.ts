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
}
