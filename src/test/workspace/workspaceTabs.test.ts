import { describe, it, expect } from 'vitest';
import {
  makeTabId,
  parseTabId,
  findTabForResource,
  getNextTabAfterClose,
  openTab,
  activateTab,
  closeTab,
  closeOtherTabs,
  closeAllTabs,
  reconcileTabs,
} from '@/lib/workspace/workspaceTabs';
import { WorkspaceTabsState } from '@/types/workspace';

describe('workspaceTabs pure functions', () => {
  describe('makeTabId and parseTabId', () => {
    it('creates deterministic tab IDs', () => {
      expect(makeTabId('document', 'doc-123')).toBe('document:doc-123');
      expect(makeTabId('design', 'des-456')).toBe('design:des-456');
    });

    it('distinguishes document and design with identical raw IDs', () => {
      expect(makeTabId('document', '123')).not.toBe(makeTabId('design', '123'));
    });

    it('roundtrips valid tab IDs', () => {
      const parsedDoc = parseTabId('document:doc-123');
      expect(parsedDoc).toEqual({ resourceKind: 'document', resourceId: 'doc-123' });

      const parsedDes = parseTabId('design:des-456');
      expect(parsedDes).toEqual({ resourceKind: 'design', resourceId: 'des-456' });
    });

    it('returns null for malformed tab IDs', () => {
      expect(parseTabId('invalid-no-colon')).toBeNull();
      expect(parseTabId('folder:123')).toBeNull();
      expect(parseTabId('document:')).toBeNull();
      expect(parseTabId('')).toBeNull();
    });
  });

  describe('findTabForResource', () => {
    const tabs = [
      { id: 'document:doc-1', resourceKind: 'document' as const, resourceId: 'doc-1' },
      { id: 'design:des-1', resourceKind: 'design' as const, resourceId: 'des-1' },
    ];

    it('finds existing tab by kind and ID', () => {
      expect(findTabForResource(tabs, 'document', 'doc-1')).toEqual(tabs[0]);
      expect(findTabForResource(tabs, 'design', 'des-1')).toEqual(tabs[1]);
    });

    it('returns null if not found', () => {
      expect(findTabForResource(tabs, 'document', 'non-existent')).toBeNull();
      expect(findTabForResource(tabs, 'design', 'doc-1')).toBeNull();
    });
  });

  describe('getNextTabAfterClose', () => {
    const tabs = [
      { id: 'document:doc-1', resourceKind: 'document' as const, resourceId: 'doc-1' },
      { id: 'document:doc-2', resourceKind: 'document' as const, resourceId: 'doc-2' },
      { id: 'document:doc-3', resourceKind: 'document' as const, resourceId: 'doc-3' },
    ];

    it('returns right neighbor when closing first tab', () => {
      const next = getNextTabAfterClose(tabs, 'document:doc-1');
      expect(next?.id).toBe('document:doc-2');
    });

    it('returns right neighbor when closing middle tab', () => {
      const next = getNextTabAfterClose(tabs, 'document:doc-2');
      expect(next?.id).toBe('document:doc-3');
    });

    it('returns left neighbor when closing last tab', () => {
      const next = getNextTabAfterClose(tabs, 'document:doc-3');
      expect(next?.id).toBe('document:doc-2');
    });

    it('returns null when closing the only tab', () => {
      const single = [tabs[0]];
      expect(getNextTabAfterClose(single, 'document:doc-1')).toBeNull();
    });

    it('returns null if closed tab is not in list', () => {
      expect(getNextTabAfterClose(tabs, 'document:unknown')).toBeNull();
    });
  });

  describe('openTab', () => {
    const initial: WorkspaceTabsState = {
      tabs: [],
      activeTabId: null,
    };

    it('opens the first tab and marks it active', () => {
      const s1 = openTab(initial, { kind: 'document', id: 'doc-1' });
      expect(s1.tabs).toHaveLength(1);
      expect(s1.tabs[0]).toEqual({
        id: 'document:doc-1',
        resourceKind: 'document',
        resourceId: 'doc-1',
      });
      expect(s1.activeTabId).toBe('document:doc-1');
    });

    it('appends second tab and activates it', () => {
      const s1 = openTab(initial, { kind: 'document', id: 'doc-1' });
      const s2 = openTab(s1, { kind: 'design', id: 'des-1' });
      expect(s2.tabs).toHaveLength(2);
      expect(s2.tabs[1].id).toBe('design:des-1');
      expect(s2.activeTabId).toBe('design:des-1');
    });

    it('prevents duplicate tabs and activates the existing tab', () => {
      const s1 = openTab(initial, { kind: 'document', id: 'doc-1' });
      const s2 = openTab(s1, { kind: 'design', id: 'des-1' });
      const s3 = openTab(s2, { kind: 'document', id: 'doc-1' });

      expect(s3.tabs).toHaveLength(2); // No duplicate added!
      expect(s3.activeTabId).toBe('document:doc-1'); // Re-activated
    });

    it('returns exact same reference if opening the currently active tab', () => {
      const s1 = openTab(initial, { kind: 'document', id: 'doc-1' });
      const s2 = openTab(s1, { kind: 'document', id: 'doc-1' });
      expect(s2).toBe(s1);
    });

    it('allows document and design with identical IDs to exist as separate tabs', () => {
      const s1 = openTab(initial, { kind: 'document', id: 'shared-id' });
      const s2 = openTab(s1, { kind: 'design', id: 'shared-id' });
      expect(s2.tabs).toHaveLength(2);
      expect(s2.tabs[0].id).toBe('document:shared-id');
      expect(s2.tabs[1].id).toBe('design:shared-id');
      expect(s2.activeTabId).toBe('design:shared-id');
    });
  });

  describe('activateTab', () => {
    const state: WorkspaceTabsState = {
      tabs: [
        { id: 'document:doc-1', resourceKind: 'document', resourceId: 'doc-1' },
        { id: 'design:des-1', resourceKind: 'design', resourceId: 'des-1' },
      ],
      activeTabId: 'document:doc-1',
    };

    it('activates an existing tab', () => {
      const next = activateTab(state, 'design:des-1');
      expect(next.activeTabId).toBe('design:des-1');
    });

    it('returns exact same reference if already active', () => {
      const next = activateTab(state, 'document:doc-1');
      expect(next).toBe(state);
    });

    it('returns exact same state if tab does not exist', () => {
      const next = activateTab(state, 'document:ghost');
      expect(next).toBe(state);
    });
  });

  describe('closeTab', () => {
    const state: WorkspaceTabsState = {
      tabs: [
        { id: 'document:doc-1', resourceKind: 'document', resourceId: 'doc-1' },
        { id: 'document:doc-2', resourceKind: 'document', resourceId: 'doc-2' },
        { id: 'document:doc-3', resourceKind: 'document', resourceId: 'doc-3' },
      ],
      activeTabId: 'document:doc-2',
    };

    it('closes middle active tab and activates right neighbor', () => {
      const next = closeTab(state, 'document:doc-2');
      expect(next.tabs.map((t) => t.id)).toEqual(['document:doc-1', 'document:doc-3']);
      expect(next.activeTabId).toBe('document:doc-3');
    });

    it('closes last active tab and activates left neighbor', () => {
      const activeLast: WorkspaceTabsState = { ...state, activeTabId: 'document:doc-3' };
      const next = closeTab(activeLast, 'document:doc-3');
      expect(next.tabs.map((t) => t.id)).toEqual(['document:doc-1', 'document:doc-2']);
      expect(next.activeTabId).toBe('document:doc-2');
    });

    it('closes inactive tab without changing active tab', () => {
      const next = closeTab(state, 'document:doc-1');
      expect(next.tabs.map((t) => t.id)).toEqual(['document:doc-2', 'document:doc-3']);
      expect(next.activeTabId).toBe('document:doc-2');
    });

    it('closes only remaining tab and sets activeTabId to null', () => {
      const single: WorkspaceTabsState = {
        tabs: [{ id: 'document:doc-1', resourceKind: 'document', resourceId: 'doc-1' }],
        activeTabId: 'document:doc-1',
      };
      const next = closeTab(single, 'document:doc-1');
      expect(next.tabs).toEqual([]);
      expect(next.activeTabId).toBeNull();
    });

    it('returns same state if tabId not in list', () => {
      const next = closeTab(state, 'document:unknown');
      expect(next).toBe(state);
    });
  });

  describe('closeOtherTabs', () => {
    const state: WorkspaceTabsState = {
      tabs: [
        { id: 'document:doc-1', resourceKind: 'document', resourceId: 'doc-1' },
        { id: 'document:doc-2', resourceKind: 'document', resourceId: 'doc-2' },
        { id: 'document:doc-3', resourceKind: 'document', resourceId: 'doc-3' },
      ],
      activeTabId: 'document:doc-1',
    };

    it('keeps only the target tab and activates it', () => {
      const next = closeOtherTabs(state, 'document:doc-2');
      expect(next.tabs.map((t) => t.id)).toEqual(['document:doc-2']);
      expect(next.activeTabId).toBe('document:doc-2');
    });

    it('returns same state if target tab not in list', () => {
      const next = closeOtherTabs(state, 'document:ghost');
      expect(next).toBe(state);
    });
  });

  describe('closeAllTabs', () => {
    it('returns empty tabs array and null activeTabId', () => {
      const res = closeAllTabs();
      expect(res.tabs).toEqual([]);
      expect(res.activeTabId).toBeNull();
    });
  });

  describe('reconcileTabs', () => {
    const state: WorkspaceTabsState = {
      tabs: [
        { id: 'document:doc-1', resourceKind: 'document', resourceId: 'doc-1' },
        { id: 'document:doc-2', resourceKind: 'document', resourceId: 'doc-2' },
        { id: 'design:des-1', resourceKind: 'design', resourceId: 'des-1' },
      ],
      activeTabId: 'document:doc-2',
    };

    it('returns same state reference if all tab resources are valid', () => {
      const valid = new Set(['doc-1', 'doc-2', 'des-1', 'other-doc']);
      const next = reconcileTabs(state, valid);
      expect(next).toBe(state);
    });

    it('removes deleted inactive tab while keeping activeTabId intact', () => {
      const valid = new Set(['doc-2', 'des-1']);
      const next = reconcileTabs(state, valid);
      expect(next.tabs.map((t) => t.id)).toEqual(['document:doc-2', 'design:des-1']);
      expect(next.activeTabId).toBe('document:doc-2');
    });

    it('reconciles deleted active tab by picking next remaining neighbor', () => {
      // doc-2 was active and got deleted
      const valid = new Set(['doc-1', 'des-1']);
      const next = reconcileTabs(state, valid);
      expect(next.tabs.map((t) => t.id)).toEqual(['document:doc-1', 'design:des-1']);
      // des-1 was the right neighbor of doc-2
      expect(next.activeTabId).toBe('design:des-1');
    });

    it('reconciles deleted active tab at the end by picking previous neighbor', () => {
      const activeLast: WorkspaceTabsState = { ...state, activeTabId: 'design:des-1' };
      const valid = new Set(['doc-1', 'doc-2']);
      const next = reconcileTabs(activeLast, valid);
      expect(next.tabs.map((t) => t.id)).toEqual(['document:doc-1', 'document:doc-2']);
      expect(next.activeTabId).toBe('document:doc-2');
    });

    it('sets activeTabId to null if all open resources are deleted', () => {
      const valid = new Set(['other-resource']);
      const next = reconcileTabs(state, valid);
      expect(next.tabs).toEqual([]);
      expect(next.activeTabId).toBeNull();
    });
  });
});
