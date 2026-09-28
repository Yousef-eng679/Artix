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

  /**
   * Atomically executes a conflict resolution strategy across local tables, outbox, and sync metadata.
   */
  async resolveConflict(params: {
    conflictId: string;
    strategy: 'keep_local' | 'keep_remote' | 'merge_document' | 'create_copy';
    mergedContent?: string;
    copyTitle?: string;
  }): Promise<{ conflictId: string; resolvedAt: number; strategy: string; copyEntityId?: string }> {
    return await this.db.transaction(
      'rw',
      [
        this.db.conflicts,
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
        const remoteVersion = remote.version !== undefined ? String(remote.version) : null;
        const remoteUpdatedAt = remote.updated_at || new Date().toISOString();
        const syncId = `${entityType}:${entityId}`;
        let copyEntityId: string | undefined;

        if (params.strategy === 'keep_local') {
          // Keep local entity unchanged. Unblock outbox entry with updated baseServerVersion for push
          const outboxEntries = await this.db.outbox
            .where('[userId+entityType+entityId]')
            .equals([userId, entityType, entityId])
            .toArray();

          for (const entry of outboxEntries) {
            await this.db.outbox.update(entry.id, {
              state: 'pending',
              baseServerVersion: remoteVersion,
              attemptCount: 0,
              nextRetryAt: Date.now(),
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: undefined,
              updatedAt: Date.now(),
            });
          }

          const existingMeta = await this.db.sync_metadata.get(syncId);
          await this.db.sync_metadata.put({
            id: syncId,
            entityType,
            entityId,
            userId,
            syncState: 'pending',
            serverVersion: remoteVersion,
            serverUpdatedAt: remoteUpdatedAt,
            localRevision: (existingMeta?.localRevision ?? 1) + 1,
            lastSyncedAt: existingMeta?.lastSyncedAt ?? null,
            baseSnapshot: remotePayload,
          });
        } else if (params.strategy === 'keep_remote') {
          // Overwrite local entity with remote state and remove pending local outbox mutation
          if (entityType === 'document') {
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
              boardState: remote.board_state ?? existing?.boardState ?? { nodes: [], edges: [], strokes: [] },
              createdAt: remote.created_at || existing?.createdAt || remoteUpdatedAt,
              updatedAt: remoteUpdatedAt,
              localRevision: existing ? existing.localRevision + 1 : 1,
              isDeleted: false,
              deletedAt: null,
            });
          }

          // Discard pending local outbox entries
          const outboxEntries = await this.db.outbox
            .where('[userId+entityType+entityId]')
            .equals([userId, entityType, entityId])
            .toArray();

          for (const entry of outboxEntries) {
            await this.db.outbox.delete(entry.id);
          }

          await this.db.sync_metadata.put({
            id: syncId,
            entityType,
            entityId,
            userId,
            syncState: 'synced',
            serverVersion: remoteVersion,
            serverUpdatedAt: remoteUpdatedAt,
            localRevision: 1,
            lastSyncedAt: Date.now(),
            baseSnapshot: remotePayload,
          });
        } else if (params.strategy === 'merge_document') {
          if (entityType !== 'document') {
            throw new Error(`merge_document strategy is only supported for documents, got ${entityType}`);
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
                payload: { ...(entry.payload as any), content: mergedContent },
                state: 'pending',
                baseServerVersion: remoteVersion,
                localRevision: nextRevision,
                attemptCount: 0,
                nextRetryAt: Date.now(),
                leaseOwner: null,
                leaseExpiresAt: null,
                lastError: undefined,
                updatedAt: Date.now(),
              });
            }
          } else {
            await this.db.outbox.add({
              id: crypto.randomUUID(),
              userId,
              projectId: existing.projectId,
              entityType: 'document',
              entityId,
              operation: 'update',
              payload: { title: existing.title, content: mergedContent, format: existing.format },
              localRevision: nextRevision,
              baseServerVersion: remoteVersion,
              state: 'pending',
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
          copyEntityId = crypto.randomUUID();

          if (entityType === 'document') {
            const existing = await this.db.documents.get(entityId);
            const copyTitle = params.copyTitle || `${existing?.title || 'Document'} (Conflict Copy)`;

            await this.db.documents.add({
              id: copyEntityId,
              userId,
              projectId: existing?.projectId ?? null,
              folderId: existing?.folderId ?? null,
              title: copyTitle,
              content: existing?.content ?? '',
              format: existing?.format || 'markdown',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              localRevision: 1,
              isDeleted: false,
            });

            await this.db.outbox.add({
              id: crypto.randomUUID(),
              userId,
              projectId: existing?.projectId ?? null,
              entityType: 'document',
              entityId: copyEntityId,
              operation: 'create',
              payload: {
                title: copyTitle,
                content: existing?.content ?? '',
                format: existing?.format || 'markdown',
                folderId: existing?.folderId ?? null,
              },
              localRevision: 1,
              baseServerVersion: null,
              state: 'pending',
              attemptCount: 0,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });

            await this.db.sync_metadata.put({
              id: `document:${copyEntityId}`,
              entityType: 'document',
              entityId: copyEntityId,
              userId,
              syncState: 'pending',
              serverVersion: null,
              serverUpdatedAt: null,
              localRevision: 1,
              lastSyncedAt: null,
            });

            // Revert original document to remote
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
            });
          } else if (entityType === 'system_design') {
            const existing = await this.db.system_designs.get(entityId);
            const copyName = params.copyTitle || `${existing?.name || 'System Design'} (Conflict Copy)`;

            await this.db.system_designs.add({
              id: copyEntityId,
              userId,
              projectId: existing?.projectId ?? '',
              folderId: existing?.folderId ?? null,
              name: copyName,
              boardState: existing?.boardState ?? { nodes: [], edges: [], strokes: [] },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              localRevision: 1,
              isDeleted: false,
            });

            await this.db.outbox.add({
              id: crypto.randomUUID(),
              userId,
              projectId: existing?.projectId ?? '',
              entityType: 'system_design',
              entityId: copyEntityId,
              operation: 'create',
              payload: {
                name: copyName,
                boardState: existing?.boardState ?? { nodes: [], edges: [], strokes: [] },
                folderId: existing?.folderId ?? null,
              },
              localRevision: 1,
              baseServerVersion: null,
              state: 'pending',
              attemptCount: 0,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });

            await this.db.sync_metadata.put({
              id: `system_design:${copyEntityId}`,
              entityType: 'system_design',
              entityId: copyEntityId,
              userId,
              syncState: 'pending',
              serverVersion: null,
              serverUpdatedAt: null,
              localRevision: 1,
              lastSyncedAt: null,
            });

            // Revert original design to remote
            await this.db.system_designs.put({
              id: entityId,
              userId,
              projectId: remote.project_id ?? existing?.projectId ?? '',
              folderId: remote.folder_id ?? existing?.folderId ?? null,
              name: remote.name ?? existing?.name ?? 'New System Design',
              boardState: remote.board_state ?? existing?.boardState ?? { nodes: [], edges: [], strokes: [] },
              createdAt: remote.created_at || existing?.createdAt || remoteUpdatedAt,
              updatedAt: remoteUpdatedAt,
              localRevision: existing ? existing.localRevision + 1 : 1,
              isDeleted: false,
            });
          }

          // Discard pending local outbox entry on the original entity
          const originalOutbox = await this.db.outbox
            .where('[userId+entityType+entityId]')
            .equals([userId, entityType, entityId])
            .toArray();

          for (const entry of originalOutbox) {
            await this.db.outbox.delete(entry.id);
          }

          await this.db.sync_metadata.put({
            id: syncId,
            entityType,
            entityId,
            userId,
            syncState: 'synced',
            serverVersion: remoteVersion,
            serverUpdatedAt: remoteUpdatedAt,
            localRevision: 1,
            lastSyncedAt: Date.now(),
            baseSnapshot: remotePayload,
          });
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
