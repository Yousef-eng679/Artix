import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import React from 'react';
import { useWorkspaceTabs } from '@/hooks/useWorkspaceTabs';
import { saveWorkspaceTabs, loadWorkspaceTabs } from '@/lib/workspace/tabPersistence';
import { WorkspaceResource } from '@/types/workspace';

function createWrapper(initialUrl: string = '/projects/p1') {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <MemoryRouter initialEntries={[initialUrl]}>{children}</MemoryRouter>;
  };
}

// Helper hook to inspect current location alongside tabs
function useWorkspaceTabsWithLocation(
  projectId: string,
  resources: WorkspaceResource[] = [],
  isLoaded: boolean = true,
) {
  const tabsResult = useWorkspaceTabs(projectId, resources, isLoaded);
  const location = useLocation();
  return { ...tabsResult, location };
}

describe('useWorkspaceTabs hook', () => {
  const mockResources: WorkspaceResource[] = [
    {
      id: 'doc-1',
      projectId: 'p1',
      title: 'Doc 1',
      kind: 'document',
      updatedAt: '2026-09-24T00:00:00Z',
      folderId: null,
    },
    {
      id: 'doc-2',
      projectId: 'p1',
      title: 'Doc 2',
      kind: 'document',
      updatedAt: '2026-09-24T00:00:00Z',
      folderId: null,
    },
    {
      id: 'des-1',
      projectId: 'p1',
      title: 'Design 1',
      kind: 'design',
      updatedAt: '2026-09-24T00:00:00Z',
      folderId: null,
    },
  ];

  beforeEach(() => {
    localStorage.clear();
  });

  it('initializes with empty tabs and null activeTabId when no query and no persistence', () => {
    const { result } = renderHook(() => useWorkspaceTabs('p1', mockResources), {
      wrapper: createWrapper('/projects/p1'),
    });

    expect(result.current.tabs).toEqual([]);
    expect(result.current.activeTabId).toBeNull();
    expect(result.current.activeTab).toBeNull();
  });

  it('restores tabs from project persistence on mount', () => {
    saveWorkspaceTabs('p1', [
      { id: 'document:doc-1', resourceKind: 'document', resourceId: 'doc-1' },
      { id: 'design:des-1', resourceKind: 'design', resourceId: 'des-1' },
    ]);

    const { result } = renderHook(() => useWorkspaceTabs('p1', mockResources), {
      wrapper: createWrapper('/projects/p1'),
    });

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.tabs[0].id).toBe('document:doc-1');
    expect(result.current.tabs[1].id).toBe('design:des-1');
    expect(result.current.activeTabId).toBeNull(); // No resource in URL -> overview mode
  });

  it('automatically adds deep-linked resource from URL to tabs on mount', () => {
    const { result } = renderHook(() => useWorkspaceTabs('p1', mockResources), {
      wrapper: createWrapper('/projects/p1?doc=doc-1'),
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0]).toEqual({
      id: 'document:doc-1',
      resourceKind: 'document',
      resourceId: 'doc-1',
    });
    expect(result.current.activeTabId).toBe('document:doc-1');
    expect(result.current.activeTab?.id).toBe('document:doc-1');
  });

  it('opens a new resource, adds tab, updates URL and active tab', () => {
    const { result } = renderHook(() => useWorkspaceTabsWithLocation('p1', mockResources), {
      wrapper: createWrapper('/projects/p1'),
    });

    act(() => {
      result.current.openTab({ kind: 'document', id: 'doc-1' });
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].id).toBe('document:doc-1');
    expect(result.current.activeTabId).toBe('document:doc-1');
    expect(result.current.location.search).toBe('?doc=doc-1');

    // Open second resource (design)
    act(() => {
      result.current.openTab({ kind: 'design', id: 'des-1' });
    });

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.tabs[1].id).toBe('design:des-1');
    expect(result.current.activeTabId).toBe('design:des-1');
    expect(result.current.location.search).toBe('?design=des-1');

    // Persistence should be updated
    const saved = loadWorkspaceTabs('p1');
    expect(saved).toHaveLength(2);
  });

  it('re-opening an already open tab does not duplicate it and switches active tab', () => {
    const { result } = renderHook(() => useWorkspaceTabsWithLocation('p1', mockResources), {
      wrapper: createWrapper('/projects/p1'),
    });

    act(() => {
      result.current.openTab({ kind: 'document', id: 'doc-1' });
      result.current.openTab({ kind: 'design', id: 'des-1' });
    });
    expect(result.current.tabs).toHaveLength(2);

    act(() => {
      result.current.openTab({ kind: 'document', id: 'doc-1' });
    });

    expect(result.current.tabs).toHaveLength(2); // Still 2 tabs
    expect(result.current.activeTabId).toBe('document:doc-1');
    expect(result.current.location.search).toBe('?doc=doc-1');
  });

  it('activates an existing tab by tabId', () => {
    const { result } = renderHook(() => useWorkspaceTabsWithLocation('p1', mockResources), {
      wrapper: createWrapper('/projects/p1'),
    });

    act(() => {
      result.current.openTab({ kind: 'document', id: 'doc-1' });
      result.current.openTab({ kind: 'document', id: 'doc-2' });
    });
    expect(result.current.activeTabId).toBe('document:doc-2');

    act(() => {
      result.current.activateTab('document:doc-1');
    });

    expect(result.current.activeTabId).toBe('document:doc-1');
    expect(result.current.location.search).toBe('?doc=doc-1');
  });

  it('closes an inactive tab without changing active tab or URL', () => {
    const { result } = renderHook(() => useWorkspaceTabsWithLocation('p1', mockResources), {
      wrapper: createWrapper('/projects/p1'),
    });

    act(() => {
      result.current.openTab({ kind: 'document', id: 'doc-1' });
      result.current.openTab({ kind: 'document', id: 'doc-2' });
    });
    expect(result.current.activeTabId).toBe('document:doc-2');

    act(() => {
      result.current.closeTab('document:doc-1');
    });

    expect(result.current.tabs.map((t) => t.id)).toEqual(['document:doc-2']);
    expect(result.current.activeTabId).toBe('document:doc-2');
    expect(result.current.location.search).toBe('?doc=doc-2');
  });

  it('closes active tab and selects right neighbor', () => {
    const { result } = renderHook(() => useWorkspaceTabsWithLocation('p1', mockResources), {
      wrapper: createWrapper('/projects/p1'),
    });

    act(() => {
      result.current.openTab({ kind: 'document', id: 'doc-1' });
      result.current.openTab({ kind: 'document', id: 'doc-2' });
      result.current.openTab({ kind: 'design', id: 'des-1' });
    });
    act(() => {
      result.current.activateTab('document:doc-2');
    });
    expect(result.current.activeTabId).toBe('document:doc-2');

    act(() => {
      result.current.closeTab('document:doc-2');
    });

    expect(result.current.tabs.map((t) => t.id)).toEqual(['document:doc-1', 'design:des-1']);
    expect(result.current.activeTabId).toBe('design:des-1');
    expect(result.current.location.search).toBe('?design=des-1');
  });

  it('closes last active tab and selects left neighbor', () => {
    const { result } = renderHook(() => useWorkspaceTabsWithLocation('p1', mockResources), {
      wrapper: createWrapper('/projects/p1'),
    });

    act(() => {
      result.current.openTab({ kind: 'document', id: 'doc-1' });
      result.current.openTab({ kind: 'document', id: 'doc-2' });
    });
    expect(result.current.activeTabId).toBe('document:doc-2');

    act(() => {
      result.current.closeTab('document:doc-2');
    });

    expect(result.current.tabs.map((t) => t.id)).toEqual(['document:doc-1']);
    expect(result.current.activeTabId).toBe('document:doc-1');
    expect(result.current.location.search).toBe('?doc=doc-1');
  });

  it('closing the only tab navigates back to overview', () => {
    const { result } = renderHook(() => useWorkspaceTabsWithLocation('p1', mockResources), {
      wrapper: createWrapper('/projects/p1'),
    });

    act(() => {
      result.current.openTab({ kind: 'document', id: 'doc-1' });
    });

    act(() => {
      result.current.closeTab('document:doc-1');
    });

    expect(result.current.tabs).toEqual([]);
    expect(result.current.activeTabId).toBeNull();
    expect(result.current.location.search).toBe('');
  });

  it('closeOtherTabs keeps only target tab', () => {
    const { result } = renderHook(() => useWorkspaceTabsWithLocation('p1', mockResources), {
      wrapper: createWrapper('/projects/p1'),
    });

    act(() => {
      result.current.openTab({ kind: 'document', id: 'doc-1' });
      result.current.openTab({ kind: 'document', id: 'doc-2' });
      result.current.openTab({ kind: 'design', id: 'des-1' });
    });

    act(() => {
      result.current.closeOtherTabs('document:doc-2');
    });

    expect(result.current.tabs.map((t) => t.id)).toEqual(['document:doc-2']);
    expect(result.current.activeTabId).toBe('document:doc-2');
    expect(result.current.location.search).toBe('?doc=doc-2');
  });

  it('closeAllTabs clears all tabs and navigates to overview', () => {
    const { result } = renderHook(() => useWorkspaceTabsWithLocation('p1', mockResources), {
      wrapper: createWrapper('/projects/p1'),
    });

    act(() => {
      result.current.openTab({ kind: 'document', id: 'doc-1' });
      result.current.openTab({ kind: 'design', id: 'des-1' });
    });

    act(() => {
      result.current.closeAllTabs();
    });

    expect(result.current.tabs).toEqual([]);
    expect(result.current.activeTabId).toBeNull();
    expect(result.current.location.search).toBe('');
  });

  it('reconciles deleted resources when isLoaded is true', () => {
    const initialResources = [...mockResources];
    const { result, rerender } = renderHook(
      ({ resources, isLoaded }: { resources: WorkspaceResource[]; isLoaded: boolean }) =>
        useWorkspaceTabsWithLocation('p1', resources, isLoaded),
      {
        wrapper: createWrapper('/projects/p1'),
        initialProps: { resources: initialResources, isLoaded: true },
      },
    );

    act(() => {
      result.current.openTab({ kind: 'document', id: 'doc-1' });
      result.current.openTab({ kind: 'document', id: 'doc-2' });
    });
    expect(result.current.tabs).toHaveLength(2);

    // Simulate deleting doc-2 (active tab)
    const remainingResources = initialResources.filter((r) => r.id !== 'doc-2');
    rerender({ resources: remainingResources, isLoaded: true });

    expect(result.current.tabs.map((t) => t.id)).toEqual(['document:doc-1']);
    expect(result.current.activeTabId).toBe('document:doc-1');
    expect(result.current.location.search).toBe('?doc=doc-1');
  });

  it('does NOT reconcile when isLoaded is false (loading state protection)', () => {
    saveWorkspaceTabs('p1', [
      { id: 'document:doc-1', resourceKind: 'document', resourceId: 'doc-1' },
    ]);

    const { result, rerender } = renderHook(
      ({ resources, isLoaded }: { resources: WorkspaceResource[]; isLoaded: boolean }) =>
        useWorkspaceTabsWithLocation('p1', resources, isLoaded),
      {
        wrapper: createWrapper('/projects/p1'),
        initialProps: { resources: [], isLoaded: false },
      },
    );

    // Even though resources is empty, tabs should NOT be wiped because isLoaded is false!
    expect(result.current.tabs).toHaveLength(1);

    // Now when isLoaded becomes true with resources loaded
    rerender({ resources: mockResources, isLoaded: true });
    expect(result.current.tabs).toHaveLength(1);
  });
});
