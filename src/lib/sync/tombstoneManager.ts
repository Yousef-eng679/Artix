import { ArtixDB } from '../local/db';
import { EntityType } from '../local/types';

export type TombstoneLifecycleState =
  | 'LOCAL_PENDING_DELETE'
  | 'REMOTE_CONFIRMED_DELETE'
  | 'REMOTE_DELETE_CONFLICT'
  | 'PURGED_TOMBSTONE'
  | 'ACTIVE';

export interface PurgeResult {
  purgedDocuments: number;
  purgedDesigns: number;
  purgedFolders: number;
  totalPurged: number;
}

export class TombstoneManager {
  private db: ArtixDB;

  constructor(db: ArtixDB) {
    this.db = db;
  }

  /**
   * Evaluates the explicit synchronization tombstone state of an entity.
   */
  async getTombstoneState(
    entityType: EntityType,
    entityId: string,
    userId: string
  ): Promise<TombstoneLifecycleState> {
    let entity: { isDeleted?: boolean } | null = null;

    if (entityType === 'document') {
      entity = (await this.db.documents.get(entityId)) ?? null;
    } else if (entityType === 'system_design') {
      entity = (await this.db.system_designs.get(entityId)) ?? null;
    } else if (entityType === 'workspace_folder') {
      entity = (await this.db.workspace_folders.get(entityId)) ?? null;
    }

    const syncMeta = await this.db.sync_metadata.get(`${entityType}:${entityId}`);

    if (!entity && !syncMeta) {
      return 'PURGED_TOMBSTONE';
    }

    if (syncMeta?.syncState === 'conflict') {
      return 'REMOTE_DELETE_CONFLICT';
    }

    if (!entity?.isDeleted) {
      return 'ACTIVE';
    }

    // Entity is soft-deleted locally. Check outbox for pending deletion.
    const outboxEntries = await this.db.outbox
      .where('[userId+entityType+entityId]')
      .equals([userId, entityType, entityId])
      .toArray();

    const activeOutbox = outboxEntries.find(
      (e) => e.state === 'pending' || e.state === 'in_flight' || e.state === 'blocked'
    );

    if (activeOutbox) {
      if (activeOutbox.state === 'blocked') {
        return 'REMOTE_DELETE_CONFLICT';
      }
      return 'LOCAL_PENDING_DELETE';
    }

    return 'REMOTE_CONFIRMED_DELETE';
  }

  /**
   * Safely purges tombstone rows that have been confirmed deleted on the server,
   * have zero active outbox entries, and exceed the retention window.
   */
  async purgeTombstones(userId: string, retentionMs: number = 30 * 24 * 60 * 60 * 1000): Promise<PurgeResult> {
    const cutoff = Date.now() - retentionMs;
    let purgedDocs = 0;
    let purgedDesigns = 0;
    let purgedFolders = 0;

    await this.db.transaction(
      'rw',
      [
        this.db.documents,
        this.db.system_designs,
        this.db.workspace_folders,
        this.db.outbox,
        this.db.sync_metadata,
      ],
      async () => {
        // 1. Documents
        const deletedDocs = await this.db.documents
          .where('userId')
          .equals(userId)
          .filter((d) => d.isDeleted === true)
          .toArray();

        for (const doc of deletedDocs) {
          const deletedAtTime = doc.deletedAt ? new Date(doc.deletedAt).getTime() : 0;
          if (deletedAtTime > cutoff && retentionMs > 0) continue;

          const outboxEntries = await this.db.outbox
            .where('[userId+entityType+entityId]')
            .equals([userId, 'document', doc.id])
            .toArray();
          const hasActiveOutbox = outboxEntries.some(
            (e) => e.state === 'pending' || e.state === 'in_flight' || e.state === 'blocked'
          );
          if (hasActiveOutbox) continue;

          const meta = await this.db.sync_metadata.get(`document:${doc.id}`);
          if (meta?.syncState === 'conflict') continue;

          await this.db.documents.delete(doc.id);
          await this.db.sync_metadata.delete(`document:${doc.id}`);
          purgedDocs++;
        }

        // 2. System Designs
        const deletedDesigns = await this.db.system_designs
          .where('userId')
          .equals(userId)
          .filter((d) => d.isDeleted === true)
          .toArray();

        for (const design of deletedDesigns) {
          const deletedAtTime = design.deletedAt ? new Date(design.deletedAt).getTime() : 0;
          if (deletedAtTime > cutoff && retentionMs > 0) continue;

          const outboxEntries = await this.db.outbox
            .where('[userId+entityType+entityId]')
            .equals([userId, 'system_design', design.id])
            .toArray();
          const hasActiveOutbox = outboxEntries.some(
            (e) => e.state === 'pending' || e.state === 'in_flight' || e.state === 'blocked'
          );
          if (hasActiveOutbox) continue;

          const meta = await this.db.sync_metadata.get(`system_design:${design.id}`);
          if (meta?.syncState === 'conflict') continue;

          await this.db.system_designs.delete(design.id);
          await this.db.sync_metadata.delete(`system_design:${design.id}`);
          purgedDesigns++;
        }

        // 3. Workspace Folders
        const deletedFolders = await this.db.workspace_folders
          .where('userId')
          .equals(userId)
          .filter((f) => f.isDeleted === true)
          .toArray();

        for (const folder of deletedFolders) {
          const deletedAtTime = folder.deletedAt ? new Date(folder.deletedAt).getTime() : 0;
          if (deletedAtTime > cutoff && retentionMs > 0) continue;

          const outboxEntries = await this.db.outbox
            .where('[userId+entityType+entityId]')
            .equals([userId, 'workspace_folder', folder.id])
            .toArray();
          const hasActiveOutbox = outboxEntries.some(
            (e) => e.state === 'pending' || e.state === 'in_flight' || e.state === 'blocked'
          );
          if (hasActiveOutbox) continue;

          const meta = await this.db.sync_metadata.get(`workspace_folder:${folder.id}`);
          if (meta?.syncState === 'conflict') continue;

          await this.db.workspace_folders.delete(folder.id);
          await this.db.sync_metadata.delete(`workspace_folder:${folder.id}`);
          purgedFolders++;
        }
      }
    );

    return {
      purgedDocuments: purgedDocs,
      purgedDesigns: purgedDesigns,
      purgedFolders: purgedFolders,
      totalPurged: purgedDocs + purgedDesigns + purgedFolders,
    };
  }
}
