import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { TabCoordinator, resetTabCoordinatorsForTesting } from '@/lib/sync/tabCoordinator';
import {
  UserSyncRuntime,
  openUserRuntime,
  closeUserRuntime,
  getActiveUserRuntime,
} from '@/lib/sync/userSyncRuntime';
import { ArtixDB, getUserArtixDB } from '@/lib/local/db';

describe('Phase 8: Multi-Tab Hardening & User Sync Runtime Lifecycle', () => {
  beforeEach(async () => {
    resetTabCoordinatorsForTesting();
    await closeUserRuntime();
  });

  afterEach(async () => {
    await closeUserRuntime();
    resetTabCoordinatorsForTesting();
  });

  describe('TabCoordinator Multi-Tab Coordination', () => {
    it('isolates channels between different users', () => {
      const coordA = new TabCoordinator(undefined, 'user-a-hash');
      const coordB = new TabCoordinator(undefined, 'user-b-hash');

      expect((coordA as any).channelName).toContain('user-a-hash');
      expect((coordB as any).channelName).toContain('user-b-hash');
      expect((coordA as any).channelName).not.toBe((coordB as any).channelName);

      coordA.destroy();
      coordB.destroy();
    });

    it('suppresses duplicate broadcast change events within 3s window', () => {
      const coord = new TabCoordinator('test_dedup_channel');
      const listener = vi.fn();
      coord.onCrossTabChange(listener);

      const event = {
        type: 'ENTITY_CHANGED' as const,
        tabId: 'peer-tab-1',
        entityType: 'document' as const,
        entityId: 'doc-dup-1',
        operation: 'update' as const,
        localRevision: 3,
      };

      // First broadcast -> delivered to listener
      (coord as any).handleChannelMessage(event);
      expect(listener).toHaveBeenCalledTimes(1);

      // Rapid duplicate broadcast -> suppressed by signature cache
      (coord as any).handleChannelMessage(event);
      expect(listener).toHaveBeenCalledTimes(1);

      // Event with different revision -> delivered
      (coord as any).handleChannelMessage({
        ...event,
        localRevision: 4,
      });
      expect(listener).toHaveBeenCalledTimes(2);

      coord.destroy();
    });

    it('standby tab delegates sync to leader tab on requestLeaderSync', () => {
      const leaderCoord = new TabCoordinator('test_sync_req_channel');
      leaderCoord.setLeaderForTesting(true);

      const standbyCoord = new TabCoordinator('test_sync_req_channel');
      standbyCoord.setLeaderForTesting(false);

      const leaderSyncHandler = vi.fn();
      leaderCoord.onSyncRequest(leaderSyncHandler);

      // Simulate standby sending request to leader
      (leaderCoord as any).handleChannelMessage({
        type: 'REQUEST_SYNC',
        tabId: standbyCoord.getTabId(),
      });

      expect(leaderSyncHandler).toHaveBeenCalledTimes(1);

      leaderCoord.destroy();
      standbyCoord.destroy();
    });
  });

  describe('UserSyncRuntime Lifecycle', () => {
    it('initializes user-partitioned database, repositories, and sync engine', async () => {
      const userId = 'usr-lifecycle-1';
      const userDb = new ArtixDB(`TestDB_Runtime_${Date.now()}`);
      await userDb.open();

      const runtime = new UserSyncRuntime(userId, { db: userDb });
      expect(runtime.userId).toBe(userId);
      expect(runtime.db).toBe(userDb);
      expect(runtime.documentRepo).toBeDefined();
      expect(runtime.folderRepo).toBeDefined();
      expect(runtime.systemDesignRepo).toBeDefined();
      expect(runtime.outboxRepo).toBeDefined();
      expect(runtime.syncMetadataRepo).toBeDefined();
      expect(runtime.conflictRepo).toBeDefined();
      expect(runtime.syncEngine).toBeDefined();
      expect(runtime.pullEngine).toBeDefined();
      expect(runtime.tabCoordinator).toBeDefined();

      await runtime.start();
      expect(runtime.isActive()).toBe(true);

      await runtime.stop();
      expect(runtime.isActive()).toBe(false);

      await userDb.delete();
    });

    it('openUserRuntime caches active user runtime and handles user switches cleanly', async () => {
      const userA = 'user-alice';
      const userB = 'user-bob';

      const dbA = new ArtixDB(`TestDB_Alice_${Date.now()}`);
      const dbB = new ArtixDB(`TestDB_Bob_${Date.now()}`);
      await dbA.open();
      await dbB.open();

      // Open runtime for Alice
      const runtimeA = await openUserRuntime(userA, { db: dbA });
      expect(runtimeA.userId).toBe(userA);
      expect(runtimeA.isActive()).toBe(true);
      expect(getActiveUserRuntime()).toBe(runtimeA);

      // Calling openUserRuntime again with same user returns existing runtime
      const sameRuntime = await openUserRuntime(userA, { db: dbA });
      expect(sameRuntime).toBe(runtimeA);

      // Switch to Bob -> Alice's runtime is automatically stopped
      const runtimeB = await openUserRuntime(userB, { db: dbB });
      expect(runtimeA.isActive()).toBe(false);
      expect(runtimeB.userId).toBe(userB);
      expect(runtimeB.isActive()).toBe(true);
      expect(getActiveUserRuntime()).toBe(runtimeB);

      // Logout / close runtime
      await closeUserRuntime(userB);
      expect(runtimeB.isActive()).toBe(false);
      expect(getActiveUserRuntime()).toBeUndefined();

      await dbA.delete();
      await dbB.delete();
    });
  });
});
