import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Dexie from 'dexie';
import {
  ArtixDB,
  migrateLegacyArtixDB,
  getStorageEstimate,
  closeAllArtixDBs,
  deleteArtixDB,
} from '@/lib/local/db';
import { UserSyncRuntime, closeUserRuntime } from '@/lib/sync/userSyncRuntime';
import { SyncEngine } from '@/lib/sync/syncEngine';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { PullEngine } from '@/lib/sync/pullEngine';

describe('Phase C11: Storage, Migration & Runtime Safety', () => {
  beforeEach(() => {
    Dexie.dependencies.indexedDB = indexedDB;
    Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  });

  afterEach(async () => {
    await closeUserRuntime();
    await closeAllArtixDBs();
  });

  it('gracefully handles IndexedDB opening failure and enters errored state without crashing', async () => {
    const testDb = new ArtixDB(`artix_test_fail_open_${Date.now()}`);
    vi.spyOn(testDb, 'isOpen').mockReturnValue(false);
    vi.spyOn(testDb, 'open').mockRejectedValue(new DOMException('Access denied in private browsing', 'SecurityError'));

    const runtime = new UserSyncRuntime('user-storage-fail', { db: testDb });

    // Should resolve without unhandled exception
    await expect(runtime.start()).resolves.toBeUndefined();

    const status = runtime.getStatus();
    expect(status.state).toBe('errored');
    expect(status.error).not.toBeNull();
    expect(status.error?.code).toBe('STORAGE_UNAVAILABLE');
    expect(status.error?.fatal).toBe(true);
    expect(status.isStarted).toBe(false);

    await runtime.stop();
  });

  it('handles blocked database upgrade and identifies STORAGE_BLOCKED state', async () => {
    const testDb = new ArtixDB(`artix_test_blocked_${Date.now()}`);
    vi.spyOn(testDb, 'isOpen').mockReturnValue(false);
    const blockedErr = new Error('Database upgrade blocked by another connection');
    blockedErr.name = 'BlockedError';
    vi.spyOn(testDb, 'open').mockRejectedValue(blockedErr);

    const runtime = new UserSyncRuntime('user-storage-blocked', { db: testDb });

    await runtime.start();

    const status = runtime.getStatus();
    expect(status.state).toBe('errored');
    expect(status.error?.code).toBe('STORAGE_BLOCKED');
    expect(status.error?.fatal).toBe(true);

    await runtime.stop();
  });

  it('audits legacy migration failures without silently swallowing errors and sets runtime to degraded', async () => {
    // Seed a record in the legacy database so migration has records to process
    const legacyDb = new ArtixDB('ArtixDB');
    await legacyDb.open();
    await legacyDb.documents.put({
      id: 'doc-legacy-fail-1',
      title: 'Legacy Doc',
      content: 'Legacy Content',
      userId: 'user-mig-fail',
      projectId: 'proj-legacy',
      folderId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const targetDb = new ArtixDB(`artix_test_mig_target_${Date.now()}`);
    await targetDb.open();

    // Cause targetDb transaction to fail
    vi.spyOn(targetDb, 'transaction').mockRejectedValue(new Error('Corrupted legacy record table'));

    const migResult = await migrateLegacyArtixDB(targetDb, 'user-mig-fail');
    expect(migResult.success).toBe(false);
    expect(migResult.error).toBeDefined();
    expect(migResult.error?.message).toContain('Corrupted legacy record table');

    // Test that UserSyncRuntime records migration failure as degraded state
    const runtime = new UserSyncRuntime('user-mig-fail', { db: targetDb });
    await runtime.start();

    const status = runtime.getStatus();
    expect(status.state).toBe('degraded');
    expect(status.isDegraded).toBe(true);
    expect(status.error?.code).toBe('MIGRATION_FAILED');

    await runtime.stop();
    await targetDb.delete();
    await legacyDb.delete();
  });

  it('cooperatively closes open database connection on versionchange event to allow schema upgrade', async () => {
    const dbName = `artix_test_versionchange_${Date.now()}`;
    const testDb = new ArtixDB(dbName);
    await testDb.open();
    expect(testDb.isOpen()).toBe(true);

    const closeSpy = vi.spyOn(testDb, 'close');

    // Simulate versionchange event fired by browser when another tab requests schema upgrade
    testDb.on('versionchange').fire({ newVersion: 2 } as any);

    expect(closeSpy).toHaveBeenCalled();

    await testDb.delete();
  });

  it('handles database closure during active sync execution cleanly without unhandled rejection', async () => {
    const dbName = `artix_test_closed_sync_${Date.now()}`;
    const testDb = new ArtixDB(dbName);
    await testDb.open();

    const outboxRepo = new OutboxRepository(testDb);
    const syncMetadataRepo = new SyncMetadataRepository(testDb);
    const conflictRepo = new ConflictRepository(testDb);
    const pullEngine = new PullEngine({
      supabaseClient: { from: vi.fn() },
      conflictRepo,
      syncMetadataRepo,
    });
    vi.spyOn(pullEngine, 'pullAll').mockResolvedValue(undefined as any);

    const syncEngine = new SyncEngine({
      supabaseClient: { from: vi.fn() },
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
      pullEngine,
    });

    // Close the database to simulate user logout / tab teardown while sync is initiated
    testDb.close();

    // Trigger sync on closed database
    await expect(syncEngine.triggerSync('user-closed-db')).resolves.toBeUndefined();

    syncEngine.destroy();
    await deleteArtixDB(dbName);
  });

  it('accurately evaluates storage quota metrics and identifies healthy storage state', async () => {
    const originalNavigator = globalThis.navigator;

    // Mock navigator.storage.estimate
    vi.stubGlobal('navigator', {
      ...originalNavigator,
      storage: {
        estimate: vi.fn().mockResolvedValue({
          usage: 25 * 1024 * 1024,      // 25MB
          quota: 1000 * 1024 * 1024,    // 1000MB
        }),
      },
    });

    const estimate = await getStorageEstimate();
    expect(estimate.usage).toBe(25 * 1024 * 1024);
    expect(estimate.quota).toBe(1000 * 1024 * 1024);
    expect(estimate.percentUsed).toBeCloseTo(2.5, 1);
    expect(estimate.isHealthy).toBe(true);

    // Mock high storage usage (>90%)
    vi.stubGlobal('navigator', {
      ...originalNavigator,
      storage: {
        estimate: vi.fn().mockResolvedValue({
          usage: 950 * 1024 * 1024,     // 950MB
          quota: 1000 * 1024 * 1024,    // 1000MB
        }),
      },
    });

    const highEstimate = await getStorageEstimate();
    expect(highEstimate.percentUsed).toBeCloseTo(95, 1);
    expect(highEstimate.isHealthy).toBe(false);

    vi.unstubAllGlobals();
  });
});
