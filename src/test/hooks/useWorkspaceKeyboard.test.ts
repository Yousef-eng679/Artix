import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWorkspaceKeyboard } from '@/hooks/useWorkspaceKeyboard';
import { WorkspaceTab } from '@/types/workspace';

describe('useWorkspaceKeyboard hook', () => {
  const mockTabs: WorkspaceTab[] = [
    { id: 'document:doc-1', resourceKind: 'document', resourceId: 'doc-1' },
    { id: 'document:doc-2', resourceKind: 'document', resourceId: 'doc-2' },
    { id: 'design:des-1', resourceKind: 'design', resourceId: 'des-1' },
  ];

  let onActivateTab: ReturnType<typeof vi.fn>;
  let onCloseTab: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onActivateTab = vi.fn();
    onCloseTab = vi.fn();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('closes active tab on Ctrl+W', () => {
    renderHook(() =>
      useWorkspaceKeyboard({
        tabs: mockTabs,
        activeTabId: 'document:doc-2',
        onActivateTab,
        onCloseTab,
      }),
    );

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, cancelable: true }),
    );

    expect(onCloseTab).toHaveBeenCalledWith('document:doc-2');
  });

  it('switches to next tab on Ctrl+Tab', () => {
    renderHook(() =>
      useWorkspaceKeyboard({
        tabs: mockTabs,
        activeTabId: 'document:doc-1',
        onActivateTab,
        onCloseTab,
      }),
    );

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, cancelable: true }),
    );

    expect(onActivateTab).toHaveBeenCalledWith('document:doc-2');
  });

  it('switches to previous tab on Ctrl+Shift+Tab', () => {
    renderHook(() =>
      useWorkspaceKeyboard({
        tabs: mockTabs,
        activeTabId: 'document:doc-2',
        onActivateTab,
        onCloseTab,
      }),
    );

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, shiftKey: true, cancelable: true }),
    );

    expect(onActivateTab).toHaveBeenCalledWith('document:doc-1');
  });

  it('wraps around to first tab when cycling next from last tab', () => {
    renderHook(() =>
      useWorkspaceKeyboard({
        tabs: mockTabs,
        activeTabId: 'design:des-1',
        onActivateTab,
        onCloseTab,
      }),
    );

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, cancelable: true }),
    );

    expect(onActivateTab).toHaveBeenCalledWith('document:doc-1');
  });

  it('activates tab by number index on Ctrl+1..9', () => {
    renderHook(() =>
      useWorkspaceKeyboard({
        tabs: mockTabs,
        activeTabId: 'document:doc-1',
        onActivateTab,
        onCloseTab,
      }),
    );

    // Press Ctrl+3 -> should activate design:des-1 (index 2)
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '3', ctrlKey: true, cancelable: true }),
    );

    expect(onActivateTab).toHaveBeenCalledWith('design:des-1');
  });

  it('ignores Ctrl+number if index exceeds open tab count', () => {
    renderHook(() =>
      useWorkspaceKeyboard({
        tabs: mockTabs,
        activeTabId: 'document:doc-1',
        onActivateTab,
        onCloseTab,
      }),
    );

    // Press Ctrl+5 -> only 3 tabs open, should do nothing
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '5', ctrlKey: true, cancelable: true }),
    );

    expect(onActivateTab).not.toHaveBeenCalled();
  });

  it('does not fire when a modal dialog is present in the DOM', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);

    renderHook(() =>
      useWorkspaceKeyboard({
        tabs: mockTabs,
        activeTabId: 'document:doc-1',
        onActivateTab,
        onCloseTab,
      }),
    );

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, cancelable: true }),
    );

    expect(onCloseTab).not.toHaveBeenCalled();
  });

  it('does not fire when typing inside a regular input element', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    renderHook(() =>
      useWorkspaceKeyboard({
        tabs: mockTabs,
        activeTabId: 'document:doc-1',
        onActivateTab,
        onCloseTab,
      }),
    );

    const event = new KeyboardEvent('keydown', {
      key: 'w',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    input.dispatchEvent(event);

    expect(onCloseTab).not.toHaveBeenCalled();
  });

  it('does fire when typing inside Monaco editor textarea', () => {
    const monacoContainer = document.createElement('div');
    monacoContainer.className = 'monaco-editor';
    const textarea = document.createElement('textarea');
    monacoContainer.appendChild(textarea);
    document.body.appendChild(monacoContainer);
    textarea.focus();

    renderHook(() =>
      useWorkspaceKeyboard({
        tabs: mockTabs,
        activeTabId: 'document:doc-1',
        onActivateTab,
        onCloseTab,
      }),
    );

    const event = new KeyboardEvent('keydown', {
      key: 'w',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    textarea.dispatchEvent(event);

    expect(onCloseTab).toHaveBeenCalledWith('document:doc-1');
  });
});
