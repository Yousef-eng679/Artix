import { ArtixDB, getArtixDB } from '../local/db';
import { LocalDocument } from '../local/types';
import { EntityNotFoundError } from '../local/errors';
import { DocumentFormat } from '@/components/Editor/languageMap';

export interface CreateDocumentDTO {
  id?: string;
  userId: string;
  projectId?: string | null;
  folderId?: string | null;
  title?: string;
  content?: string;
  format?: DocumentFormat;
}

export interface UpdateDocumentDTO {
  title?: string;
  content?: string;
  format?: DocumentFormat;
  folderId?: string | null;
  projectId?: string | null;
}

export class DocumentRepository {
  constructor(private db: ArtixDB = getArtixDB()) {}

  async getById(id: string): Promise<LocalDocument | null> {
    const doc = await this.db.documents.get(id);
    if (!doc || doc.isDeleted) return null;
    return doc;
  }

  async getByIdIncludeDeleted(id: string): Promise<LocalDocument | null> {
    const doc = await this.db.documents.get(id);
    return doc ?? null;
  }

  async listByProject(userId: string, projectId: string | null): Promise<LocalDocument[]> {
    const docs = await this.db.documents
      .where('userId')
      .equals(userId)
      .filter((doc) => {
        const matchesProject = projectId ? doc.projectId === projectId : doc.projectId === null;
        return matchesProject && !doc.isDeleted;
      })
      .toArray();

    return docs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  async listAllByUser(userId: string): Promise<LocalDocument[]> {
    const docs = await this.db.documents
      .where('userId')
      .equals(userId)
      .filter((doc) => !doc.isDeleted)
      .toArray();

    return docs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  async create(dto: CreateDocumentDTO): Promise<LocalDocument> {
    const now = new Date().toISOString();
    const doc: LocalDocument = {
      id: dto.id || crypto.randomUUID(),
      userId: dto.userId,
      projectId: dto.projectId ?? null,
      folderId: dto.folderId ?? null,
      title: dto.title || 'Untitled Document',
      content: dto.content || '',
      format: dto.format || 'markdown',
      createdAt: now,
      updatedAt: now,
      localRevision: 1,
      isDeleted: false,
    };

    await this.db.documents.add(doc);
    return doc;
  }

  async update(id: string, updates: UpdateDocumentDTO): Promise<LocalDocument> {
    return await this.db.transaction('rw', this.db.documents, async () => {
      const existing = await this.db.documents.get(id);
      if (!existing || existing.isDeleted) {
        throw new EntityNotFoundError('Document', id);
      }

      const updated: LocalDocument = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
        localRevision: existing.localRevision + 1,
      };

      await this.db.documents.put(updated);
      return updated;
    });
  }

  async delete(id: string): Promise<void> {
    await this.db.transaction('rw', this.db.documents, async () => {
      const existing = await this.db.documents.get(id);
      if (!existing) return;

      const softDeleted: LocalDocument = {
        ...existing,
        isDeleted: true,
        deletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        localRevision: existing.localRevision + 1,
      };

      await this.db.documents.put(softDeleted);
    });
  }

  async hardDelete(id: string): Promise<void> {
    await this.db.documents.delete(id);
  }

  async restore(id: string): Promise<LocalDocument> {
    return await this.db.transaction('rw', this.db.documents, async () => {
      const existing = await this.db.documents.get(id);
      if (!existing) {
        throw new EntityNotFoundError('Document', id);
      }

      const restored: LocalDocument = {
        ...existing,
        isDeleted: false,
        deletedAt: null,
        updatedAt: new Date().toISOString(),
        localRevision: existing.localRevision + 1,
      };

      await this.db.documents.put(restored);
      return restored;
    });
  }
}
