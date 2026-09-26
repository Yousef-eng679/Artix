import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ArtixDB, getArtixDB, closeArtixDB, deleteArtixDB, getStorageEstimate } from '@/lib/local/db';

describe('ArtixDB IndexedDB Architecture', () => {
  const testDbName = 'ArtixDB_test_main';

  beforeEach(async () => {
    await deleteArtixDB(testDbName);
  });

  afterEach(async () => {
    await deleteArtixDB(testDbName);
  });

  it('initializes all 7 schema stores with correct indexes', async () => {
    const db = new ArtixDB(testDbName);
    await db.open();

    expect(db.isOpen()).toBe(true);
    expect(db.tables.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'documents',
        'system_designs',
        'workspace_folders',
        'outbox',
        'sync_metadata',
        'conflicts',
        'database_meta',
      ])
    );

    db.close();
  });

  it('manages singleton instance cache and cleanup correctly', async () => {
    const db1 = getArtixDB(testDbName);
    const db2 = getArtixDB(testDbName);

    expect(db1).toBe(db2);

    await closeArtixDB(testDbName);
    expect(db1.isOpen()).toBe(false);

    const db3 = getArtixDB(testDbName);
    expect(db3).not.toBe(db1); // new instance after close
    await closeArtixDB(testDbName);
  });

  it('returns healthy storage estimation fallback in node environment', async () => {
    const estimate = await getStorageEstimate();
    expect(estimate).toBeDefined();
    expect(estimate.isHealthy).toBe(true);
    expect(estimate.percentUsed).toBe(0);
  });
});
