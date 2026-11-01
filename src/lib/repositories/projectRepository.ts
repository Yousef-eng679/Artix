import { ArtixDB, getArtixDB } from '../local/db';
import { LocalProject, RemoteProjectSnapshot } from '../local/types';
import { EntityNotFoundError, DuplicateNameError } from '../local/errors';
import { OutboxRepository } from './outboxRepository';
import { SyncMetadataRepository } from './syncMetadataRepository';

export interface CreateProjectDTO {
  id?: string;
  userId: string;
  name: string;
}

export interface UpdateProjectDTO {
  name?: string;
}

export class ProjectRepository {
  private syncMetadataRepo: SyncMetadataRepository;

  constructor(
    private db: ArtixDB = getArtixDB(),
    private outboxRepo?: OutboxRepository,
    syncMetadataRepo?: SyncMetadataRepository,
  ) {
    this.syncMetadataRepo = syncMetadataRepo || new SyncMetadataRepository(this.db);
    if (!this.outboxRepo) {
      this.outboxRepo = new OutboxRepository(this.db);
    }
  }

  async getById(id: string): Promise<LocalProject | null> {
    const project = await this.db.projects.get(id);
    if (!project || project.isDeleted) return null;
    return project;
  }

  async getByIdIncludeDeleted(id: string): Promise<LocalProject | null> {
    const project = await this.db.projects.get(id);
    return project ?? null;
  }

  async listByUser(userId: string): Promise<LocalProject[]> {
    const projects = await this.db.projects
      .where('userId')
      .equals(userId)
      .filter((p) => !p.isDeleted)
      .toArray();

    return projects.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  /**
   * Applies an authoritative remote snapshot from Supabase into local IndexedDB.
   * Updates entity store and sync metadata (marking synced) with ZERO outbox entries.
   */
  async applyRemoteSnapshot(
    snapshot: RemoteProjectSnapshot,
    options?: { force?: boolean },
  ): Promise<LocalProject> {
    return await this.db.transaction(
      'rw',
      [this.db.projects, this.db.outbox, this.db.sync_metadata],
      async () => {
        const now = new Date().toISOString();
        const existing = await this.db.projects.get(snapshot.id);

        if (!options?.force) {
          const outboxEntries = await this.db.outbox
            .where('[userId+entityType+entityId]')
            .equals([snapshot.userId, 'project', snapshot.id])
            .toArray();

          const activeOutbox = outboxEntries.find(
            (e) => e.state === 'pending' || e.state === 'in_flight' || e.state === 'blocked',
          );

          if (activeOutbox && existing) {
            return existing;
          }
        }

        const trimmedName = (snapshot.name || 'Untitled Project').trim() || 'Untitled Project';
        const existingRev = existing?.localRevision ?? 1;
        const payloadChanged =
          !existing ||
          Boolean(existing.isDeleted) ||
          existing.name !== trimmedName ||
          (snapshot.updatedAt !== undefined && existing.updatedAt !== snapshot.updatedAt);

        const nextLocalRevision = existing
          ? payloadChanged
            ? existingRev + 1
            : existingRev
          : 1;

        const project: LocalProject = {
          id: snapshot.id,
          userId: snapshot.userId,
          name: trimmedName,
          createdAt: snapshot.createdAt || existing?.createdAt || now,
          updatedAt: snapshot.updatedAt || now,
          localRevision: nextLocalRevision,
          isDeleted: false,
          deletedAt: null,
          cachedDocumentCount:
            snapshot.cachedDocumentCount ?? existing?.cachedDocumentCount ?? 0,
          cachedDesignCount:
            snapshot.cachedDesignCount ?? existing?.cachedDesignCount ?? 0,
        };

        await this.db.projects.put(project);

        const existingMeta = await this.db.sync_metadata.get(`project:${project.id}`);
        const resolvedServerVersion =
          snapshot.serverVersion !== undefined && snapshot.serverVersion !== null
            ? String(snapshot.serverVersion)
            : (existingMeta?.serverVersion ?? null);

        await this.syncMetadataRepo.upsertInTx({
          entityType: 'project',
          entityId: project.id,
          userId: project.userId,
          syncState: 'synced',
          serverVersion: resolvedServerVersion,
          serverUpdatedAt: snapshot.updatedAt ?? existingMeta?.serverUpdatedAt ?? null,
          localRevision: project.localRevision,
          lastSyncedAt: Date.now(),
          baseSnapshot: snapshot,
        });

        return project;
      },
    );
  }

  async create(dto: CreateProjectDTO, options?: { skipOutbox?: boolean }): Promise<LocalProject> {
    const trimmed = dto.name.trim();
    if (!trimmed) {
      throw new Error('Project name cannot be empty');
    }

    if (options?.skipOutbox) {
      return this.applyRemoteSnapshot({
        id: dto.id || crypto.randomUUID(),
        userId: dto.userId,
        name: trimmed,
      });
    }

    return await this.db.transaction(
      'rw',
      [this.db.projects, this.db.outbox, this.db.sync_metadata],
      async () => {
        const duplicate = await this.db.projects
          .where('userId')
          .equals(dto.userId)
          .filter(
            (p) => !p.isDeleted && p.name.trim().toLowerCase() === trimmed.toLowerCase(),
          )
          .first();

        if (duplicate) {
          throw new DuplicateNameError(`A project named "${trimmed}" already exists.`);
        }

        const now = new Date().toISOString();
        const newProject: LocalProject = {
          id: dto.id || crypto.randomUUID(),
          userId: dto.userId,
          name: trimmed,
          createdAt: now,
          updatedAt: now,
          localRevision: 1,
          isDeleted: false,
          deletedAt: null,
          cachedDocumentCount: 0,
          cachedDesignCount: 0,
        };

        await this.db.projects.put(newProject);

        if (this.outboxRepo) {
          await this.outboxRepo.enqueueInTx({
            userId: newProject.userId,
            projectId: newProject.id,
            entityType: 'project',
            entityId: newProject.id,
            operation: 'create',
            payload: { name: newProject.name },
            localRevision: newProject.localRevision,
          });
        }

        await this.syncMetadataRepo.upsertInTx({
          entityType: 'project',
          entityId: newProject.id,
          userId: newProject.userId,
          syncState: 'pending',
          localRevision: newProject.localRevision,
        });

        return newProject;
      },
    );
  }

  async rename(
    id: string,
    newName: string,
    options?: { skipOutbox?: boolean },
  ): Promise<LocalProject> {
    return this.update(id, { name: newName }, options);
  }

  async update(
    id: string,
    updates: UpdateProjectDTO,
    options?: { skipOutbox?: boolean },
  ): Promise<LocalProject> {
    const trimmed = updates.name !== undefined ? updates.name.trim() : undefined;
    if (trimmed !== undefined && !trimmed) {
      throw new Error('Project name cannot be empty');
    }

    if (options?.skipOutbox) {
      const existing = await this.getByIdIncludeDeleted(id);
      if (!existing) throw new EntityNotFoundError('Project', id);
      return this.applyRemoteSnapshot({
        id,
        userId: existing.userId,
        name: trimmed ?? existing.name,
      });
    }

    return await this.db.transaction(
      'rw',
      [this.db.projects, this.db.outbox, this.db.sync_metadata],
      async () => {
        const existing = await this.db.projects.get(id);
        if (!existing || existing.isDeleted) {
          throw new EntityNotFoundError('Project', id);
        }

        const nextName = trimmed ?? existing.name;
        if (existing.name.trim().toLowerCase() !== nextName.toLowerCase()) {
          const duplicate = await this.db.projects
            .where('userId')
            .equals(existing.userId)
            .filter(
              (p) =>
                p.id !== id &&
                !p.isDeleted &&
                p.name.trim().toLowerCase() === nextName.toLowerCase(),
            )
            .first();

          if (duplicate) {
            throw new DuplicateNameError(`A project named "${nextName}" already exists.`);
          }
        }

        const nextRevision = (existing.localRevision ?? 1) + 1;
        const updatedProject: LocalProject = {
          ...existing,
          name: nextName,
          updatedAt: new Date().toISOString(),
          localRevision: nextRevision,
          isDeleted: false,
        };

        await this.db.projects.put(updatedProject);

        let baseServerVersion: string | null = null;
        const existingMeta = await this.db.sync_metadata.get(`project:${id}`);
        if (existingMeta?.serverVersion) {
          baseServerVersion = existingMeta.serverVersion;
        }

        if (this.outboxRepo) {
          await this.outboxRepo.enqueueInTx({
            userId: updatedProject.userId,
            projectId: updatedProject.id,
            entityType: 'project',
            entityId: updatedProject.id,
            operation: 'update',
            payload: { name: updatedProject.name },
            localRevision: updatedProject.localRevision,
            baseServerVersion,
          });
        }

        await this.syncMetadataRepo.upsertInTx({
          entityType: 'project',
          entityId: updatedProject.id,
          userId: updatedProject.userId,
          syncState: 'pending',
          localRevision: updatedProject.localRevision,
        });

        return updatedProject;
      },
    );
  }

  /**
   * Soft-deletes the project locally, cascades soft-delete onto local child
   * folders/documents/designs belonging to the project, and cleans up child
   * outbox entries when appropriate so orphaned child mutations are never pushed.
   */
  async delete(id: string, options?: { skipOutbox?: boolean }): Promise<number | null> {
    return await this.db.transaction(
      'rw',
      [
        this.db.projects,
        this.db.documents,
        this.db.system_designs,
        this.db.workspace_folders,
        this.db.outbox,
        this.db.sync_metadata,
      ],
      async () => {
        const existing = await this.db.projects.get(id);
        const now = new Date().toISOString();

        // Cascade soft-delete onto child workspace entities belonging to this project
        const userId = existing?.userId;
        if (userId) {
          const allUserOutbox = await this.db.outbox
            .where('userId')
            .equals(userId)
            .toArray();

          const activeChildOutboxIds = new Set<string>();
          for (const entry of allUserOutbox) {
            if (entry.entityType === 'project') continue;
            const entryProjId =
              entry.projectId ||
              (entry.payload as Record<string, any> | null)?.projectId ||
              (entry.payload as Record<string, any> | null)?.project_id;
            if (entryProjId !== id) continue;

            if (!options?.skipOutbox) {
              // User explicitly deleted the entire project locally: purge queued child mutations
              // (PostgreSQL ON DELETE CASCADE handles server-side children when project delete pushes)
              if (entry.state !== 'in_flight') {
                await this.db.outbox.delete(entry.id);
              }
            } else if (
              entry.state === 'pending' ||
              entry.state === 'in_flight' ||
              entry.state === 'blocked'
            ) {
              activeChildOutboxIds.add(`${entry.entityType}:${entry.entityId}`);
            }
          }

          const [childDocs, childDesigns, childFolders] = await Promise.all([
            this.db.documents
              .where('userId')
              .equals(userId)
              .filter((d) => d.projectId === id && !d.isDeleted)
              .toArray(),
            this.db.system_designs
              .where('userId')
              .equals(userId)
              .filter((d) => d.projectId === id && !d.isDeleted)
              .toArray(),
            this.db.workspace_folders
              .where('userId')
              .equals(userId)
              .filter((f) => f.projectId === id && !f.isDeleted)
              .toArray(),
          ]);

          for (const doc of childDocs) {
            if (options?.skipOutbox && activeChildOutboxIds.has(`document:${doc.id}`)) continue;
            await this.db.documents.put({
              ...doc,
              isDeleted: true,
              deletedAt: now,
              updatedAt: now,
              localRevision: doc.localRevision + 1,
            });
            await this.syncMetadataRepo.upsertInTx({
              entityType: 'document',
              entityId: doc.id,
              userId,
              syncState: 'deleted_synced',
              localRevision: doc.localRevision + 1,
            });
          }

          for (const design of childDesigns) {
            if (options?.skipOutbox && activeChildOutboxIds.has(`system_design:${design.id}`)) {
              continue;
            }
            await this.db.system_designs.put({
              ...design,
              isDeleted: true,
              deletedAt: now,
              updatedAt: now,
              localRevision: design.localRevision + 1,
            });
            await this.syncMetadataRepo.upsertInTx({
              entityType: 'system_design',
              entityId: design.id,
              userId,
              syncState: 'deleted_synced',
              localRevision: design.localRevision + 1,
            });
          }

          for (const folder of childFolders) {
            if (
              options?.skipOutbox &&
              activeChildOutboxIds.has(`workspace_folder:${folder.id}`)
            ) {
              continue;
            }
            await this.db.workspace_folders.put({
              ...folder,
              isDeleted: true,
              deletedAt: now,
              updatedAt: now,
              localRevision: folder.localRevision + 1,
            });
            await this.syncMetadataRepo.upsertInTx({
              entityType: 'workspace_folder',
              entityId: folder.id,
              userId,
              syncState: 'deleted_synced',
              localRevision: folder.localRevision + 1,
            });
          }
        }

        if (!existing) return null;

        const nextRevision = (existing.localRevision ?? 1) + 1;
        const softDeleted: LocalProject = {
          ...existing,
          isDeleted: true,
          deletedAt: now,
          updatedAt: now,
          localRevision: nextRevision,
        };

        await this.db.projects.put(softDeleted);

        let deleteBaseServerVersion: string | null = null;
        const existingDeleteMeta = await this.db.sync_metadata.get(`project:${id}`);
        if (existingDeleteMeta?.serverVersion) {
          deleteBaseServerVersion = existingDeleteMeta.serverVersion;
        }

        let enqueuedDelete: unknown = null;
        if (this.outboxRepo && !options?.skipOutbox) {
          enqueuedDelete = await this.outboxRepo.enqueueInTx({
            userId: softDeleted.userId,
            projectId: softDeleted.id,
            entityType: 'project',
            entityId: softDeleted.id,
            operation: 'delete',
            payload: {},
            localRevision: softDeleted.localRevision,
            baseServerVersion: deleteBaseServerVersion,
          });
        }

        await this.syncMetadataRepo.upsertInTx({
          entityType: 'project',
          entityId: softDeleted.id,
          userId: softDeleted.userId,
          syncState:
            options?.skipOutbox || enqueuedDelete === null ? 'deleted_synced' : 'deleted_pending',
          localRevision: softDeleted.localRevision,
        });

        return softDeleted.localRevision;
      },
    );
  }

  async hardDelete(id: string): Promise<void> {
    await this.db.projects.delete(id);
  }

  async restore(id: string): Promise<LocalProject> {
    return await this.db.transaction(
      'rw',
      [this.db.projects, this.db.outbox, this.db.sync_metadata],
      async () => {
        const existing = await this.db.projects.get(id);
        if (!existing) {
          throw new EntityNotFoundError('Project', id);
        }

        const nextRevision = (existing.localRevision ?? 1) + 1;
        const restored: LocalProject = {
          ...existing,
          isDeleted: false,
          deletedAt: null,
          updatedAt: new Date().toISOString(),
          localRevision: nextRevision,
        };

        await this.db.projects.put(restored);

        const existingMeta = await this.db.sync_metadata.get(`project:${id}`);
        const existingOutbox = await this.db.outbox
          .where('[userId+entityType+entityId]')
          .equals([restored.userId, 'project', restored.id])
          .toArray();
        const hasPendingDelete = existingOutbox.some(
          (e) => e.state === 'pending' && e.operation === 'delete',
        );

        const validServerVersion =
          existingMeta?.serverVersion && /^[1-9]\d*$/.test(existingMeta.serverVersion)
            ? existingMeta.serverVersion
            : null;

        const mustReCreate =
          !validServerVersion ||
          (existingMeta?.syncState === 'deleted_synced' && !hasPendingDelete);

        if (this.outboxRepo) {
          await this.outboxRepo.enqueueInTx({
            userId: restored.userId,
            projectId: restored.id,
            entityType: 'project',
            entityId: restored.id,
            operation: mustReCreate ? 'create' : 'update',
            baseServerVersion: mustReCreate ? null : validServerVersion,
            payload: { name: restored.name },
            localRevision: restored.localRevision,
          });
        }

        await this.syncMetadataRepo.upsertInTx({
          entityType: 'project',
          entityId: restored.id,
          userId: restored.userId,
          syncState: 'pending',
          serverVersion: mustReCreate ? null : validServerVersion,
          localRevision: restored.localRevision,
        });

        return restored;
      },
    );
  }
}
