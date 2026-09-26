import { ArtixDB, getArtixDB } from '../local/db';
import { ConflictRecord, EntityType } from '../local/types';

export interface RecordConflictParams {
  entityType: EntityType;
  entityId: string;
  userId: string;
  basePayload: unknown;
  localPayload: unknown;
  remotePayload: unknown;
}

export class ConflictRepository {
  private db: ArtixDB;

  constructor(db?: ArtixDB) {
    this.db = db || getArtixDB();
  }

  /**
   * Persists a 3-way conflict record without destroying either local or remote data.
   */
  async recordConflict(params: RecordConflictParams): Promise<ConflictRecord> {
    const record: ConflictRecord = {
      id: crypto.randomUUID(),
      entityType: params.entityType,
      entityId: params.entityId,
      userId: params.userId,
      basePayload: params.basePayload,
      localPayload: params.localPayload,
      remotePayload: params.remotePayload,
      detectedAt: Date.now(),
      resolvedAt: null,
    };

    await this.db.conflicts.add(record);
    return record;
  }

  /**
   * Retrieves a conflict by ID.
   */
  async getById(id: string): Promise<ConflictRecord | undefined> {
    return await this.db.conflicts.get(id);
  }

  /**
   * Lists all conflicts for a specific entity.
   */
  async listByEntity(
    entityType: EntityType,
    entityId: string,
    userId?: string
  ): Promise<ConflictRecord[]> {
    let records = await this.db.conflicts
      .where('detectedAt')
      .above(0)
      .toArray();

    return records.filter(
      (c) =>
        c.entityType === entityType &&
        c.entityId === entityId &&
        (!userId || c.userId === userId)
    );
  }

  /**
   * Lists all currently unresolved conflicts.
   */
  async listUnresolved(userId?: string): Promise<ConflictRecord[]> {
    const all = await this.db.conflicts.toArray();
    return all.filter((c) => c.resolvedAt === null && (!userId || c.userId === userId));
  }

  /**
   * Marks a conflict as resolved.
   */
  async resolve(id: string): Promise<void> {
    await this.db.conflicts.update(id, {
      resolvedAt: Date.now(),
    });
  }

  /**
   * Deletes a conflict record.
   */
  async delete(id: string): Promise<void> {
    await this.db.conflicts.delete(id);
  }
}
