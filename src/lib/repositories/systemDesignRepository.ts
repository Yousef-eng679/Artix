import { ArtixDB, getArtixDB } from '../local/db';
import { LocalSystemDesign } from '../local/types';
import { EntityNotFoundError } from '../local/errors';
import { BoardState } from '@/hooks/useSystemDesigns';
import { OutboxRepository } from './outboxRepository';

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
  constructor(
    private db: ArtixDB = getArtixDB(),
    private outboxRepo?: OutboxRepository
  ) {}

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

  async create(dto: CreateSystemDesignDTO, options?: { skipOutbox?: boolean }): Promise<LocalSystemDesign> {
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

    if (this.outboxRepo && !options?.skipOutbox) {
      await this.outboxRepo.enqueue({
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

    return design;
  }

  async update(id: string, updates: UpdateSystemDesignDTO, options?: { skipOutbox?: boolean }): Promise<LocalSystemDesign> {
    const updated = await this.db.transaction('rw', this.db.system_designs, async () => {
      const existing = await this.db.system_designs.get(id);
      if (!existing || existing.isDeleted) {
        throw new EntityNotFoundError('SystemDesign', id);
      }

      const doc: LocalSystemDesign = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
        localRevision: existing.localRevision + 1,
      };

      await this.db.system_designs.put(doc);
      return doc;
    });

    if (this.outboxRepo && !options?.skipOutbox) {
      await this.outboxRepo.enqueue({
        userId: updated.userId,
        projectId: updated.projectId,
        entityType: 'system_design',
        entityId: updated.id,
        operation: 'update',
        payload: updates,
        localRevision: updated.localRevision,
      });
    }

    return updated;
  }

  async delete(id: string, options?: { skipOutbox?: boolean }): Promise<void> {
    let deletedDesign: LocalSystemDesign | null = null;

    await this.db.transaction('rw', this.db.system_designs, async () => {
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
      deletedDesign = softDeleted;
    });

    if (this.outboxRepo && deletedDesign && !options?.skipOutbox) {
      await this.outboxRepo.enqueue({
        userId: (deletedDesign as LocalSystemDesign).userId,
        projectId: (deletedDesign as LocalSystemDesign).projectId,
        entityType: 'system_design',
        entityId: (deletedDesign as LocalSystemDesign).id,
        operation: 'delete',
        payload: null,
        localRevision: (deletedDesign as LocalSystemDesign).localRevision,
      });
    }
  }

  async hardDelete(id: string): Promise<void> {
    await this.db.system_designs.delete(id);
  }

  async restore(id: string): Promise<LocalSystemDesign> {
    return await this.db.transaction('rw', this.db.system_designs, async () => {
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
      return restored;
    });
  }
}
