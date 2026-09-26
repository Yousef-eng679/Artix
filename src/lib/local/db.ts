import Dexie, { type EntityTable } from 'dexie';
import {
  LocalDocument,
  LocalSystemDesign,
  LocalWorkspaceFolder,
  OutboxEntry,
  SyncMetadata,
  ConflictRecord,
  DatabaseMeta,
} from './types';

export class ArtixDB extends Dexie {
  documents!: EntityTable<LocalDocument, 'id'>;
  system_designs!: EntityTable<LocalSystemDesign, 'id'>;
  workspace_folders!: EntityTable<LocalWorkspaceFolder, 'id'>;
  outbox!: EntityTable<OutboxEntry, 'id'>;
  sync_metadata!: EntityTable<SyncMetadata, 'id'>;
  conflicts!: EntityTable<ConflictRecord, 'id'>;
  database_meta!: EntityTable<DatabaseMeta, 'key'>;

  constructor(dbName = 'ArtixDB') {
    super(dbName);

    this.version(1).stores({
      documents: 'id, [userId+projectId], userId, projectId, folderId, localRevision, updatedAt, isDeleted',
      system_designs: 'id, [userId+projectId], userId, projectId, folderId, localRevision, updatedAt, isDeleted',
      workspace_folders: 'id, [userId+projectId], userId, projectId, parentFolderId, name, localRevision, updatedAt, isDeleted',
      outbox: 'id, [userId+entityType+entityId], userId, state, createdAt, localRevision',
      sync_metadata: 'id, [userId+entityType], userId, entityId, syncState, localRevision, lastSyncedAt',
      conflicts: 'id, [userId+entityType+entityId], detectedAt',
      database_meta: 'key, updatedAt',
    });
  }
}

// Instance cache for singleton or user-scoped databases
const dbInstances = new Map<string, ArtixDB>();

/**
 * Returns an instance of ArtixDB.
 * Defaults to 'ArtixDB', or can be user-scoped e.g. `ArtixDB_${userId}`.
 */
export function getArtixDB(dbName = 'ArtixDB'): ArtixDB {
  let instance = dbInstances.get(dbName);
  if (!instance) {
    instance = new ArtixDB(dbName);
    dbInstances.set(dbName, instance);
  }
  return instance;
}

/**
 * Safely closes and removes a database instance from the cache.
 */
export async function closeArtixDB(dbName = 'ArtixDB'): Promise<void> {
  const instance = dbInstances.get(dbName);
  if (instance) {
    instance.close();
    dbInstances.delete(dbName);
  }
}

/**
 * Deletes the database entirely (primarily for testing and cache reset).
 */
export async function deleteArtixDB(dbName = 'ArtixDB'): Promise<void> {
  await closeArtixDB(dbName);
  await Dexie.delete(dbName);
}

export interface StorageEstimateResult {
  usage: number;
  quota: number;
  percentUsed: number;
  isHealthy: boolean;
}

/**
 * Checks the browser storage quota and returns usage metrics.
 */
export async function getStorageEstimate(): Promise<StorageEstimateResult> {
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      const usage = estimate.usage ?? 0;
      const quota = estimate.quota ?? 0;
      const percentUsed = quota > 0 ? (usage / quota) * 100 : 0;
      return {
        usage,
        quota,
        percentUsed,
        isHealthy: percentUsed < 90,
      };
    } catch {
      // Fallback if estimate fails
    }
  }

  return {
    usage: 0,
    quota: 0,
    percentUsed: 0,
    isHealthy: true,
  };
}
