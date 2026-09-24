import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useWorkspaceNavigation } from './useWorkspaceNavigation';
import { ResourceKind, WorkspaceResource, WorkspaceTab } from '@/types/workspace';
import {
  makeTabId,
  parseTabId,
  openTab as pureOpenTab,
  closeTab as pureCloseTab,
  closeOtherTabs as pureCloseOtherTabs,
  closeAllTabs as pureCloseAllTabs,
  reconcileTabs as pureReconcileTabs,
} from '@/lib/workspace/workspaceTabs';
import { loadWorkspaceTabs, saveWorkspaceTabs } from '@/lib/workspace/tabPersistence';

export interface UseWorkspaceTabsResult {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  activeTab: WorkspaceTab | null;
  openTab: (resource: { kind: ResourceKind; id: string }) => void;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  closeOtherTabs: (tabId: string) => void;
  closeAllTabs: () => void;
}

/**
 * Hook to manage workspace tabs, synchronized with URL navigation,
 * project-scoped persistence, and resource lifecycle reconciliation.
 */
export function useWorkspaceTabs(
  projectId: string,
  resources: WorkspaceResource[] = [],
  isLoaded: boolean = true,
): UseWorkspaceTabsResult {
  const [searchParams] = useSearchParams();
  const { openDocument, openDesign, openOverview } = useWorkspaceNavigation();

  // Active tab ID derived directly from URL search params (Single Source of Truth)
  const rawDocId = searchParams.get('doc');
  const rawDesignId = searchParams.get('design');

  const activeTabId = useMemo<string | null>(() => {
    if (rawDocId) return makeTabId('document', rawDocId);
    if (rawDesignId) return makeTabId('design', rawDesignId);
    return null;
  }, [rawDocId, rawDesignId]);

  // Tab list state - initialized from project persistence + current URL active resource
  const [tabs, setTabs] = useState<WorkspaceTab[]>(() => {
    const persisted = loadWorkspaceTabs(projectId) ?? [];
    if (rawDocId) {
      const docTabId = makeTabId('document', rawDocId);
      if (!persisted.some((t) => t.id === docTabId)) {
        persisted.push({ id: docTabId, resourceKind: 'document', resourceId: rawDocId });
      }
    } else if (rawDesignId) {
      const desTabId = makeTabId('design', rawDesignId);
      if (!persisted.some((t) => t.id === desTabId)) {
        persisted.push({ id: desTabId, resourceKind: 'design', resourceId: rawDesignId });
      }
    }
    return persisted;
  });

  // Track project changes to reload persisted tabs if project ID changes
  const prevProjectIdRef = useRef(projectId);
  useEffect(() => {
    if (prevProjectIdRef.current !== projectId) {
      prevProjectIdRef.current = projectId;
      const loaded = loadWorkspaceTabs(projectId) ?? [];
      setTabs(loaded);
    }
  }, [projectId]);

  // Synchronize deep-link: if URL changes to a resource not yet in tabs, add it
  useEffect(() => {
    if (!activeTabId) return;
    const parsed = parseTabId(activeTabId);
    if (!parsed) return;

    setTabs((prev) => {
      if (prev.some((t) => t.id === activeTabId)) {
        return prev;
      }
      return [
        ...prev,
        {
          id: activeTabId,
          resourceKind: parsed.resourceKind,
          resourceId: parsed.resourceId,
        },
      ];
    });
  }, [activeTabId]);

  // Persist tabs whenever tabs array changes
  useEffect(() => {
    if (projectId) {
      saveWorkspaceTabs(projectId, tabs);
    }
  }, [projectId, tabs]);

  // Reconcile tabs when resources list changes (e.g. resource deletion)
  // Only execute reconciliation when resources have finished loading
  useEffect(() => {
    if (!isLoaded) return;
    if (resources.length === 0 && tabs.length === 0) return;

    const validIds = new Set(resources.map((r) => r.id));

    setTabs((prev) => {
      const reconciled = pureReconcileTabs({ tabs: prev, activeTabId }, validIds);
      if (reconciled.tabs.length !== prev.length) {
        // If the active tab was among the deleted tabs, update navigation
        if (activeTabId && !reconciled.tabs.some((t) => t.id === activeTabId)) {
          if (reconciled.activeTabId) {
            const nextParsed = parseTabId(reconciled.activeTabId);
            if (nextParsed?.resourceKind === 'document') {
              openDocument(nextParsed.resourceId);
            } else if (nextParsed?.resourceKind === 'design') {
              openDesign(nextParsed.resourceId);
            }
          } else {
            openOverview();
          }
        }
        return reconciled.tabs;
      }
      return prev;
    });
  }, [isLoaded, resources, activeTabId, openDocument, openDesign, openOverview, tabs.length]);

  // Active tab object
  const activeTab = useMemo(() => {
    if (!activeTabId) return null;
    return tabs.find((t) => t.id === activeTabId) ?? null;
  }, [tabs, activeTabId]);

  // User Action: Open resource in tabs
  const openTab = useCallback(
    (resource: { kind: ResourceKind; id: string }) => {
      setTabs((prev) => {
        const nextState = pureOpenTab({ tabs: prev, activeTabId }, resource);
        return nextState.tabs;
      });
      if (resource.kind === 'document') {
        openDocument(resource.id);
      } else {
        openDesign(resource.id);
      }
    },
    [activeTabId, openDocument, openDesign],
  );

  // User Action: Activate an already open tab
  const activateTab = useCallback(
    (tabId: string) => {
      if (tabId === activeTabId) return;
      const target = tabs.find((t) => t.id === tabId);
      if (!target) return;
      if (target.resourceKind === 'document') {
        openDocument(target.resourceId);
      } else {
        openDesign(target.resourceId);
      }
    },
    [tabs, activeTabId, openDocument, openDesign],
  );

  // User Action: Close a tab
  const closeTab = useCallback(
    (tabId: string) => {
      const targetIndex = tabs.findIndex((t) => t.id === tabId);
      if (targetIndex === -1) return;

      const nextState = pureCloseTab({ tabs, activeTabId }, tabId);
      setTabs(nextState.tabs);

      if (activeTabId === tabId) {
        if (nextState.activeTabId) {
          const nextParsed = parseTabId(nextState.activeTabId);
          if (nextParsed?.resourceKind === 'document') {
            openDocument(nextParsed.resourceId);
          } else if (nextParsed?.resourceKind === 'design') {
            openDesign(nextParsed.resourceId);
          }
        } else {
          openOverview();
        }
      }
    },
    [tabs, activeTabId, openDocument, openDesign, openOverview],
  );

  // User Action: Close other tabs
  const closeOtherTabs = useCallback(
    (tabId: string) => {
      const target = tabs.find((t) => t.id === tabId);
      if (!target) return;
      const nextState = pureCloseOtherTabs({ tabs, activeTabId }, tabId);
      setTabs(nextState.tabs);
      if (activeTabId !== tabId) {
        if (target.resourceKind === 'document') {
          openDocument(target.resourceId);
        } else {
          openDesign(target.resourceId);
        }
      }
    },
    [tabs, activeTabId, openDocument, openDesign],
  );

  // User Action: Close all tabs
  const closeAllTabs = useCallback(() => {
    const nextState = pureCloseAllTabs();
    setTabs(nextState.tabs);
    openOverview();
  }, [openOverview]);

  return {
    tabs,
    activeTabId,
    activeTab,
    openTab,
    activateTab,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
  };
}
