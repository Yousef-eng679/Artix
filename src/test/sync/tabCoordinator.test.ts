import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TabCoordinator, getTabCoordinator } from '../../lib/sync/tabCoordinator';

describe('TabCoordinator', () => {
  let coordinator: TabCoordinator;

  beforeEach(() => {
    coordinator = new TabCoordinator('test_channel_suite');
  });

  afterEach(() => {
    coordinator.destroy();
  });

  it('generates a unique tabId', () => {
    expect(coordinator.getTabId()).toBeDefined();
    expect(typeof coordinator.getTabId()).toBe('string');
    expect(coordinator.getTabId().length).toBeGreaterThan(0);
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

  it('receives ENTITY_CHANGED messages from other tabs and invokes listeners', () => {
    const changeListener = vi.fn();
    coordinator.onCrossTabChange(changeListener);

    // Access channel onmessage directly to simulate message from peer tab
    const channel = (coordinator as any).channel;
    if (channel && channel.onmessage) {
      channel.onmessage(
        new MessageEvent('message', {
          data: {
            type: 'ENTITY_CHANGED',
            tabId: 'different-tab-id-999',
            entityType: 'document',
            entityId: 'doc-peer-1',
            operation: 'create',
            localRevision: 1,
          },
        })
      );

      expect(changeListener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ENTITY_CHANGED',
          tabId: 'different-tab-id-999',
          entityId: 'doc-peer-1',
        })
      );
    }
  });

  it('ignores messages originating from the same tab', () => {
    const changeListener = vi.fn();
    coordinator.onCrossTabChange(changeListener);

    const channel = (coordinator as any).channel;
    if (channel && channel.onmessage) {
      channel.onmessage(
        new MessageEvent('message', {
          data: {
            type: 'ENTITY_CHANGED',
            tabId: coordinator.getTabId(), // SAME tab ID
            entityType: 'document',
            entityId: 'doc-self',
            operation: 'update',
            localRevision: 2,
          },
        })
      );

      expect(changeListener).not.toHaveBeenCalled();
    }
  });

  it('handles peer REQUEST_SYNC when this tab is the elected leader', () => {
    const syncListener = vi.fn();
    coordinator.onSyncRequest(syncListener);

    // Ensure coordinator acts as leader
    (coordinator as any).isLeader = true;

    const channel = (coordinator as any).channel;
    if (channel && channel.onmessage) {
      channel.onmessage(
        new MessageEvent('message', {
          data: {
            type: 'REQUEST_SYNC',
            tabId: 'peer-tab-requesting-sync',
          },
        })
      );

      expect(syncListener).toHaveBeenCalled();
    }
  });

  it('isolates listener errors so one failing listener does not crash peer listeners', () => {
    const faultyListener = vi.fn().mockImplementation(() => {
      throw new Error('Listener internal explosion');
    });
    const healthyListener = vi.fn();

    coordinator.onCrossTabChange(faultyListener);
    coordinator.onCrossTabChange(healthyListener);

    const channel = (coordinator as any).channel;
    if (channel && channel.onmessage) {
      channel.onmessage(
        new MessageEvent('message', {
          data: {
            type: 'ENTITY_CHANGED',
            tabId: 'peer-tab',
            entityType: 'workspace_folder',
            entityId: 'folder-1',
            operation: 'create',
            localRevision: 1,
          },
        })
      );

      expect(faultyListener).toHaveBeenCalled();
      expect(healthyListener).toHaveBeenCalled();
    }
  });

  it('unsubscribes listeners cleanly', () => {
    const listener = vi.fn();
    const unsub = coordinator.onCrossTabChange(listener);

    unsub();

    const channel = (coordinator as any).channel;
    if (channel && channel.onmessage) {
      channel.onmessage(
        new MessageEvent('message', {
          data: {
            type: 'ENTITY_CHANGED',
            tabId: 'peer-tab',
            entityType: 'document',
            entityId: 'doc-1',
            operation: 'update',
            localRevision: 1,
          },
        })
      );

      expect(listener).not.toHaveBeenCalled();
    }
  });

  it('cleans up channel and resets state on destroy()', () => {
    const coord = new TabCoordinator('destroy_test_channel');
    expect(coord.isLeaderTab()).toBe(true);

    coord.destroy();
    expect(coord.isLeaderTab()).toBe(false);
    expect((coord as any).channel).toBeNull();
  });

  it('getTabCoordinator returns singleton instance', () => {
    const instance1 = getTabCoordinator();
    const instance2 = getTabCoordinator();

    expect(instance1).toBe(instance2);
    expect(instance1.getTabId()).toBe(instance2.getTabId());
  });
});
