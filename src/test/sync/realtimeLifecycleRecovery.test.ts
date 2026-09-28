import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { RealtimeSyncManager } from '@/lib/sync/realtimeSync';
import { UserSyncRuntime, closeUserRuntime } from '@/lib/sync/userSyncRuntime';
import { ArtixDB } from '@/lib/local/db';

describe('Phase C7: Realtime Lifecycle & Recovery', () => {
  let mockSupabase: any;
  let mockSyncEngine: any;
  let mockTabCoordinator: any;
  let registeredCallbacks: Record<string, () => void>;
  let statusCallback: ((status: string, err?: any) => void) | null;
  let userDb: ArtixDB;

  const userId = 'user-realtime-c7';

  beforeEach(async () => {
    registeredCallbacks = {};
    statusCallback = null;

    const channelMock = {
      on: vi.fn().mockImplementation((type: string, filter: any, callback: () => void) => {
        const table = filter?.table || 'default';
        registeredCallbacks[table] = callback;
        return channelMock;
      }),
      subscribe: vi.fn().mockImplementation((cb?: any) => {
        statusCallback = cb;
        if (cb) cb('SUBSCRIBED');
        return channelMock;
      }),
    };

    mockSupabase = {
      channel: vi.fn().mockReturnValue(channelMock),
      removeChannel: vi.fn(),
    };

    mockSyncEngine = {
      triggerSync: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };

    mockTabCoordinator = {
      isLeaderTab: vi.fn().mockReturnValue(true),
      onCrossTabChange: vi.fn().mockReturnValue(() => {}),
      onSyncRequest: vi.fn().mockReturnValue(() => {}),
      destroy: vi.fn(),
    };

    userDb = new ArtixDB(`ArtixDB_test_${userId}_${Date.now()}`);
    await userDb.open();
  });

  afterEach(async () => {
    await closeUserRuntime();
    if (userDb.isOpen()) {
      await userDb.delete();
    }
  });

  it('attaches RealtimeSyncManager to UserSyncRuntime lifecycle (starts on start, stops on stop)', async () => {
    const realtimeManager = new RealtimeSyncManager({
      supabaseClient: mockSupabase,
      syncEngine: mockSyncEngine,
      tabCoordinator: mockTabCoordinator,
    });

    const runtime = new UserSyncRuntime(userId, {
      supabaseClient: mockSupabase,
      db: userDb,
      tabCoordinator: mockTabCoordinator,
      realtimeSync: realtimeManager,
    });

    expect(realtimeManager.isConnected()).toBe(false);

    // 1. Runtime starts -> Realtime connects
    await runtime.start();
    expect(realtimeManager.isConnected()).toBe(true);
    expect(mockSupabase.channel).toHaveBeenCalledWith(`user-sync-${userId}`);

    // 2. Runtime stops -> Realtime disconnects
    await runtime.stop();
    expect(realtimeManager.isConnected()).toBe(false);
    expect(mockSupabase.removeChannel).toHaveBeenCalled();
  });

  it('debounces rapid burst of Postgres change events', async () => {
    const realtimeManager = new RealtimeSyncManager({
      supabaseClient: mockSupabase,
      syncEngine: mockSyncEngine,
      tabCoordinator: mockTabCoordinator,
      debounceMs: 50,
    });

    realtimeManager.start(userId);
    mockSyncEngine.triggerSync.mockClear();

    // Fire 5 rapid events within 10ms
    registeredCallbacks['documents']?.();
    registeredCallbacks['system_designs']?.();
    registeredCallbacks['workspace_folders']?.();
    registeredCallbacks['sync_changes']?.();
    registeredCallbacks['documents']?.();

    // Leading edge fired immediately on first event
    expect(mockSyncEngine.triggerSync).toHaveBeenCalledTimes(1);

    // Wait for trailing debounce period (60ms)
    await new Promise((r) => setTimeout(r, 70));

    // Trailing edge fired once for the burst
    expect(mockSyncEngine.triggerSync).toHaveBeenCalledTimes(2);

    realtimeManager.stop();
  });

  it('triggers catch-up pull when Realtime channel reconnects after timeout/error', async () => {
    const realtimeManager = new RealtimeSyncManager({
      supabaseClient: mockSupabase,
      syncEngine: mockSyncEngine,
      tabCoordinator: mockTabCoordinator,
    });

    realtimeManager.start(userId);
    expect(realtimeManager.isConnected()).toBe(true);

    mockSyncEngine.triggerSync.mockClear();

    // Simulate connection drop / timeout
    realtimeManager.handleChannelStatusChange('TIMED_OUT');
    expect(realtimeManager.isConnected()).toBe(false);
    expect(mockSyncEngine.triggerSync).not.toHaveBeenCalled();

    // Simulate reconnection (status -> SUBSCRIBED)
    realtimeManager.handleChannelStatusChange('SUBSCRIBED');
    expect(realtimeManager.isConnected()).toBe(true);

    // Invariant: Reconnect MUST schedule a catch-up pull to drain missed events
    expect(mockSyncEngine.triggerSync).toHaveBeenCalledWith(userId);

    realtimeManager.stop();
  });

  it('system correctness is preserved when Realtime is completely absent / disabled', async () => {
    // Supabase client with no realtime channel capability
    const clientWithoutRealtime = {
      from: vi.fn(),
      channel: undefined, // Realtime disabled
    };

    const realtimeManager = new RealtimeSyncManager({
      supabaseClient: clientWithoutRealtime,
      syncEngine: mockSyncEngine,
      tabCoordinator: mockTabCoordinator,
    });

    const runtime = new UserSyncRuntime(userId, {
      supabaseClient: clientWithoutRealtime,
      db: userDb,
      tabCoordinator: mockTabCoordinator,
      realtimeSync: realtimeManager,
    });

    // Should not throw or fail startup
    await expect(runtime.start()).resolves.toBeUndefined();
    expect(realtimeManager.isConnected()).toBe(false);

    // Stop cleanly
    await expect(runtime.stop()).resolves.toBeUndefined();
  });
});
