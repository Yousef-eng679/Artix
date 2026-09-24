import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getTabStorageKey,
  loadWorkspaceTabs,
  saveWorkspaceTabs,
  clearWorkspaceTabs,
  TAB_STORAGE_KEY_PREFIX,
} from '@/lib/workspace/tabPersistence';
import { WorkspaceTab } from '@/types/workspace';

describe('tabPersistence adapter', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('generates the correct project-scoped storage key', () => {
    expect(getTabStorageKey('proj-123')).toBe(`${TAB_STORAGE_KEY_PREFIX}proj-123`);
  });

  it('saves and loads tabs round-trip', () => {
    const tabs: WorkspaceTab[] = [
      { id: 'document:doc-1', resourceKind: 'document', resourceId: 'doc-1' },
      { id: 'design:des-1', resourceKind: 'design', resourceId: 'des-1' },
    ];

    saveWorkspaceTabs('proj-1', tabs);
    const loaded = loadWorkspaceTabs('proj-1');

    expect(loaded).toEqual(tabs);
  });

  it('maintains strict project isolation', () => {
    const tabsA: WorkspaceTab[] = [
      { id: 'document:doc-a', resourceKind: 'document', resourceId: 'doc-a' },
    ];
    const tabsB: WorkspaceTab[] = [
      { id: 'design:des-b', resourceKind: 'design', resourceId: 'des-b' },
    ];

    saveWorkspaceTabs('proj-a', tabsA);
    saveWorkspaceTabs('proj-b', tabsB);

    expect(loadWorkspaceTabs('proj-a')).toEqual(tabsA);
    expect(loadWorkspaceTabs('proj-b')).toEqual(tabsB);
    expect(loadWorkspaceTabs('proj-c')).toBeNull();
  });

  it('returns null if no data is stored', () => {
    expect(loadWorkspaceTabs('empty-proj')).toBeNull();
  });

  it('handles empty projectId safely', () => {
    expect(loadWorkspaceTabs('')).toBeNull();
    // save/clear with empty string should not throw
    saveWorkspaceTabs('', [{ id: 'document:1', resourceKind: 'document', resourceId: '1' }]);
    clearWorkspaceTabs('');
  });

  it('gracefully handles corrupt JSON in localStorage', () => {
    localStorage.setItem(getTabStorageKey('proj-corrupt'), '{ not a valid json');
    const result = loadWorkspaceTabs('proj-corrupt');
    expect(result).toBeNull();
  });

  it('gracefully handles non-array JSON in localStorage', () => {
    localStorage.setItem(getTabStorageKey('proj-obj'), JSON.stringify({ not: 'an array' }));
    const result = loadWorkspaceTabs('proj-obj');
    expect(result).toBeNull();
  });

  it('filters out invalid or malformed tab items from array', () => {
    const malformedData = [
      { id: 'document:doc-1', resourceKind: 'document', resourceId: 'doc-1' }, // valid
      { id: 'bad-1', resourceKind: 'unknown_kind', resourceId: 'id-1' }, // bad kind
      { id: 123, resourceKind: 'document', resourceId: 'id-2' }, // bad id type
      { id: 'bad-2', resourceKind: 'design' }, // missing resourceId
      null, // null entry
      'string entry', // primitive entry
      { id: 'design:des-2', resourceKind: 'design', resourceId: 'des-2' }, // valid
    ];

    localStorage.setItem(getTabStorageKey('proj-filter'), JSON.stringify(malformedData));
    const result = loadWorkspaceTabs('proj-filter');

    expect(result).toEqual([
      { id: 'document:doc-1', resourceKind: 'document', resourceId: 'doc-1' },
      { id: 'design:des-2', resourceKind: 'design', resourceId: 'des-2' },
    ]);
  });

  it('clears tabs for a specific project without affecting other projects', () => {
    saveWorkspaceTabs('proj-1', [
      { id: 'document:doc-1', resourceKind: 'document', resourceId: 'doc-1' },
    ]);
    saveWorkspaceTabs('proj-2', [
      { id: 'document:doc-2', resourceKind: 'document', resourceId: 'doc-2' },
    ]);

    clearWorkspaceTabs('proj-1');

    expect(loadWorkspaceTabs('proj-1')).toBeNull();
    expect(loadWorkspaceTabs('proj-2')).toHaveLength(1);
  });

  it('silently catches QuotaExceededError on save', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });

    expect(() => {
      saveWorkspaceTabs('proj-quota', [
        { id: 'document:doc-1', resourceKind: 'document', resourceId: 'doc-1' },
      ]);
    }).not.toThrow();
  });
});
