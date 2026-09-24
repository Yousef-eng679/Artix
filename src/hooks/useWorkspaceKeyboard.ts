import { useEffect } from 'react';
import { WorkspaceTab } from '@/types/workspace';

export interface UseWorkspaceKeyboardOptions {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  enabled?: boolean;
}

/**
 * Centralized keyboard shortcut hook for workspace tabs.
 *
 * Supported shortcuts:
 * - Ctrl/Cmd + W: Close active tab
 * - Ctrl/Cmd + Tab: Next tab (wraps around)
 * - Ctrl/Cmd + Shift + Tab: Previous tab (wraps around)
 * - Ctrl/Cmd + 1..9: Activate tab by 1-based index
 *
 * Safeguards:
 * - Disabled when any modal dialog is open
 * - Ignores regular input/textarea focus (except inside Monaco editor)
 */
export function useWorkspaceKeyboard({
  tabs,
  activeTabId,
  onActivateTab,
  onCloseTab,
  enabled = true,
}: UseWorkspaceKeyboardOptions) {
  useEffect(() => {
    if (!enabled || tabs.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 1. Never intercept when a modal or dialog is open
      const isModalOpen = Boolean(document.querySelector('[role="dialog"], [role="alertdialog"]'));
      if (isModalOpen) return;

      // 2. Ignore when focus is inside a standard text input / search input
      const target = e.target instanceof HTMLElement ? e.target : null;
      const isMonaco = target ? Boolean(target.closest('.monaco-editor')) : false;
      const isNormalInput =
        target ? (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') && !isMonaco : false;
      if (isNormalInput) return;

      const isModifier = e.ctrlKey || e.metaKey;
      if (!isModifier) return;

      // Ctrl/Cmd + W -> Close active tab
      if (e.key.toLowerCase() === 'w' && !e.shiftKey && !e.altKey) {
        if (activeTabId) {
          e.preventDefault();
          e.stopPropagation();
          onCloseTab(activeTabId);
        }
        return;
      }

      // Ctrl/Cmd + Tab -> Next tab / Ctrl/Cmd + Shift + Tab -> Previous tab
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        if (tabs.length <= 1) return;

        const currentIndex = activeTabId ? tabs.findIndex((t) => t.id === activeTabId) : -1;

        if (e.shiftKey) {
          // Previous tab (wrapping around)
          const prevIndex = currentIndex <= 0 ? tabs.length - 1 : currentIndex - 1;
          onActivateTab(tabs[prevIndex].id);
        } else {
          // Next tab (wrapping around)
          const nextIndex = currentIndex === -1 || currentIndex >= tabs.length - 1 ? 0 : currentIndex + 1;
          onActivateTab(tabs[nextIndex].id);
        }
        return;
      }

      // Ctrl/Cmd + 1..9 -> Activate tab by 1-based index
      if (!e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        const index = parseInt(e.key, 10) - 1;
        if (index < tabs.length) {
          e.preventDefault();
          e.stopPropagation();
          onActivateTab(tabs[index].id);
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, tabs, activeTabId, onActivateTab, onCloseTab]);
}
