import { ArtixDB, getArtixDB } from '../local/db';
import { LocalWorkspaceFolder, RemoteWorkspaceFolderSnapshot } from '../local/types';
import { EntityNotFoundError, DuplicateNameError } from '../local/errors';
import { OutboxRepository } from './outboxRepository';
import { SyncMetadataRepository } from './syncMetadataRepository';

export interface CreateFolderDTO {
  id?: string;
  userId: string;
  projectId: string;
  name: string;
  parentFolderId?: string | null;
}

export interface UpdateFolderDTO {
  name?: string;
  parentFolderId?: string | null;
}

export class WorkspaceFolderRepository {
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

  async getById(id: string): Promise<LocalWorkspaceFolder | null> {
    const folder = await this.db.workspace_folders.get(id);
    if (!folder || folder.isDeleted) return null;
    return folder;
  }

  async getByIdIncludeDeleted(id: string): Promise<LocalWorkspaceFolder | null> {
    const folder = await this.db.workspace_folders.get(id);
    return folder ?? null;
  }

  async listByProject(userId: string, projectId: string): Promise<LocalWorkspaceFolder[]> {
    const folders = await this.db.workspace_folders
      .where('userId')
      .equals(userId)
      .filter((folder) => folder.projectId === projectId && !folder.isDeleted)
      .toArray();

    return folders.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Applies an authoritative remote snapshot from Supabase into local IndexedDB.
   * Updates entity store and sync metadata (marking synced) with ZERO outbox entries.
   */
  async applyRemoteSnapshot(snapshot: RemoteWorkspaceFolderSnapshot, options?: { force?: boolean }): Promise<LocalWorkspaceFolder> {
    return await this.db.transaction('rw', [this.db.workspace_folders, this.db.outbox, this.db.sync_metadata], async () => {
      const now = new Date().toISOString();
      const existing = await this.db.workspace_folders.get(snapshot.id);

      // Defense-in-depth: do not overwrite active local pending intent unless forced
      if (!options?.force) {
        const outboxEntries = await this.db.outbox
          .where('[userId+entityType+entityId]')
          .equals([snapshot.userId, 'workspace_folder', snapshot.id])
          .toArray();

        const activeOutbox = outboxEntries.find(
          (e) => e.state === 'pending' || e.state === 'in_flight' || e.state === 'blocked'
        );

        if (activeOutbox && existing) {
          return existing;
        }
      }

      const folder: LocalWorkspaceFolder = {
        id: snapshot.id,
        userId: snapshot.userId,
        projectId: snapshot.projectId,
        name: snapshot.name.trim(),
        parentFolderId: snapshot.parentFolderId ?? null,
        createdAt: snapshot.createdAt || existing?.createdAt || now,
        updatedAt: snapshot.updatedAt || now,
        localRevision: existing ? existing.localRevision : 1,
        isDeleted: false,
        deletedAt: null,
      };

      await this.db.workspace_folders.put(folder);

      await this.syncMetadataRepo.upsertInTx({
        entityType: 'workspace_folder',
        entityId: folder.id,
        userId: folder.userId,
        syncState: 'synced',
        serverVersion: snapshot.serverVersion ? String(snapshot.serverVersion) : null,
        serverUpdatedAt: snapshot.updatedAt ?? null,
        localRevision: folder.localRevision,
        lastSyncedAt: Date.now(),
        baseSnapshot: snapshot,
      });

      return folder;
    });
  }

  async create(dto: CreateFolderDTO, options?: { skipOutbox?: boolean }): Promise<LocalWorkspaceFolder> {
    if (options?.skipOutbox) {
      return this.applyRemoteSnapshot({
        id: dto.id || crypto.randomUUID(),
        userId: dto.userId,
        projectId: dto.projectId,
        name: dto.name,
        parentFolderId: dto.parentFolderId,
      });
    }

    const trimmed = dto.name.trim();
    if (!trimmed) {
      throw new Error('Folder name cannot be empty');
    }

    return await this.db.transaction('rw', [this.db.workspace_folders, this.db.outbox, this.db.sync_metadata], async () => {
      // Validate uniqueness within the project
      const existingWithSameName = await this.db.workspace_folders
        .where('userId')
        .equals(dto.userId)
        .filter(
          (f) =>
            f.projectId === dto.projectId &&
            !f.isDeleted &&
            f.name.trim().toLowerCase() === trimmed.toLowerCase()
        )
        .first();

      if (existingWithSameName) {
        throw new DuplicateNameError(`A folder named "${trimmed}" already exists in this project`);
      }

      const now = new Date().toISOString();
      const newFolder: LocalWorkspaceFolder = {
        id: dto.id || crypto.randomUUID(),
        userId: dto.userId,
        projectId: dto.projectId,
        name: trimmed,
        parentFolderId: dto.parentFolderId ?? null,
        createdAt: now,
        updatedAt: now,
        localRevision: 1,
        isDeleted: false,
      };

      await this.db.workspace_folders.add(newFolder);

      if (this.outboxRepo) {
        await this.outboxRepo.enqueueInTx({
          userId: newFolder.userId,
          projectId: newFolder.projectId,
          entityType: 'workspace_folder',
          entityId: newFolder.id,
          operation: 'create',
          payload: {
            name: newFolder.name,
            parentFolderId: newFolder.parentFolderId,
          },
          localRevision: newFolder.localRevision,
        });
      }

      await this.syncMetadataRepo.upsertInTx({
        entityType: 'workspace_folder',
        entityId: newFolder.id,
        userId: newFolder.userId,
        syncState: 'pending',
        localRevision: newFolder.localRevision,
      });

      return newFolder;
    });
  }

  async rename(id: string, newName: string, options?: { skipOutbox?: boolean }): Promise<LocalWorkspaceFolder> {
    const trimmed = newName.trim();
    if (!trimmed) {
      throw new Error('Folder name cannot be empty');
    }

    if (options?.skipOutbox) {
      const existing = await this.getByIdIncludeDeleted(id);
      if (!existing) throw new EntityNotFoundError('WorkspaceFolder', id);
      return this.applyRemoteSnapshot({
        id,
        userId: existing.userId,
        projectId: existing.projectId,
        name: trimmed,
        parentFolderId: existing.parentFolderId,
      });
    }

    return await this.db.transaction('rw', [this.db.workspace_folders, this.db.outbox, this.db.sync_metadata], async () => {
      const existing = await this.db.workspace_folders.get(id);
      if (!existing || existing.isDeleted) {
        throw new EntityNotFoundError('WorkspaceFolder', id);
      }

      if (existing.name.trim().toLowerCase() !== trimmed.toLowerCase()) {
        const duplicate = await this.db.workspace_folders
          .where('userId')
          .equals(existing.userId)
          .filter(
            (f) =>
              f.id !== id &&
              f.projectId === existing.projectId &&
              !f.isDeleted &&
              f.name.trim().toLowerCase() === trimmed.toLowerCase()
          )
          .first();

        if (duplicate) {
          throw new DuplicateNameError(`A folder named "${trimmed}" already exists in this project`);
        }
      }

      const folder: LocalWorkspaceFolder = {
        ...existing,
        name: trimmed,
        updatedAt: new Date().toISOString(),
        localRevision: existing.localRevision + 1,
      };

      await this.db.workspace_folders.put(folder);

      let baseServerVersion: string | null = null;
      const existingMeta = await this.db.sync_metadata.get(`workspace_folder:${id}`);
      if (existingMeta?.serverVersion) {
        baseServerVersion = existingMeta.serverVersion;
      }

      if (this.outboxRepo) {
        await this.outboxRepo.enqueueInTx({
          userId: folder.userId,
          projectId: folder.projectId,
          entityType: 'workspace_folder',
          entityId: folder.id,
          operation: 'update',
          payload: { name: folder.name },
          localRevision: folder.localRevision,
          baseServerVersion,
        });
      }

      await this.syncMetadataRepo.upsertInTx({
        entityType: 'workspace_folder',
        entityId: folder.id,
        userId: folder.userId,
        syncState: 'pending',
        localRevision: folder.localRevision,
      });

      return folder;
    });
  }

  async update(id: string, updates: UpdateFolderDTO, options?: { skipOutbox?: boolean }): Promise<LocalWorkspaceFolder> {
    if (options?.skipOutbox) {
      const existing = await this.getByIdIncludeDeleted(id);
      if (!existing) throw new EntityNotFoundError('WorkspaceFolder', id);
      return this.applyRemoteSnapshot({
        id,
        userId: existing.userId,
        projectId: existing.projectId,
        name: updates.name ? updates.name.trim() : existing.name,
        parentFolderId: updates.parentFolderId !== undefined ? updates.parentFolderId : existing.parentFolderId,
      });
    }

    return await this.db.transaction('rw', [this.db.workspace_folders, this.db.outbox, this.db.sync_metadata], async () => {
      const existing = await this.db.workspace_folders.get(id);
      if (!existing || existing.isDeleted) {
        throw new EntityNotFoundError('WorkspaceFolder', id);
      }

      if (updates.name) {
        const trimmed = updates.name.trim();
        if (existing.name.trim().toLowerCase() !== trimmed.toLowerCase()) {
          const duplicate = await this.db.workspace_folders
            .where('userId')
            .equals(existing.userId)
            .filter(
              (f) =>
                f.id !== id &&
                f.projectId === existing.projectId &&
                !f.isDeleted &&
                f.name.trim().toLowerCase() === trimmed.toLowerCase()
            )
            .first();

          if (duplicate) {
            throw new DuplicateNameError(`A folder named "${trimmed}" already exists in this project`);
          }
        }
      }

      const folder: LocalWorkspaceFolder = {
        ...existing,
        ...updates,
        name: updates.name ? updates.name.trim() : existing.name,
        updatedAt: new Date().toISOString(),
        localRevision: existing.localRevision + 1,
      };

      await this.db.workspace_folders.put(folder);

      let updateBaseServerVersion: string | null = null;
      const existingUpdateMeta = await this.db.sync_metadata.get(`workspace_folder:${id}`);
      if (existingUpdateMeta?.serverVersion) {
        updateBaseServerVersion = existingUpdateMeta.serverVersion;
      }

      if (this.outboxRepo) {
        await this.outboxRepo.enqueueInTx({
          userId: folder.userId,
          projectId: folder.projectId,
          entityType: 'workspace_folder',
          entityId: folder.id,
          operation: 'update',
          payload: updates,
          localRevision: folder.localRevision,
          baseServerVersion: updateBaseServerVersion,
        });
      }

      await this.syncMetadataRepo.upsertInTx({
        entityType: 'workspace_folder',
        entityId: folder.id,
        userId: folder.userId,
        syncState: 'pending',
        localRevision: folder.localRevision,
      });

      return folder;
    });
  }

  async delete(id: string, options?: { skipOutbox?: boolean }): Promise<void> {
    await this.db.transaction('rw', [this.db.workspace_folders, this.db.outbox, this.db.sync_metadata], async () => {
      const existing = await this.db.workspace_folders.get(id);
      if (!existing) return;

      const softDeleted: LocalWorkspaceFolder = {
        ...existing,
        isDeleted: true,
        deletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        localRevision: existing.localRevision + 1,
      };

      await this.db.workspace_folders.put(softDeleted);

      let deleteBaseServerVersion: string | null = null;
      const existingDeleteMeta = await this.db.sync_metadata.get(`workspace_folder:${id}`);
      if (existingDeleteMeta?.serverVersion) {
        deleteBaseServerVersion = existingDeleteMeta.serverVersion;
      }

      if (this.outboxRepo && !options?.skipOutbox) {
        await this.outboxRepo.enqueueInTx({
          userId: softDeleted.userId,
          projectId: softDeleted.projectId,
          entityType: 'workspace_folder',
          entityId: softDeleted.id,
          operation: 'delete',
          payload: { parentFolderId: softDeleted.parentFolderId },
          localRevision: softDeleted.localRevision,
          baseServerVersion: deleteBaseServerVersion,
        });
      }

      await this.syncMetadataRepo.upsertInTx({
        entityType: 'workspace_folder',
        entityId: softDeleted.id,
        userId: softDeleted.userId,
        syncState: options?.skipOutbox ? 'synced' : 'pending',
        localRevision: softDeleted.localRevision,
      });
    });
  }

  async hardDelete(id: string): Promise<void> {
    await this.db.workspace_folders.delete(id);
  }

  async restore(id: string): Promise<LocalWorkspaceFolder> {
    return await this.db.transaction('rw', [this.db.workspace_folders, this.db.outbox, this.db.sync_metadata], async () => {
      const existing = await this.db.workspace_folders.get(id);
      if (!existing) {
        throw new EntityNotFoundError('WorkspaceFolder', id);
      }

      const restored: LocalWorkspaceFolder = {
        ...existing,
        isDeleted: false,
        deletedAt: null,
        updatedAt: new Date().toISOString(),
        localRevision: existing.localRevision + 1,
      };

      await this.db.workspace_folders.put(restored);

      let restoreBaseServerVersion: string | null = null;
      const existingRestoreMeta = await this.db.sync_metadata.get(`workspace_folder:${id}`);
      if (existingRestoreMeta?.serverVersion) {
        restoreBaseServerVersion = existingRestoreMeta.serverVersion;
      }

      if (this.outboxRepo) {
        await this.outboxRepo.enqueueInTx({
          userId: restored.userId,
          projectId: restored.projectId,
          entityType: 'workspace_folder',
          entityId: restored.id,
          operation: 'update',
          payload: {
            name: restored.name,
            parentFolderId: restored.parentFolderId,
          },
          localRevision: restored.localRevision,
          baseServerVersion: restoreBaseServerVersion,
        });
      }

      await this.syncMetadataRepo.upsertInTx({
        entityType: 'workspace_folder',
        entityId: restored.id,
        userId: restored.userId,
        syncState: 'pending',
        localRevision: restored.localRevision,
      });

      return restored;
    });
  }
}

export { WorkspaceFolderRepository as FolderRepository };
