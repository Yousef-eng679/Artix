import { ArtixDB, getArtixDB } from '../local/db';
import { LocalDocument, RemoteDocumentSnapshot } from '../local/types';
import { EntityNotFoundError } from '../local/errors';
import { DocumentFormat } from '@/components/Editor/languageMap';
import { OutboxRepository } from './outboxRepository';
import { SyncMetadataRepository } from './syncMetadataRepository';

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
        const matchesProject = projectId
          ? doc.projectId === projectId
          : (doc.projectId === null || doc.projectId === undefined);
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

  /**
   * Applies an authoritative remote snapshot from Supabase into local IndexedDB.
   * Updates entity store and sync metadata (marking synced) with ZERO outbox entries.
   */
  async applyRemoteSnapshot(snapshot: RemoteDocumentSnapshot, options?: { force?: boolean }): Promise<LocalDocument> {
    return await this.db.transaction('rw', [this.db.documents, this.db.outbox, this.db.sync_metadata], async () => {
      const now = new Date().toISOString();
      const existing = await this.db.documents.get(snapshot.id);

      // Defense-in-depth: do not overwrite active local pending intent unless forced
      if (!options?.force) {
        const outboxEntries = await this.db.outbox
          .where('[userId+entityType+entityId]')
          .equals([snapshot.userId, 'document', snapshot.id])
          .toArray();

        const activeOutbox = outboxEntries.find(
          (e) => e.state === 'pending' || e.state === 'in_flight' || e.state === 'blocked'
        );

        if (activeOutbox && existing) {
          return existing;
        }
      }

      const doc: LocalDocument = {
        id: snapshot.id,
        userId: snapshot.userId,
        projectId: snapshot.projectId ?? existing?.projectId ?? null,
        folderId: snapshot.folderId !== undefined ? snapshot.folderId : (existing?.folderId ?? null),
        title: snapshot.title ?? existing?.title ?? 'Untitled Document',
        content: snapshot.content ?? existing?.content ?? '',
        format: snapshot.format || existing?.format || 'markdown',
        createdAt: snapshot.createdAt || existing?.createdAt || now,
        updatedAt: snapshot.updatedAt || now,
        localRevision: existing ? existing.localRevision : 1,
        isDeleted: false,
        deletedAt: null,
      };

      await this.db.documents.put(doc);

      await this.syncMetadataRepo.upsertInTx({
        entityType: 'document',
        entityId: doc.id,
        userId: doc.userId,
        syncState: 'synced',
        serverVersion: snapshot.serverVersion ? String(snapshot.serverVersion) : null,
        serverUpdatedAt: snapshot.updatedAt ?? null,
        localRevision: doc.localRevision,
        lastSyncedAt: Date.now(),
        baseSnapshot: snapshot,
      });

      return doc;
    });
  }

  async create(dto: CreateDocumentDTO, options?: { skipOutbox?: boolean }): Promise<LocalDocument> {
    if (options?.skipOutbox) {
      return this.applyRemoteSnapshot({
        id: dto.id || crypto.randomUUID(),
        userId: dto.userId,
        projectId: dto.projectId,
        folderId: dto.folderId,
        title: dto.title || 'Untitled Document',
        content: dto.content || '',
        format: dto.format || 'markdown',
      });
    }

    return await this.db.transaction('rw', [this.db.documents, this.db.outbox, this.db.sync_metadata], async () => {
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

      if (this.outboxRepo) {
        await this.outboxRepo.enqueueInTx({
          userId: doc.userId,
          projectId: doc.projectId,
          entityType: 'document',
          entityId: doc.id,
          operation: 'create',
          payload: {
            title: doc.title,
            content: doc.content,
            format: doc.format,
            folderId: doc.folderId,
          },
          localRevision: doc.localRevision,
        });
      }

      await this.syncMetadataRepo.upsertInTx({
        entityType: 'document',
        entityId: doc.id,
        userId: doc.userId,
        syncState: 'pending',
        localRevision: doc.localRevision,
      });

      return doc;
    });
  }

  async update(id: string, updates: UpdateDocumentDTO, options?: { skipOutbox?: boolean }): Promise<LocalDocument> {
    if (options?.skipOutbox) {
      const existing = await this.getByIdIncludeDeleted(id);
      if (!existing) throw new EntityNotFoundError('Document', id);
      return this.applyRemoteSnapshot({
        id,
        userId: existing.userId,
        projectId: updates.projectId !== undefined ? updates.projectId : existing.projectId,
        folderId: updates.folderId !== undefined ? updates.folderId : existing.folderId,
        title: updates.title !== undefined ? updates.title : existing.title,
        content: updates.content !== undefined ? updates.content : existing.content,
        format: updates.format !== undefined ? updates.format : existing.format,
      });
    }

    return await this.db.transaction('rw', [this.db.documents, this.db.outbox, this.db.sync_metadata], async () => {
      const existing = await this.db.documents.get(id);
      if (!existing || existing.isDeleted) {
        throw new EntityNotFoundError('Document', id);
      }

      // Filter out undefined fields to prevent accidental overwrites of existing metadata
      const cleanUpdates: Partial<LocalDocument> = {};
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) {
          (cleanUpdates as any)[key] = value;
        }
      }

      const doc: LocalDocument = {
        ...existing,
        ...cleanUpdates,
        updatedAt: new Date().toISOString(),
        localRevision: existing.localRevision + 1,
      };

      await this.db.documents.put(doc);

      let baseServerVersion: string | null = null;
      const existingMeta = await this.db.sync_metadata.get(`document:${id}`);
      if (existingMeta?.serverVersion) {
        baseServerVersion = existingMeta.serverVersion;
      }

      if (this.outboxRepo) {
        await this.outboxRepo.enqueueInTx({
          userId: doc.userId,
          projectId: doc.projectId,
          entityType: 'document',
          entityId: doc.id,
          operation: 'update',
          payload: updates,
          localRevision: doc.localRevision,
          baseServerVersion,
        });
      }

      await this.syncMetadataRepo.upsertInTx({
        entityType: 'document',
        entityId: doc.id,
        userId: doc.userId,
        syncState: 'pending',
        localRevision: doc.localRevision,
      });

      return doc;
    });
  }

  async delete(id: string, options?: { skipOutbox?: boolean }): Promise<void> {
    await this.db.transaction('rw', [this.db.documents, this.db.outbox, this.db.sync_metadata], async () => {
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

      let baseServerVersion: string | null = null;
      const existingMeta = await this.db.sync_metadata.get(`document:${id}`);
      if (existingMeta?.serverVersion) {
        baseServerVersion = existingMeta.serverVersion;
      }

      if (this.outboxRepo && !options?.skipOutbox) {
        await this.outboxRepo.enqueueInTx({
          userId: softDeleted.userId,
          projectId: softDeleted.projectId,
          entityType: 'document',
          entityId: softDeleted.id,
          operation: 'delete',
          payload: null,
          localRevision: softDeleted.localRevision,
          baseServerVersion,
        });
      }

      await this.syncMetadataRepo.upsertInTx({
        entityType: 'document',
        entityId: softDeleted.id,
        userId: softDeleted.userId,
        syncState: options?.skipOutbox ? 'synced' : 'pending',
        localRevision: softDeleted.localRevision,
      });
    });
  }

  async hardDelete(id: string): Promise<void> {
    await this.db.documents.delete(id);
  }

  async restore(id: string): Promise<LocalDocument> {
    return await this.db.transaction('rw', [this.db.documents, this.db.outbox, this.db.sync_metadata], async () => {
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

      if (this.outboxRepo) {
        await this.outboxRepo.enqueueInTx({
          userId: restored.userId,
          projectId: restored.projectId,
          entityType: 'document',
          entityId: restored.id,
          operation: 'update',
          payload: {
            title: restored.title,
            content: restored.content,
            format: restored.format,
            folderId: restored.folderId,
          },
          localRevision: restored.localRevision,
        });
      }

      await this.syncMetadataRepo.upsertInTx({
        entityType: 'document',
        entityId: restored.id,
        userId: restored.userId,
        syncState: 'pending',
        localRevision: restored.localRevision,
      });

      return restored;
    });
  }
}
