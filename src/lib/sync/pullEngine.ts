import { supabase as defaultSupabaseClient } from '@/integrations/supabase/client';
import { ArtixDB, getArtixDB } from '../local/db';
import { DocumentRepository } from '../repositories/documentRepository';
import { WorkspaceFolderRepository } from '../repositories/folderRepository';
import { SystemDesignRepository } from '../repositories/systemDesignRepository';
import { ConflictRepository } from '../repositories/conflictRepository';
import { SyncMetadataRepository } from '../repositories/syncMetadataRepository';
import {
  RemoteDocumentSnapshot,
  RemoteWorkspaceFolderSnapshot,
  RemoteSystemDesignSnapshot,
  ConflictRecord,
} from '../local/types';
import { withTimeout } from './syncEngine';

export interface PullEngineOptions {
  supabaseClient?: any;
  db?: ArtixDB;
  documentRepo?: DocumentRepository;
  folderRepo?: WorkspaceFolderRepository;
  systemDesignRepo?: SystemDesignRepository;
  conflictRepo?: ConflictRepository;
  syncMetadataRepo?: SyncMetadataRepository;
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
  private documentRepo: DocumentRepository;
  private folderRepo: WorkspaceFolderRepository;
  private systemDesignRepo: SystemDesignRepository;
  private conflictRepo: ConflictRepository;
  private syncMetadataRepo: SyncMetadataRepository;
  private batchSize: number;

  constructor(options: PullEngineOptions = {}) {
    this.db = options.db || getArtixDB();
    this.supabase = options.supabaseClient || defaultSupabaseClient;
    this.documentRepo = options.documentRepo || new DocumentRepository(this.db);
    this.folderRepo = options.folderRepo || new WorkspaceFolderRepository(this.db);
    this.systemDesignRepo = options.systemDesignRepo || new SystemDesignRepository(this.db);
    this.conflictRepo = options.conflictRepo || new ConflictRepository(this.db);
    this.syncMetadataRepo = options.syncMetadataRepo || new SyncMetadataRepository(this.db);
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

  /**
   * Pulls a single batch of changes from Supabase sync_changes feed and applies them locally.
   * Runs atomically across local entity tables, outbox, metadata, and cursor.
   */
  async pullBatch(userId: string): Promise<PullResult> {
    const currentCursor = await this.getCursor();

    const changesTable = this.supabase?.from?.('sync_changes');
    if (!changesTable || typeof changesTable.select !== 'function') {
      return {
        pulledCount: 0,
        newCursor: currentCursor,
        hasMore: false,
      };
    }

    const selectQuery = changesTable.select(
      'sequence, user_id, entity_type, entity_id, operation, entity_version, payload, changed_at'
    );
    if (typeof selectQuery?.eq !== 'function') {
      return { pulledCount: 0, newCursor: currentCursor, hasMore: false };
    }

    const eqQuery = selectQuery.eq('user_id', userId);
    if (typeof eqQuery?.gt !== 'function') {
      return { pulledCount: 0, newCursor: currentCursor, hasMore: false };
    }

    const gtQuery = eqQuery.gt('sequence', currentCursor);
    if (typeof gtQuery?.order !== 'function') {
      return { pulledCount: 0, newCursor: currentCursor, hasMore: false };
    }

    const orderQuery = gtQuery.order('sequence', { ascending: true });
    if (typeof orderQuery?.limit !== 'function') {
      return { pulledCount: 0, newCursor: currentCursor, hasMore: false };
    }

    const { data, error } = await withTimeout(orderQuery.limit(this.batchSize));

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

    // Apply entire batch inside an atomic Dexie transaction
    await this.db.transaction(
      'rw',
      [
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
          const entityType = change.entity_type;
          const entityId = change.entity_id;
          const operation = change.operation;
          const version = change.entity_version;
          const payload = change.payload || {};

          // Check if local client has an active outbox entry for this entity
          const outboxEntries = await this.db.outbox
            .where('[userId+entityType+entityId]')
            .equals([userId, entityType, entityId])
            .toArray();

          const activeOutbox = outboxEntries.find(
            (e) => e.state === 'pending' || e.state === 'in_flight' || e.state === 'blocked'
          );

          if (activeOutbox) {
            const syncMetaId = `${entityType}:${entityId}`;
            const syncMeta = await this.db.sync_metadata.get(syncMetaId);

            const baselineVersion = activeOutbox.baseServerVersion
              ? parseInt(activeOutbox.baseServerVersion, 10)
              : (syncMeta?.serverVersion ? parseInt(syncMeta.serverVersion, 10) : 0);
            const remoteVersion = version !== undefined && version !== null ? parseInt(String(version), 10) : 0;

            const isNewerRemote = remoteVersion > baselineVersion || operation === 'delete';

            if (isNewerRemote) {
              // Concurrent modification detected: local draft must NOT be overwritten!
              const conflictRecord: ConflictRecord = {
                id: crypto.randomUUID(),
                entityType,
                entityId,
                userId,
                basePayload: syncMeta?.baseSnapshot ?? null,
                localPayload: activeOutbox.payload,
                remotePayload: operation === 'delete' ? { deleted: true } : payload,
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

              // Block outbox entry to prevent CAS churn
              await this.db.outbox.update(activeOutbox.id, {
                state: 'blocked',
                leaseOwner: null,
                leaseExpiresAt: null,
                updatedAt: Date.now(),
              });
            } else {
              // Stale remote observation (remoteVersion <= baselineVersion) -> ignore cleanly, preserve local intent
            }
          } else {
            // Clean application of remote change
            if (operation === 'delete') {
              if (entityType === 'document') {
                await this.documentRepo.delete(entityId, { skipOutbox: true });
              } else if (entityType === 'workspace_folder') {
                await this.folderRepo.delete(entityId, { skipOutbox: true });
              } else if (entityType === 'system_design') {
                await this.systemDesignRepo.delete(entityId, { skipOutbox: true });
              }
            } else {
              // 'create' or 'update'
              if (entityType === 'document') {
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
                await this.documentRepo.applyRemoteSnapshot(snapshot);
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
                await this.folderRepo.applyRemoteSnapshot(snapshot);
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
                await this.systemDesignRepo.applyRemoteSnapshot(snapshot);
              }
            }
          }

          if (change.sequence > maxAppliedSequence) {
            maxAppliedSequence = change.sequence;
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
