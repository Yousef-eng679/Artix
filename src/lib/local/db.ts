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

    this.on('versionchange', () => {
      console.warn(`[ArtixDB] Database schema version change detected for ${dbName}. Closing connection to permit upgrade.`);
      this.close();
    });

    this.on('blocked', () => {
      console.warn(`[ArtixDB] Database upgrade for ${dbName} is blocked by another open tab.`);
    });
  }
}

// Instance cache for singleton or user-scoped databases
const dbInstances = new Map<string, ArtixDB>();

/**
 * Computes a deterministic 32-bit FNV-1a hash formatted as an 8-character hex string.
 * Stable across sessions, browsers, and platforms.
 */
export function getUserScopeHash(userId: string): string {
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    // 32-bit FNV prime 16777619
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Returns the physical IndexedDB database name for a given user ID.
 */
export function getUserDbName(userId?: string | null): string {
  const trimmed = userId?.trim();
  if (!trimmed) {
    return 'ArtixDB_v2_anonymous';
  }
  return `ArtixDB_v2_${getUserScopeHash(trimmed)}`;
}

let activeUserScope: string | null = null;

export function setActiveUserScope(userId?: string | null): void {
  activeUserScope = userId?.trim() || null;
}

export function getActiveUserScope(): string | null {
  return activeUserScope;
}

/**
 * Returns an instance of ArtixDB.
 * Defaults to the active user's scoped database, or 'ArtixDB' if no active user is set.
 */
export function getArtixDB(dbName?: string): ArtixDB {
  const targetDbName = dbName || (activeUserScope ? getUserDbName(activeUserScope) : 'ArtixDB');
  let instance = dbInstances.get(targetDbName);
  if (!instance) {
    instance = new ArtixDB(targetDbName);
    dbInstances.set(targetDbName, instance);
  }
  return instance;
}

/**
 * Returns the user-scoped ArtixDB instance, maintaining an in-memory instance cache.
 */
export function getUserArtixDB(userId?: string | null): ArtixDB {
  if (userId) {
    setActiveUserScope(userId);
  }
  const dbName = getUserDbName(userId);
  return getArtixDB(dbName);
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
 * Safely closes and evicts a user's database instance from the cache.
 */
export async function closeUserArtixDB(userId?: string | null): Promise<void> {
  const dbName = getUserDbName(userId);
  await closeArtixDB(dbName);
}

/**
 * Closes and evicts all cached database instances.
 */
export async function closeAllArtixDBs(): Promise<void> {
  const closePromises: Promise<void>[] = [];
  for (const [, instance] of dbInstances.entries()) {
    instance.close();
    closePromises.push(Promise.resolve());
  }
  dbInstances.clear();
  await Promise.all(closePromises);
}

/**
 * Deletes the database entirely (primarily for testing and cache reset).
 * If dbName is omitted, cleanly closes and deletes all cached/known user databases.
 */
export async function deleteArtixDB(dbName?: string): Promise<void> {
  if (dbName) {
    await closeArtixDB(dbName);
    await Dexie.delete(dbName);
  } else {
    const names = new Set<string>(dbInstances.keys());
    names.add('ArtixDB');
    names.add('ArtixDB_v2_anonymous');
    if (activeUserScope) {
      names.add(getUserDbName(activeUserScope));
    }
    await closeAllArtixDBs();
    for (const name of names) {
      await Dexie.delete(name);
    }
    activeUserScope = null;
  }
}

/**
 * Deletes a user's database instance entirely.
 */
export async function deleteUserArtixDB(userId?: string | null): Promise<void> {
  const dbName = getUserDbName(userId);
  await deleteArtixDB(dbName);
}

export interface MigrationResult {
  success: boolean;
  migrated: boolean;
  recordsCount: number;
  error?: Error;
}

/**
 * Idempotently migrates records belonging to userId from legacy 'ArtixDB' to the user-scoped DB.
 */
export async function migrateLegacyArtixDB(targetDb: ArtixDB, userId: string): Promise<MigrationResult> {
  if (!userId) {
    return { success: true, migrated: false, recordsCount: 0 };
  }

  const legacyDb = getArtixDB('ArtixDB');
  try {
    const [docs, designs, folders, outbox, metadata] = await Promise.all([
      legacyDb.documents.where('userId').equals(userId).toArray().catch(() => []),
      legacyDb.system_designs.where('userId').equals(userId).toArray().catch(() => []),
      legacyDb.workspace_folders.where('userId').equals(userId).toArray().catch(() => []),
      legacyDb.outbox.where('userId').equals(userId).toArray().catch(() => []),
      legacyDb.sync_metadata.where('userId').equals(userId).toArray().catch(() => []),
    ]);

    const totalCount = docs.length + designs.length + folders.length + outbox.length + metadata.length;
    if (totalCount === 0) {
      return { success: true, migrated: false, recordsCount: 0 };
    }

    let alreadyCompleted = false;
    await targetDb.transaction('rw', [
      targetDb.documents,
      targetDb.system_designs,
      targetDb.workspace_folders,
      targetDb.outbox,
      targetDb.sync_metadata,
      targetDb.database_meta,
    ], async () => {
      const meta = await targetDb.database_meta.get('legacy_migration');
      if (meta && meta.value === 'completed') {
        alreadyCompleted = true;
        return;
      }

      if (docs.length > 0) await targetDb.documents.bulkPut(docs);
      if (designs.length > 0) await targetDb.system_designs.bulkPut(designs);
      if (folders.length > 0) await targetDb.workspace_folders.bulkPut(folders);
      if (outbox.length > 0) await targetDb.outbox.bulkPut(outbox);
      if (metadata.length > 0) await targetDb.sync_metadata.bulkPut(metadata);

      await targetDb.database_meta.put({
        key: 'legacy_migration',
        value: 'completed',
        updatedAt: Date.now(),
      });
    });

    return {
      success: true,
      migrated: !alreadyCompleted,
      recordsCount: alreadyCompleted ? 0 : totalCount,
    };
  } catch (err: any) {
    console.warn('[ArtixDB] Legacy migration encountered error:', err);
    return {
      success: false,
      migrated: false,
      recordsCount: 0,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
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
