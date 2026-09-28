import { ArtixDB, getArtixDB } from '../local/db';
import { LocalSystemDesign, RemoteSystemDesignSnapshot } from '../local/types';
import { EntityNotFoundError } from '../local/errors';
import { BoardState } from '@/hooks/useSystemDesigns';
import { OutboxRepository } from './outboxRepository';
import { SyncMetadataRepository } from './syncMetadataRepository';

export interface CreateSystemDesignDTO {
  id?: string;
  userId: string;
  projectId: string;
  folderId?: string | null;
  name?: string;
  boardState?: BoardState;
}

export interface UpdateSystemDesignDTO {
  name?: string;
  boardState?: BoardState;
  folderId?: string | null;
  projectId?: string;
}

const defaultBoardState: BoardState = {
  nodes: [],
  edges: [],
};

export class SystemDesignRepository {
  private syncMetadataRepo: SyncMetadataRepository;

  constructor(
    private db: ArtixDB = getArtixDB(),
    private outboxRepo?: OutboxRepository,
    syncMetadataRepo?: SyncMetadataRepository
  ) {
    this.syncMetadataRepo = syncMetadataRepo || new SyncMetadataRepository(this.db);
    if (!this.outboxRepo) {
      this.outboxRepo = new OutboxRepository(this.db);
    }
  }

  async getById(id: string): Promise<LocalSystemDesign | null> {
    const design = await this.db.system_designs.get(id);
    if (!design || design.isDeleted) return null;
    return design;
  }

  async getByIdIncludeDeleted(id: string): Promise<LocalSystemDesign | null> {
    const design = await this.db.system_designs.get(id);
    return design ?? null;
  }

  async listByProject(userId: string, projectId: string): Promise<LocalSystemDesign[]> {
    const designs = await this.db.system_designs
      .where('userId')
      .equals(userId)
      .filter((design) => design.projectId === projectId && !design.isDeleted)
      .toArray();

    return designs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  async listAllByUser(userId: string): Promise<LocalSystemDesign[]> {
    const designs = await this.db.system_designs
      .where('userId')
      .equals(userId)
      .filter((design) => !design.isDeleted)
      .toArray();

    return designs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  /**
   * Applies an authoritative remote snapshot from Supabase into local IndexedDB.
   * Updates entity store and sync metadata (marking synced) with ZERO outbox entries.
   */
  async applyRemoteSnapshot(snapshot: RemoteSystemDesignSnapshot, options?: { force?: boolean }): Promise<LocalSystemDesign> {
    return await this.db.transaction('rw', [this.db.system_designs, this.db.outbox, this.db.sync_metadata], async () => {
      const now = new Date().toISOString();
      const existing = await this.db.system_designs.get(snapshot.id);

      // Defense-in-depth: do not overwrite active local pending intent unless forced
      if (!options?.force) {
        const outboxEntries = await this.db.outbox
          .where('[userId+entityType+entityId]')
          .equals([snapshot.userId, 'system_design', snapshot.id])
          .toArray();

        const activeOutbox = outboxEntries.find(
          (e) => e.state === 'pending' || e.state === 'in_flight' || e.state === 'blocked'
        );

        if (activeOutbox && existing) {
          return existing;
        }
      }

      const design: LocalSystemDesign = {
        id: snapshot.id,
        userId: snapshot.userId,
        projectId: snapshot.projectId,
        folderId: snapshot.folderId !== undefined ? snapshot.folderId : (existing?.folderId ?? null),
        name: snapshot.name ?? existing?.name ?? 'New System Design',
        boardState: snapshot.boardState || existing?.boardState || defaultBoardState,
        createdAt: snapshot.createdAt || existing?.createdAt || now,
        updatedAt: snapshot.updatedAt || now,
        localRevision: existing ? existing.localRevision : 1,
        isDeleted: false,
        deletedAt: null,
      };

      await this.db.system_designs.put(design);

      await this.syncMetadataRepo.upsertInTx({
        entityType: 'system_design',
        entityId: design.id,
        userId: design.userId,
        syncState: 'synced',
        serverVersion: snapshot.serverVersion ? String(snapshot.serverVersion) : null,
        serverUpdatedAt: snapshot.updatedAt ?? null,
        localRevision: design.localRevision,
        lastSyncedAt: Date.now(),
        baseSnapshot: snapshot,
      });

      return design;
    });
  }

  async create(dto: CreateSystemDesignDTO, options?: { skipOutbox?: boolean }): Promise<LocalSystemDesign> {
    if (options?.skipOutbox) {
      return this.applyRemoteSnapshot({
        id: dto.id || crypto.randomUUID(),
        userId: dto.userId,
        projectId: dto.projectId,
        folderId: dto.folderId,
        name: dto.name || 'New System Design',
        boardState: dto.boardState || defaultBoardState,
      });
    }

    return await this.db.transaction('rw', [this.db.system_designs, this.db.outbox, this.db.sync_metadata], async () => {
      const now = new Date().toISOString();
      const design: LocalSystemDesign = {
        id: dto.id || crypto.randomUUID(),
        userId: dto.userId,
        projectId: dto.projectId,
        folderId: dto.folderId ?? null,
        name: dto.name || 'New System Design',
        boardState: dto.boardState || defaultBoardState,
        createdAt: now,
        updatedAt: now,
        localRevision: 1,
        isDeleted: false,
      };

      await this.db.system_designs.add(design);

      if (this.outboxRepo) {
        await this.outboxRepo.enqueueInTx({
          userId: design.userId,
          projectId: design.projectId,
          entityType: 'system_design',
          entityId: design.id,
          operation: 'create',
          payload: {
            name: design.name,
            boardState: design.boardState,
            folderId: design.folderId,
          },
          localRevision: design.localRevision,
        });
      }

      await this.syncMetadataRepo.upsertInTx({
        entityType: 'system_design',
        entityId: design.id,
        userId: design.userId,
        syncState: 'pending',
        localRevision: design.localRevision,
      });

      return design;
    });
  }

  async update(id: string, updates: UpdateSystemDesignDTO, options?: { skipOutbox?: boolean }): Promise<LocalSystemDesign> {
    if (options?.skipOutbox) {
      const existing = await this.getByIdIncludeDeleted(id);
      if (!existing) throw new EntityNotFoundError('SystemDesign', id);
      return this.applyRemoteSnapshot({
        id,
        userId: existing.userId,
        projectId: updates.projectId !== undefined ? updates.projectId : existing.projectId,
        folderId: updates.folderId !== undefined ? updates.folderId : existing.folderId,
        name: updates.name !== undefined ? updates.name : existing.name,
        boardState: updates.boardState !== undefined ? updates.boardState : existing.boardState,
      });
    }

    return await this.db.transaction('rw', [this.db.system_designs, this.db.outbox, this.db.sync_metadata], async () => {
      const existing = await this.db.system_designs.get(id);
      if (!existing || existing.isDeleted) {
        throw new EntityNotFoundError('SystemDesign', id);
      }

      // Filter out undefined fields to prevent accidental overwrites of existing metadata
      const cleanUpdates: Partial<LocalSystemDesign> = {};
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) {
          (cleanUpdates as any)[key] = value;
        }
      }

      const doc: LocalSystemDesign = {
        ...existing,
        ...cleanUpdates,
        updatedAt: new Date().toISOString(),
        localRevision: existing.localRevision + 1,
      };

      await this.db.system_designs.put(doc);

      let baseServerVersion: string | null = null;
      const existingMeta = await this.db.sync_metadata.get(`system_design:${id}`);
      if (existingMeta?.serverVersion) {
        baseServerVersion = existingMeta.serverVersion;
      }

      if (this.outboxRepo) {
        await this.outboxRepo.enqueueInTx({
          userId: doc.userId,
          projectId: doc.projectId,
          entityType: 'system_design',
          entityId: doc.id,
          operation: 'update',
          payload: updates,
          localRevision: doc.localRevision,
          baseServerVersion,
        });
      }

      await this.syncMetadataRepo.upsertInTx({
        entityType: 'system_design',
        entityId: doc.id,
        userId: doc.userId,
        syncState: 'pending',
        localRevision: doc.localRevision,
      });

      return doc;
    });
  }

  async delete(id: string, options?: { skipOutbox?: boolean }): Promise<void> {
    await this.db.transaction('rw', [this.db.system_designs, this.db.outbox, this.db.sync_metadata], async () => {
      const existing = await this.db.system_designs.get(id);
      if (!existing) return;

      const softDeleted: LocalSystemDesign = {
        ...existing,
        isDeleted: true,
        deletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        localRevision: existing.localRevision + 1,
      };

      await this.db.system_designs.put(softDeleted);

      let baseServerVersion: string | null = null;
      const existingMeta = await this.db.sync_metadata.get(`system_design:${id}`);
      if (existingMeta?.serverVersion) {
        baseServerVersion = existingMeta.serverVersion;
      }

      if (this.outboxRepo && !options?.skipOutbox) {
        await this.outboxRepo.enqueueInTx({
          userId: softDeleted.userId,
          projectId: softDeleted.projectId,
          entityType: 'system_design',
          entityId: softDeleted.id,
          operation: 'delete',
          payload: null,
          localRevision: softDeleted.localRevision,
          baseServerVersion,
        });
      }

      await this.syncMetadataRepo.upsertInTx({
        entityType: 'system_design',
        entityId: softDeleted.id,
        userId: softDeleted.userId,
        syncState: options?.skipOutbox ? 'synced' : 'pending',
        localRevision: softDeleted.localRevision,
      });
    });
  }

  async hardDelete(id: string): Promise<void> {
    await this.db.system_designs.delete(id);
  }

  async restore(id: string): Promise<LocalSystemDesign> {
    return await this.db.transaction('rw', [this.db.system_designs, this.db.outbox, this.db.sync_metadata], async () => {
      const existing = await this.db.system_designs.get(id);
      if (!existing) {
        throw new EntityNotFoundError('SystemDesign', id);
      }

      const restored: LocalSystemDesign = {
        ...existing,
        isDeleted: false,
        deletedAt: null,
        updatedAt: new Date().toISOString(),
        localRevision: existing.localRevision + 1,
      };

      await this.db.system_designs.put(restored);

      if (this.outboxRepo) {
        await this.outboxRepo.enqueueInTx({
          userId: restored.userId,
          projectId: restored.projectId,
          entityType: 'system_design',
          entityId: restored.id,
          operation: 'update',
          payload: {
            name: restored.name,
            boardState: restored.boardState,
            folderId: restored.folderId,
          },
          localRevision: restored.localRevision,
        });
      }

      await this.syncMetadataRepo.upsertInTx({
        entityType: 'system_design',
        entityId: restored.id,
        userId: restored.userId,
        syncState: 'pending',
        localRevision: restored.localRevision,
      });

      return restored;
    });
  }
}
