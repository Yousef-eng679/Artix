import { ResourceKind, WorkspaceTab, WorkspaceTabsState } from '@/types/workspace';

/**
 * Creates a deterministic unique tab identity from resource kind and ID.
 * Example: 'document:doc-123' or 'design:des-456'
 */
export function makeTabId(kind: ResourceKind, resourceId: string): string {
  return `${kind}:${resourceId}`;
}

/**
 * Parses a tab ID back into its constituent resourceKind and resourceId.
 * Returns null if the tab ID is malformed.
 */
export function parseTabId(tabId: string): { resourceKind: ResourceKind; resourceId: string } | null {
  const colonIndex = tabId.indexOf(':');
  if (colonIndex === -1) return null;
  const kind = tabId.slice(0, colonIndex);
  const resourceId = tabId.slice(colonIndex + 1);
  if ((kind === 'document' || kind === 'design') && resourceId.length > 0) {
    return { resourceKind: kind, resourceId };
  }
  return null;
}

/**
 * Finds an open tab for a given resource kind and ID.
 */
export function findTabForResource(
  tabs: WorkspaceTab[],
  kind: ResourceKind,
  resourceId: string,
): WorkspaceTab | null {
  const targetId = makeTabId(kind, resourceId);
  return tabs.find((t) => t.id === targetId) ?? null;
}

/**
 * Determines the next tab to activate when a tab is closed.
 * Invariant: Prefers the right neighbor; if closed tab was last, prefers the left neighbor;
 * if no tabs remain, returns null.
 */
export function getNextTabAfterClose(
  tabs: WorkspaceTab[],
  closedTabId: string,
): WorkspaceTab | null {
  const index = tabs.findIndex((t) => t.id === closedTabId);
  if (index === -1 || tabs.length <= 1) {
    return null;
  }
  if (index < tabs.length - 1) {
    return tabs[index + 1];
  }
  return tabs[index - 1];
}

/**
 * Pure function to open a resource in tabs.
 * Invariant: Prevents duplicate tabs. If tab already exists, it is activated.
 * If not, the new tab is appended to the end and activated.
 */
export function openTab(
  state: WorkspaceTabsState,
  resource: { kind: ResourceKind; id: string },
): WorkspaceTabsState {
  const targetId = makeTabId(resource.kind, resource.id);
  const existingTab = state.tabs.find((t) => t.id === targetId);

  if (existingTab) {
    if (state.activeTabId === targetId) {
      return state;
    }
    return {
      ...state,
      activeTabId: targetId,
    };
  }

  const newTab: WorkspaceTab = {
    id: targetId,
    resourceKind: resource.kind,
    resourceId: resource.id,
  };

  return {
    tabs: [...state.tabs, newTab],
    activeTabId: targetId,
  };
}

/**
 * Pure function to activate an existing tab.
 * If the tab does not exist, returns the state unchanged.
 */
export function activateTab(state: WorkspaceTabsState, tabId: string): WorkspaceTabsState {
  if (state.activeTabId === tabId) {
    return state;
  }
  const exists = state.tabs.some((t) => t.id === tabId);
  if (!exists) {
    return state;
  }
  return {
    ...state,
    activeTabId: tabId,
  };
}

/**
 * Pure function to close a tab.
 * Invariants:
 * - If closing the active tab, deterministically selects the next tab (right then left).
 * - If closing an inactive tab, keeps the current active tab.
 * - If the closed tab does not exist, returns state unchanged.
 */
export function closeTab(state: WorkspaceTabsState, tabId: string): WorkspaceTabsState {
  const exists = state.tabs.some((t) => t.id === tabId);
  if (!exists) {
    return state;
  }

  const remainingTabs = state.tabs.filter((t) => t.id !== tabId);

  if (state.activeTabId === tabId) {
    const nextTab = getNextTabAfterClose(state.tabs, tabId);
    return {
      tabs: remainingTabs,
      activeTabId: nextTab ? nextTab.id : null,
    };
  }

  return {
    tabs: remainingTabs,
    activeTabId: state.activeTabId,
  };
}

/**
 * Pure function to close all tabs except the specified tab.
 * If the specified tab does not exist, returns state unchanged.
 */
export function closeOtherTabs(state: WorkspaceTabsState, tabId: string): WorkspaceTabsState {
  const target = state.tabs.find((t) => t.id === tabId);
  if (!target) {
    return state;
  }
  return {
    tabs: [target],
    activeTabId: tabId,
  };
}

/**
 * Pure function to close all tabs.
 */
export function closeAllTabs(): WorkspaceTabsState {
  return {
    tabs: [],
    activeTabId: null,
  };
}

/**
 * Pure function to reconcile tabs against valid resource IDs.
 * Called when resources are loaded or deleted.
 * - Removes tabs whose resource no longer exists in validResourceIds.
 * - If the active tab was removed, selects the nearest remaining tab or null.
 */
export function reconcileTabs(
  state: WorkspaceTabsState,
  validResourceIds: Set<string>,
): WorkspaceTabsState {
  const originalActiveIndex = state.activeTabId
    ? state.tabs.findIndex((t) => t.id === state.activeTabId)
    : -1;

  const remainingTabs = state.tabs.filter((t) => validResourceIds.has(t.resourceId));

  // If no tabs changed
  if (remainingTabs.length === state.tabs.length) {
    return state;
  }

  // Active tab is still present
  if (state.activeTabId && remainingTabs.some((t) => t.id === state.activeTabId)) {
    return {
      tabs: remainingTabs,
      activeTabId: state.activeTabId,
    };
  }

  // Active tab was removed or was already null
  if (remainingTabs.length === 0) {
    return {
      tabs: [],
      activeTabId: null,
    };
  }

  // Deterministically pick nearest replacement if active tab was removed
  if (originalActiveIndex !== -1) {
    // Try to find the tab that is at or after the original index
    const nextTab = state.tabs
      .slice(originalActiveIndex + 1)
      .find((t) => remainingTabs.some((r) => r.id === t.id));
    if (nextTab) {
      return { tabs: remainingTabs, activeTabId: nextTab.id };
    }
    // Otherwise look before
    const prevTab = [...state.tabs.slice(0, originalActiveIndex)]
      .reverse()
      .find((t) => remainingTabs.some((r) => r.id === t.id));
    if (prevTab) {
      return { tabs: remainingTabs, activeTabId: prevTab.id };
    }
  }

  return {
    tabs: remainingTabs,
    activeTabId: remainingTabs[0].id,
  };
}
