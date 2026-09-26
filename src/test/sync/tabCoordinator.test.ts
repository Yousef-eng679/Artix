import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TabCoordinator } from '../../lib/sync/tabCoordinator';

describe('TabCoordinator', () => {
  let coordinator: TabCoordinator;

  beforeEach(() => {
    coordinator = new TabCoordinator('test_channel_1');
  });

  afterEach(() => {
    coordinator.destroy();
  });

  it('generates a unique tabId', () => {
    expect(coordinator.getTabId()).toBeDefined();
    expect(typeof coordinator.getTabId()).toBe('string');
  });

  it('reports leader status and handles broadcast messaging', () => {
    expect(typeof coordinator.isLeaderTab()).toBe('boolean');

    const listener = vi.fn();
    const unsub = coordinator.onCrossTabChange(listener);

    // Broadcast a change
    coordinator.broadcastChange({
      entityType: 'document',
      entityId: 'doc-1',
      operation: 'update',
      localRevision: 2,
    });

    unsub();
  });

  it('allows requesting leader sync', () => {
    const syncListener = vi.fn();
    const unsub = coordinator.onSyncRequest(syncListener);

    coordinator.requestLeaderSync();
    expect(syncListener).toHaveBeenCalled();

    unsub();
  });
});
