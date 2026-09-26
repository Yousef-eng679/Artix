import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeSyncManager } from '../../lib/sync/realtimeSync';

describe('RealtimeSyncManager', () => {
  let mockSupabase: any;
  let mockSyncEngine: any;
  let mockTabCoordinator: any;
  let manager: RealtimeSyncManager;

  beforeEach(() => {
    const channelMock = {
      on: vi.fn().mockReturnThis(),
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
  });

  it('stops and removes channel on stop()', () => {
    manager.start('user-realtime-1');
    manager.stop();

    expect(mockSupabase.removeChannel).toHaveBeenCalled();
  });
});
