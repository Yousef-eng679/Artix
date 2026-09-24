import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { WorkspaceTabBar } from '@/components/ProjectWorkspace/WorkspaceTabBar';
import { WorkspaceTab, WorkspaceResource } from '@/types/workspace';
import { dirtyTracker } from '@/lib/workspace/dirtyTracker';

describe('WorkspaceTabBar component', () => {
  const mockResources: WorkspaceResource[] = [
    {
      id: 'doc-1',
      projectId: 'p1',
      title: 'PRD Document',
      kind: 'document',
      updatedAt: '2026-09-24T00:00:00Z',
      folderId: null,
    },
    {
      id: 'des-1',
      projectId: 'p1',
      title: 'Auth Architecture',
      kind: 'design',
      updatedAt: '2026-09-24T00:00:00Z',
      folderId: null,
    },
  ];

  const mockTabs: WorkspaceTab[] = [
    { id: 'document:doc-1', resourceKind: 'document', resourceId: 'doc-1' },
    { id: 'design:des-1', resourceKind: 'design', resourceId: 'des-1' },
  ];

  beforeEach(() => {
    dirtyTracker.clear();
  });

  it('renders nothing when tabs array is empty', () => {
    const { container } = render(
      <WorkspaceTabBar
        tabs={[]}
        activeTabId={null}
        resources={mockResources}
        onActivateTab={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('renders tabs with resolved titles from resources', () => {
    render(
      <WorkspaceTabBar
        tabs={mockTabs}
        activeTabId="document:doc-1"
        resources={mockResources}
        onActivateTab={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    );

    expect(screen.getByText('PRD Document')).toBeInTheDocument();
    expect(screen.getByText('Auth Architecture')).toBeInTheDocument();
  });

  it('marks active tab with aria-selected="true"', () => {
    render(
      <WorkspaceTabBar
        tabs={mockTabs}
        activeTabId="document:doc-1"
        resources={mockResources}
        onActivateTab={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    );

    const docTab = screen.getByRole('tab', { name: /PRD Document/i });
    const desTab = screen.getByRole('tab', { name: /Auth Architecture/i });

    expect(docTab).toHaveAttribute('aria-selected', 'true');
    expect(desTab).toHaveAttribute('aria-selected', 'false');
  });

  it('clicking a tab invokes onActivateTab with tab.id', () => {
    const handleActivate = vi.fn();
    render(
      <WorkspaceTabBar
        tabs={mockTabs}
        activeTabId="document:doc-1"
        resources={mockResources}
        onActivateTab={handleActivate}
        onCloseTab={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Auth Architecture'));
    expect(handleActivate).toHaveBeenCalledWith('design:des-1');
  });

  it('clicking close button invokes onCloseTab with tab.id without activating tab', () => {
    const handleActivate = vi.fn();
    const handleClose = vi.fn();

    render(
      <WorkspaceTabBar
        tabs={mockTabs}
        activeTabId="document:doc-1"
        resources={mockResources}
        onActivateTab={handleActivate}
        onCloseTab={handleClose}
      />,
    );

    const closeBtn = screen.getByLabelText('Close PRD Document');
    fireEvent.click(closeBtn);

    expect(handleClose).toHaveBeenCalledWith('document:doc-1');
    expect(handleActivate).not.toHaveBeenCalled();
  });

  it('middle-clicking a tab invokes onCloseTab', () => {
    const handleActivate = vi.fn();
    const handleClose = vi.fn();

    render(
      <WorkspaceTabBar
        tabs={mockTabs}
        activeTabId="document:doc-1"
        resources={mockResources}
        onActivateTab={handleActivate}
        onCloseTab={handleClose}
      />,
    );

    const docTab = screen.getByRole('tab', { name: /PRD Document/i });
    // Mouse button 1 is middle click
    fireEvent.mouseDown(docTab, { button: 1 });

    expect(handleClose).toHaveBeenCalledWith('document:doc-1');
    expect(handleActivate).not.toHaveBeenCalled();
  });

  it('renders dirty indicator when resource is marked dirty in dirtyTracker', () => {
    dirtyTracker.markDirty('doc-1');

    render(
      <WorkspaceTabBar
        tabs={mockTabs}
        activeTabId="document:doc-1"
        resources={mockResources}
        onActivateTab={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    );

    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument();
  });

  it('updates tab title when resource is renamed in resources array', () => {
    const { rerender } = render(
      <WorkspaceTabBar
        tabs={mockTabs}
        activeTabId="document:doc-1"
        resources={mockResources}
        onActivateTab={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    );

    expect(screen.getByText('PRD Document')).toBeInTheDocument();

    const updatedResources = mockResources.map((r) =>
      r.id === 'doc-1' ? { ...r, title: 'Renamed PRD' } : r,
    );

    rerender(
      <WorkspaceTabBar
        tabs={mockTabs}
        activeTabId="document:doc-1"
        resources={updatedResources}
        onActivateTab={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    );

    expect(screen.getByText('Renamed PRD')).toBeInTheDocument();
    expect(screen.queryByText('PRD Document')).not.toBeInTheDocument();
  });

  it('renders close all tabs button when tabs > 1 and onCloseAllTabs is provided', () => {
    const handleCloseAll = vi.fn();

    render(
      <WorkspaceTabBar
        tabs={mockTabs}
        activeTabId="document:doc-1"
        resources={mockResources}
        onActivateTab={vi.fn()}
        onCloseTab={vi.fn()}
        onCloseAllTabs={handleCloseAll}
      />,
    );

    const closeAllBtn = screen.getByLabelText('Close all tabs');
    expect(closeAllBtn).toBeInTheDocument();

    fireEvent.click(closeAllBtn);
    expect(handleCloseAll).toHaveBeenCalledTimes(1);
  });
});
