import { ArtixDB, getArtixDB } from '../local/db';
import {
  ConflictRecord,
  EntityType,
  LocalDocument,
  LocalProject,
  LocalSystemDesign,
  LocalWorkspaceFolder,
} from '../local/types';
import { ConflictResolver } from '../sync/conflictResolver';

export interface RecordConflictParams {
  entityType: EntityType;
  entityId: string;
  userId: string;
  basePayload: unknown;
  localPayload: unknown;
  remotePayload: unknown;
  reason?: string | null;
  remoteVersion?: string | null;
}

export type ConflictStrategy = 'keep_local' | 'keep_remote' | 'merge_document' | 'create_copy';

type LocalEntity = LocalProject | LocalDocument | LocalSystemDesign | LocalWorkspaceFolder;

const EMPTY_BOARD = { nodes: [], edges: [], strokes: [] };

export class ConflictRepository {
  private db: ArtixDB;

  constructor(db?: ArtixDB) {
    this.db = db || getArtixDB();
  }

  getDb(): ArtixDB {
    return this.db;
  }

  /**
   * Direct in-transaction conflict write so callers can bundle outbox + sync_metadata + conflicts atomically.
   */
  async recordConflictInTx(params: RecordConflictParams): Promise<ConflictRecord> {
    const record: ConflictRecord = {
      id: crypto.randomUUID(),
      entityType: params.entityType,
      entityId: params.entityId,
      userId: params.userId,
      basePayload: params.basePayload,
      localPayload: params.localPayload,
      remotePayload: params.remotePayload,
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
      ...(params.remoteVersion !== undefined ? { remoteVersion: params.remoteVersion } : {}),
      detectedAt: Date.now(),
      resolvedAt: null,
    };

    await this.db.conflicts.add(record);
    return record;
  }

  /**
   * Persists a 3-way conflict record without destroying either local or remote data.
   */
  async recordConflict(params: RecordConflictParams): Promise<ConflictRecord> {
    return await this.db.transaction('rw', this.db.conflicts, async () => {
      return await this.recordConflictInTx(params);
    });
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
    const records = await this.db.conflicts
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
    return all.filter((c) => !c.resolvedAt && (!userId || c.userId === userId));
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

  // ───────────────────────────── resolution helpers ─────────────────────────────

  private async getLocalEntity(entityType: EntityType, id: string): Promise<LocalEntity | undefined> {
    switch (entityType) {
      case 'project':
        return await this.db.projects.get(id);
      case 'document':
        return await this.db.documents.get(id);
      case 'system_design':
        return await this.db.system_designs.get(id);
      case 'workspace_folder':
        return await this.db.workspace_folders.get(id);
      default:
        return undefined;
    }
  }

  /** Builds the outbox `create` payload in the same shape the entity repositories enqueue. */
  private buildCreatePayload(entityType: EntityType, entity: LocalEntity): Record<string, unknown> {
    switch (entityType) {
      case 'project':
        return { name: (entity as LocalProject).name };
      case 'document': {
        const d = entity as LocalDocument;
        return { title: d.title, content: d.content, format: d.format, folderId: d.folderId };
      }
      case 'system_design': {
        const s = entity as LocalSystemDesign;
        return { name: s.name, boardState: s.boardState, folderId: s.folderId };
      }
      case 'workspace_folder': {
        const f = entity as LocalWorkspaceFolder;
        return { name: f.name, parentFolderId: f.parentFolderId };
      }
      default:
        return {};
    }
  }

  private entityProjectId(entityType: EntityType, entity: LocalEntity): string | null {
    if (entityType === 'project') return entity.id;
    return (entity as LocalDocument).projectId ?? null;
  }

  private async purgeOutbox(userId: string, entityType: EntityType, entityId: string): Promise<void> {
    const entries = await this.db.outbox
      .where('[userId+entityType+entityId]')
      .equals([userId, entityType, entityId])
      .toArray();
    for (const entry of entries) {
      await this.db.outbox.delete(entry.id);
    }
  }

  private async enqueueFreshCreate(
    userId: string,
    entityType: EntityType,
    entity: LocalEntity
  ): Promise<void> {
    const now = Date.now();
    await this.db.outbox.add({
      id: crypto.randomUUID(),
      mutationId: crypto.randomUUID(),
      userId,
      projectId: this.entityProjectId(entityType, entity),
      entityType,
      entityId: entity.id,
      operation: 'create',
      payload: this.buildCreatePayload(entityType, entity),
      localRevision: entity.localRevision,
      baseServerVersion: null,
      state: 'pending',
      dispatched: false,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Soft-deletes a local entity to mirror an authoritative server delete.
   * Projects cascade onto local children and purge their queued mutations
   * (server-side `ON DELETE CASCADE` already removed the children).
   */
  private async softDeleteLocal(entityType: EntityType, entityId: string, userId: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const tombstone = <T extends LocalEntity>(row: T): T => ({
      ...row,
      isDeleted: true,
      deletedAt: nowIso,
      updatedAt: nowIso,
      localRevision: (row.localRevision ?? 1) + 1,
    });

    if (entityType === 'project') {
      const project = await this.db.projects.get(entityId);
      if (project) await this.db.projects.put(tombstone(project));

      const childTables = [this.db.documents, this.db.system_designs, this.db.workspace_folders] as const;
      for (const table of childTables) {
        const children = await (table as any)
          .where('userId')
          .equals(userId)
          .filter((c: LocalEntity) => (c as LocalDocument).projectId === entityId && !c.isDeleted)
          .toArray();
        for (const child of children) {
          await (table as any).put(tombstone(child));
        }
      }

      const userOutbox = await this.db.outbox.where('userId').equals(userId).toArray();
      for (const entry of userOutbox) {
        if (entry.entityType !== 'project' && entry.projectId === entityId) {
          await this.db.outbox.delete(entry.id);
        }
      }
      return;
    }

    const existing = await this.getLocalEntity(entityType, entityId);
    if (!existing || existing.isDeleted) return;
    if (entityType === 'document') await this.db.documents.put(tombstone(existing as LocalDocument));
    else if (entityType === 'system_design')
      await this.db.system_designs.put(tombstone(existing as LocalSystemDesign));
    else if (entityType === 'workspace_folder')
      await this.db.workspace_folders.put(tombstone(existing as LocalWorkspaceFolder));
  }

  /** Overwrites the local entity with the authoritative remote row. */
  private async applyRemoteToLocal(
    entityType: EntityType,
    entityId: string,
    userId: string,
    remote: any,
    remoteUpdatedAt: string
  ): Promise<void> {
    if (entityType === 'project') {
      const existing = await this.db.projects.get(entityId);
      await this.db.projects.put({
        id: entityId,
        userId,
        name: remote.name ?? existing?.name ?? 'Untitled Project',
        createdAt: remote.created_at || existing?.createdAt || remoteUpdatedAt,
        updatedAt: remoteUpdatedAt,
        localRevision: existing ? (existing.localRevision ?? 1) + 1 : 1,
        isDeleted: false,
        deletedAt: null,
        cachedDocumentCount: existing?.cachedDocumentCount ?? 0,
        cachedDesignCount: existing?.cachedDesignCount ?? 0,
      });
    } else if (entityType === 'document') {
      const existing = await this.db.documents.get(entityId);
      await this.db.documents.put({
        id: entityId,
        userId,
        projectId: remote.project_id ?? existing?.projectId ?? null,
        folderId: remote.folder_id ?? existing?.folderId ?? null,
        title: remote.title ?? existing?.title ?? 'Untitled Document',
        content: remote.content ?? existing?.content ?? '',
        format: remote.format || existing?.format || 'markdown',
        createdAt: remote.created_at || existing?.createdAt || remoteUpdatedAt,
        updatedAt: remoteUpdatedAt,
        localRevision: existing ? existing.localRevision + 1 : 1,
        isDeleted: false,
        deletedAt: null,
      });
    } else if (entityType === 'workspace_folder') {
      const existing = await this.db.workspace_folders.get(entityId);
      await this.db.workspace_folders.put({
        id: entityId,
        userId,
        projectId: remote.project_id ?? existing?.projectId ?? '',
        name: remote.name ?? existing?.name ?? 'Untitled Folder',
        parentFolderId: remote.parent_folder_id ?? existing?.parentFolderId ?? null,
        createdAt: remote.created_at || existing?.createdAt || remoteUpdatedAt,
        updatedAt: remoteUpdatedAt,
        localRevision: existing ? existing.localRevision + 1 : 1,
        isDeleted: false,
        deletedAt: null,
      });
    } else if (entityType === 'system_design') {
      const existing = await this.db.system_designs.get(entityId);
      await this.db.system_designs.put({
        id: entityId,
        userId,
        projectId: remote.project_id ?? existing?.projectId ?? '',
        name: remote.name ?? existing?.name ?? 'New System Design',
        folderId: remote.folder_id ?? existing?.folderId ?? null,
        boardState: remote.board_state ?? existing?.boardState ?? EMPTY_BOARD,
        createdAt: remote.created_at || existing?.createdAt || remoteUpdatedAt,
        updatedAt: remoteUpdatedAt,
        localRevision: existing ? existing.localRevision + 1 : 1,
        isDeleted: false,
        deletedAt: null,
      });
    }
  }

  /**
   * Accepts the server's outcome for the original entity: mirror a remote delete, or
   * overwrite local with the remote row. Discards all queued local mutations for it.
   */
  private async acceptRemote(
    conflict: ConflictRecord,
    isRemoteDeleted: boolean,
    remote: any,
    remoteVersion: string | null,
    remoteUpdatedAt: string
  ): Promise<void> {
    const { entityType, entityId, userId } = conflict;
    if (isRemoteDeleted) {
      await this.softDeleteLocal(entityType, entityId, userId);
    } else {
      await this.applyRemoteToLocal(entityType, entityId, userId, remote, remoteUpdatedAt);
    }
    await this.purgeOutbox(userId, entityType, entityId);

    await this.db.sync_metadata.put({
      id: `${entityType}:${entityId}`,
      entityType,
      entityId,
      userId,
      syncState: isRemoteDeleted ? 'deleted_synced' : 'synced',
      serverVersion: remoteVersion,
      serverUpdatedAt: remoteUpdatedAt,
      localRevision: 1,
      lastSyncedAt: Date.now(),
      baseSnapshot: isRemoteDeleted ? null : conflict.remotePayload,
    });
  }

  /** Clones the local entity under a fresh id and queues it as a brand-new create. */
  private async createLocalCopy(
    entityType: EntityType,
    source: LocalEntity,
    userId: string,
    copyTitle?: string
  ): Promise<string> {
    const copyId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const base = {
      id: copyId,
      userId,
      createdAt: nowIso,
      updatedAt: nowIso,
      localRevision: 1,
      isDeleted: false,
      deletedAt: null,
    };

    let copy: LocalEntity;
    if (entityType === 'project') {
      const p = source as LocalProject;
      copy = { ...p, ...base, name: copyTitle || `${p.name || 'Project'} (Conflict Copy)`, cachedDocumentCount: 0, cachedDesignCount: 0 };
      await this.db.projects.add(copy as LocalProject);
    } else if (entityType === 'document') {
      const d = source as LocalDocument;
      copy = { ...d, ...base, title: copyTitle || `${d.title || 'Document'} (Conflict Copy)` };
      await this.db.documents.add(copy as LocalDocument);
    } else if (entityType === 'system_design') {
      const s = source as LocalSystemDesign;
      copy = { ...s, ...base, name: copyTitle || `${s.name || 'System Design'} (Conflict Copy)` };
      await this.db.system_designs.add(copy as LocalSystemDesign);
    } else {
      const f = source as LocalWorkspaceFolder;
      let folderCopyName = copyTitle;
      if (!folderCopyName) {
        const siblings = await this.db.workspace_folders
          .where('projectId')
          .equals(f.projectId)
          .filter((s) => !s.isDeleted && (s.parentFolderId ?? null) === (f.parentFolderId ?? null))
          .toArray();
        folderCopyName = ConflictResolver.resolveFolderConflictName(
          f.name || 'Folder',
          siblings.map((s) => s.name)
        );
      }
      copy = { ...f, ...base, name: folderCopyName };
      await this.db.workspace_folders.add(copy as LocalWorkspaceFolder);
    }

    await this.enqueueFreshCreate(userId, entityType, copy);
    await this.db.sync_metadata.put({
      id: `${entityType}:${copyId}`,
      entityType,
      entityId: copyId,
      userId,
      syncState: 'pending',
      serverVersion: null,
      serverUpdatedAt: null,
      localRevision: 1,
      lastSyncedAt: null,
    });
    return copyId;
  }

  /**
   * Atomically executes a conflict resolution strategy across local tables, outbox, and sync metadata.
   *
   * Remote-delete conflicts (S-03):
   * - `keep_local`  -> re-creates the entity on the server via a fresh `create` mutation
   *                    (new `mutationId`, `baseServerVersion: null`, `dispatched: false`).
   * - `keep_remote` -> accepts the deletion: soft-deletes locally and marks `deleted_synced`.
   * - `create_copy` -> saves local work as a new entity, then accepts the deletion.
   */
  async resolveConflict(params: {
    conflictId: string;
    strategy: ConflictStrategy;
    mergedContent?: string;
    copyTitle?: string;
  }): Promise<{ conflictId: string; resolvedAt: number; strategy: string; copyEntityId?: string }> {
    return await this.db.transaction(
      'rw',
      [
        this.db.conflicts,
        this.db.projects,
        this.db.documents,
        this.db.workspace_folders,
        this.db.system_designs,
        this.db.outbox,
        this.db.sync_metadata,
      ],
      async () => {
        const conflict = await this.db.conflicts.get(params.conflictId);
        if (!conflict) {
          throw new Error(`Conflict not found: ${params.conflictId}`);
        }

        const { entityType, entityId, userId, remotePayload } = conflict;
        const remote = (remotePayload as any) || {};
        const remoteVersion =
          conflict.remoteVersion ??
          (remote.version !== undefined && remote.version !== null ? String(remote.version) : null);
        const remoteUpdatedAt = remote.updated_at || new Date().toISOString();
        const isRemoteDeleted = conflict.reason === 'remote_deleted' || remote.deleted === true;
        const syncId = `${entityType}:${entityId}`;
        let copyEntityId: string | undefined;

        if (params.strategy === 'keep_local') {
          const local = await this.getLocalEntity(entityType, entityId);
          const isLocalDeleted =
            !local || local.isDeleted || (conflict.localPayload as any)?.deleted === true;

          if (isRemoteDeleted) {
            await this.purgeOutbox(userId, entityType, entityId);
            if (isLocalDeleted || !local) {
              // Both sides deleted: converge without any network round-trip
              await this.db.sync_metadata.put({
                id: syncId,
                entityType,
                entityId,
                userId,
                syncState: 'deleted_synced',
                serverVersion: null,
                serverUpdatedAt: remoteUpdatedAt,
                localRevision: local?.localRevision ?? 1,
                lastSyncedAt: Date.now(),
                baseSnapshot: null,
              });
            } else {
              // Entity no longer exists on server: an update/delete can never apply -> re-create it
              await this.enqueueFreshCreate(userId, entityType, local);
              await this.db.sync_metadata.put({
                id: syncId,
                entityType,
                entityId,
                userId,
                syncState: 'pending',
                serverVersion: null,
                serverUpdatedAt: null,
                localRevision: local.localRevision,
                lastSyncedAt: null,
                baseSnapshot: null,
              });
            }
          } else {
            // Keep local entity unchanged. Unblock outbox entries rebased on the remote version
            const outboxEntries = await this.db.outbox
              .where('[userId+entityType+entityId]')
              .equals([userId, entityType, entityId])
              .toArray();

            if (outboxEntries.length > 0) {
              for (const entry of outboxEntries) {
                await this.db.outbox.update(entry.id, {
                  mutationId: crypto.randomUUID(),
                  dispatched: false,
                  state: 'pending',
                  baseServerVersion: remoteVersion,
                  attemptCount: 0,
                  nextRetryAt: Date.now(),
                  leaseOwner: null,
                  leaseToken: null,
                  leaseExpiresAt: null,
                  lastError: undefined,
                  updatedAt: Date.now(),
                });
              }
            } else if (local) {
              const now = Date.now();
              await this.db.outbox.add({
                id: crypto.randomUUID(),
                mutationId: crypto.randomUUID(),
                userId,
                projectId: this.entityProjectId(entityType, local),
                entityType,
                entityId,
                operation: isLocalDeleted ? 'delete' : 'update',
                payload: isLocalDeleted ? null : this.buildCreatePayload(entityType, local),
                localRevision: local.localRevision,
                baseServerVersion: remoteVersion,
                state: 'pending',
                dispatched: false,
                attemptCount: 0,
                createdAt: now,
                updatedAt: now,
              });
            }

            const existingMeta = await this.db.sync_metadata.get(syncId);
            await this.db.sync_metadata.put({
              id: syncId,
              entityType,
              entityId,
              userId,
              syncState: isLocalDeleted ? 'deleted_pending' : 'pending',
              serverVersion: remoteVersion,
              serverUpdatedAt: remoteUpdatedAt,
              localRevision: (existingMeta?.localRevision ?? 1) + 1,
              lastSyncedAt: existingMeta?.lastSyncedAt ?? null,
              baseSnapshot: remotePayload,
            });
          }
        } else if (params.strategy === 'keep_remote') {
          await this.acceptRemote(conflict, isRemoteDeleted, remote, remoteVersion, remoteUpdatedAt);
        } else if (params.strategy === 'merge_document') {
          if (entityType !== 'document') {
            throw new Error(`merge_document strategy is only supported for documents, got ${entityType}`);
          }
          if (isRemoteDeleted) {
            throw new Error('merge_document is not available when the document was deleted remotely');
          }
          const existing = await this.db.documents.get(entityId);
          if (!existing) {
            throw new Error(`Document ${entityId} not found`);
          }

          const mergedContent = params.mergedContent ?? existing.content;
          const nextRevision = existing.localRevision + 1;
          await this.db.documents.put({
            ...existing,
            content: mergedContent,
            updatedAt: new Date().toISOString(),
            localRevision: nextRevision,
          });

          // Update outbox entry or enqueue new update mutation
          const outboxEntries = await this.db.outbox
            .where('[userId+entityType+entityId]')
            .equals([userId, entityType, entityId])
            .toArray();

          if (outboxEntries.length > 0) {
            for (const entry of outboxEntries) {
              await this.db.outbox.update(entry.id, {
                mutationId: crypto.randomUUID(),
                dispatched: false,
                payload: { ...(entry.payload as any), content: mergedContent },
                state: 'pending',
                baseServerVersion: remoteVersion,
                localRevision: nextRevision,
                attemptCount: 0,
                nextRetryAt: Date.now(),
                leaseOwner: null,
                leaseToken: null,
                leaseExpiresAt: null,
                lastError: undefined,
                updatedAt: Date.now(),
              });
            }
          } else {
            await this.db.outbox.add({
              id: crypto.randomUUID(),
              mutationId: crypto.randomUUID(),
              userId,
              projectId: existing.projectId,
              entityType: 'document',
              entityId,
              operation: 'update',
              payload: { title: existing.title, content: mergedContent, format: existing.format },
              localRevision: nextRevision,
              baseServerVersion: remoteVersion,
              state: 'pending',
              dispatched: false,
              attemptCount: 0,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          }

          await this.db.sync_metadata.put({
            id: syncId,
            entityType,
            entityId,
            userId,
            syncState: 'pending',
            serverVersion: remoteVersion,
            serverUpdatedAt: remoteUpdatedAt,
            localRevision: nextRevision,
            lastSyncedAt: Date.now(),
            baseSnapshot: remotePayload,
          });
        } else if (params.strategy === 'create_copy') {
          const local = await this.getLocalEntity(entityType, entityId);
          if (local) {
            copyEntityId = await this.createLocalCopy(entityType, local, userId, params.copyTitle);
          }
          await this.acceptRemote(conflict, isRemoteDeleted, remote, remoteVersion, remoteUpdatedAt);
        }

        const resolvedAt = Date.now();
        await this.db.conflicts.update(params.conflictId, { resolvedAt });

        return {
          conflictId: params.conflictId,
          resolvedAt,
          strategy: params.strategy,
          copyEntityId,
        };
      }
    );
  }
}
