import { ArtixDB, getArtixDB } from '../local/db';
import { LocalWorkspaceFolder } from '../local/types';
import { EntityNotFoundError, DuplicateNameError } from '../local/errors';

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
  constructor(private db: ArtixDB = getArtixDB()) {}

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

  async create(dto: CreateFolderDTO): Promise<LocalWorkspaceFolder> {
    const trimmed = dto.name.trim();
    if (!trimmed) {
      throw new Error('Folder name cannot be empty');
    }

    return await this.db.transaction('rw', this.db.workspace_folders, async () => {
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
      const folder: LocalWorkspaceFolder = {
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

      await this.db.workspace_folders.add(folder);
      return folder;
    });
  }

  async rename(id: string, newName: string): Promise<LocalWorkspaceFolder> {
    const trimmed = newName.trim();
    if (!trimmed) {
      throw new Error('Folder name cannot be empty');
    }

    return await this.db.transaction('rw', this.db.workspace_folders, async () => {
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

      const updated: LocalWorkspaceFolder = {
        ...existing,
        name: trimmed,
        updatedAt: new Date().toISOString(),
        localRevision: existing.localRevision + 1,
      };

      await this.db.workspace_folders.put(updated);
      return updated;
    });
  }

  async update(id: string, updates: UpdateFolderDTO): Promise<LocalWorkspaceFolder> {
    return await this.db.transaction('rw', this.db.workspace_folders, async () => {
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

      const updated: LocalWorkspaceFolder = {
        ...existing,
        ...updates,
        name: updates.name ? updates.name.trim() : existing.name,
        updatedAt: new Date().toISOString(),
        localRevision: existing.localRevision + 1,
      };

      await this.db.workspace_folders.put(updated);
      return updated;
    });
  }

  async delete(id: string): Promise<void> {
    await this.db.transaction('rw', this.db.workspace_folders, async () => {
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
    });
  }

  async hardDelete(id: string): Promise<void> {
    await this.db.workspace_folders.delete(id);
  }

  async restore(id: string): Promise<LocalWorkspaceFolder> {
    return await this.db.transaction('rw', this.db.workspace_folders, async () => {
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
      return restored;
    });
  }
}
