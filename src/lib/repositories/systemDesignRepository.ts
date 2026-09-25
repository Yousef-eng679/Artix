import { ArtixDB, getArtixDB } from '../local/db';
import { LocalSystemDesign } from '../local/types';
import { EntityNotFoundError } from '../local/errors';
import { BoardState } from '@/hooks/useSystemDesigns';

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
  constructor(private db: ArtixDB = getArtixDB()) {}

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

  async create(dto: CreateSystemDesignDTO): Promise<LocalSystemDesign> {
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
    return design;
  }

  async update(id: string, updates: UpdateSystemDesignDTO): Promise<LocalSystemDesign> {
    return await this.db.transaction('rw', this.db.system_designs, async () => {
      const existing = await this.db.system_designs.get(id);
      if (!existing || existing.isDeleted) {
        throw new EntityNotFoundError('SystemDesign', id);
      }

      const updated: LocalSystemDesign = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
        localRevision: existing.localRevision + 1,
      };

      await this.db.system_designs.put(updated);
      return updated;
    });
  }

  async delete(id: string): Promise<void> {
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
    });
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
