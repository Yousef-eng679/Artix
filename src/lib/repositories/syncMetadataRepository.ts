import { ArtixDB, getArtixDB } from '../local/db';
import { EntityType, SyncMetadata, SyncState } from '../local/types';

export class SyncMetadataRepository {
  private db: ArtixDB;

  constructor(db?: ArtixDB) {
    this.db = db || getArtixDB();
  }

  private makeId(entityType: EntityType, entityId: string): string {
    return `${entityType}:${entityId}`;
  }

  /**
   * Retrieves synchronization metadata for a specific entity.
   */
  async get(entityType: EntityType, entityId: string): Promise<SyncMetadata | undefined> {
    const id = this.makeId(entityType, entityId);
    return await this.db.sync_metadata.get(id);
  }

  /**
   * Upserts sync metadata for an entity.
   */
  async upsert(params: {
    entityType: EntityType;
    entityId: string;
    userId: string;
    syncState?: SyncState;
    serverVersion?: string | null;
    serverUpdatedAt?: string | null;
    localRevision?: number;
    lastSyncedAt?: number | null;
  }): Promise<SyncMetadata> {
    const id = this.makeId(params.entityType, params.entityId);

    return await this.db.transaction('rw', this.db.sync_metadata, async () => {
      const existing = await this.db.sync_metadata.get(id);

      const metadata: SyncMetadata = {
        id,
        entityType: params.entityType,
        entityId: params.entityId,
        userId: params.userId,
        syncState: params.syncState ?? existing?.syncState ?? 'pending',
        serverVersion: params.serverVersion !== undefined ? params.serverVersion : (existing?.serverVersion ?? null),
        serverUpdatedAt: params.serverUpdatedAt !== undefined ? params.serverUpdatedAt : (existing?.serverUpdatedAt ?? null),
        localRevision: params.localRevision ?? existing?.localRevision ?? 1,
        lastSyncedAt: params.lastSyncedAt !== undefined ? params.lastSyncedAt : (existing?.lastSyncedAt ?? null),
      };

      await this.db.sync_metadata.put(metadata);
      return metadata;
    });
  }

  /**
   * Marks an entity as successfully synced with the cloud.
   */
  async markSynced(
    entityType: EntityType,
    entityId: string,
    userId: string,
    serverVersion?: string | null,
    serverUpdatedAt?: string | null,
    localRevision?: number
  ): Promise<SyncMetadata> {
    return await this.upsert({
      entityType,
      entityId,
      userId,
      syncState: 'synced',
      serverVersion,
      serverUpdatedAt,
      localRevision,
      lastSyncedAt: Date.now(),
    });
  }

  /**
   * Marks an entity as pending synchronization.
   */
  async markPending(
    entityType: EntityType,
    entityId: string,
    userId: string,
    localRevision: number
  ): Promise<SyncMetadata> {
    return await this.upsert({
      entityType,
      entityId,
      userId,
      syncState: 'pending',
      localRevision,
    });
  }

  /**
   * Marks an entity as currently in-flight syncing.
   */
  async markSyncing(
    entityType: EntityType,
    entityId: string,
    userId: string
  ): Promise<SyncMetadata> {
    return await this.upsert({
      entityType,
      entityId,
      userId,
      syncState: 'syncing',
    });
  }

  /**
   * Marks an entity with an error state.
   */
  async markError(
    entityType: EntityType,
    entityId: string,
    userId: string
  ): Promise<SyncMetadata> {
    return await this.upsert({
      entityType,
      entityId,
      userId,
      syncState: 'error',
    });
  }

  /**
   * Marks an entity as having a synchronization conflict.
   */
  async markConflict(
    entityType: EntityType,
    entityId: string,
    userId: string
  ): Promise<SyncMetadata> {
    return await this.upsert({
      entityType,
      entityId,
      userId,
      syncState: 'conflict',
    });
  }

  /**
   * Lists metadata entries matching a given state.
   */
  async listByState(syncState: SyncState, userId?: string): Promise<SyncMetadata[]> {
    const list = await this.db.sync_metadata.where('syncState').equals(syncState).toArray();
    return userId ? list.filter((m) => m.userId === userId) : list;
  }

  /**
   * Deletes sync metadata for an entity.
   */
  async delete(entityType: EntityType, entityId: string): Promise<void> {
    const id = this.makeId(entityType, entityId);
    await this.db.sync_metadata.delete(id);
  }
}
