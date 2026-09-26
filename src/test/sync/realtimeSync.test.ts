import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeSyncManager } from '../../lib/sync/realtimeSync';

describe('RealtimeSyncManager', () => {
  let mockSupabase: any;
  let mockSyncEngine: any;
  let mockTabCoordinator: any;
  let registeredCallbacks: Record<string, () => void>;
  let manager: RealtimeSyncManager;

  beforeEach(() => {
    registeredCallbacks = {};

    const channelMock = {
      on: vi.fn().mockImplementation((type: string, filter: any, callback: () => void) => {
        const table = filter?.table || 'default';
        registeredCallbacks[table] = callback;
        return channelMock;
      }),
      subscribe: vi.fn().mockReturnThis(),
    };

    mockSupabase = {
      channel: vi.fn().mockReturnValue(channelMock),
      removeChannel: vi.fn(),
    };

    mockSyncEngine = {
      triggerSync: vi.fn().mockResolvedValue(undefined),
    };

    mockTabCoordinator = {
      isLeaderTab: vi.fn().mockReturnValue(true),
    };

    manager = new RealtimeSyncManager({
      supabaseClient: mockSupabase,
      syncEngine: mockSyncEngine,
      tabCoordinator: mockTabCoordinator,
    });
  });

  afterEach(() => {
    manager.stop();
  });

  it('subscribes to postgres_changes channels for documents, designs, and folders', () => {
    manager.start('user-realtime-1');

    expect(mockSupabase.channel).toHaveBeenCalledWith('user-sync-user-realtime-1');
    expect(registeredCallbacks['documents']).toBeDefined();
    expect(registeredCallbacks['system_designs']).toBeDefined();
    expect(registeredCallbacks['workspace_folders']).toBeDefined();
  });

  it('triggers sync on remote change when this tab is the leader', async () => {
    manager.start('user-realtime-1');

    // Simulate Supabase postgres_changes event on documents table
    registeredCallbacks['documents']();

    expect(mockTabCoordinator.isLeaderTab).toHaveBeenCalled();
    expect(mockSyncEngine.triggerSync).toHaveBeenCalledWith('user-realtime-1');
  });

  it('does NOT trigger sync on remote change when this tab is NOT the leader', () => {
    mockTabCoordinator.isLeaderTab.mockReturnValue(false);

    manager.start('user-realtime-1');

    // Simulate remote change
    registeredCallbacks['system_designs']();

    expect(mockTabCoordinator.isLeaderTab).toHaveBeenCalled();
    expect(mockSyncEngine.triggerSync).not.toHaveBeenCalled();
  });

  it('handles start(userId) idempotently when called multiple times with the same user', () => {
    manager.start('user-idempotent');
    manager.start('user-idempotent');

    expect(mockSupabase.channel).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes existing channel when switching user IDs', () => {
    manager.start('user-alpha');
    expect(mockSupabase.channel).toHaveBeenCalledWith('user-sync-user-alpha');

    manager.start('user-beta');
    expect(mockSupabase.removeChannel).toHaveBeenCalled();
    expect(mockSupabase.channel).toHaveBeenCalledWith('user-sync-user-beta');
  });

  it('handles triggerSync rejection gracefully without unhandled promise crash', async () => {
    mockSyncEngine.triggerSync.mockRejectedValue(new Error('Sync failure in realtime trigger'));

    manager.start('user-error-test');

    // Calling callback should not throw
    expect(() => {
      registeredCallbacks['workspace_folders']();
    }).not.toThrow();
  });

  it('stops and removes channel on stop()', () => {
    manager.start('user-realtime-1');
    manager.stop();

    expect(mockSupabase.removeChannel).toHaveBeenCalled();
  });
});
