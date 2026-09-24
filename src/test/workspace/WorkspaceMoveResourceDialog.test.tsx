import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { WorkspaceMoveResourceDialog } from '@/components/ProjectWorkspace/WorkspaceMoveResourceDialog';
import { WorkspaceFolder } from '@/types/workspace';

describe('WorkspaceMoveResourceDialog Component', () => {
  const mockFolders: WorkspaceFolder[] = [
    {
      id: 'f-auth',
      projectId: 'p1',
      name: 'Authentication',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    },
    {
      id: 'f-payments',
      projectId: 'p1',
      name: 'Payments',
      createdAt: '2026-09-02T00:00:00Z',
      updatedAt: '2026-09-02T00:00:00Z',
    },
  ];

  it('renders destination options and identifies current folder', () => {
    render(
      <WorkspaceMoveResourceDialog
        open={true}
        onOpenChange={vi.fn()}
        resourceTitle="Architecture Spec"
        currentFolderId="f-auth"
        folders={mockFolders}
        onMove={vi.fn()}
      />
    );

    expect(screen.getByText(/Move “Architecture Spec”/i)).toBeInTheDocument();
    expect(screen.getByText('Project Root')).toBeInTheDocument();
    expect(screen.getByText('Authentication')).toBeInTheDocument();
    expect(screen.getByText('Payments')).toBeInTheDocument();
    expect(screen.getByText('(Current)')).toBeInTheDocument();
  });

  it('disables Move button when destination is identical to current folder', () => {
    render(
      <WorkspaceMoveResourceDialog
        open={true}
        onOpenChange={vi.fn()}
        resourceTitle="Architecture Spec"
        currentFolderId="f-auth"
        folders={mockFolders}
        onMove={vi.fn()}
      />
    );

    const moveBtn = screen.getByRole('button', { name: 'Move' });
    expect(moveBtn).toBeDisabled();
  });

  it('calls onMove with target folder ID when choosing a new folder and clicking Move', async () => {
    const onMove = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();

    render(
      <WorkspaceMoveResourceDialog
        open={true}
        onOpenChange={onOpenChange}
        resourceTitle="Architecture Spec"
        currentFolderId="f-auth"
        folders={mockFolders}
        onMove={onMove}
      />
    );

    // Select Payments
    fireEvent.click(screen.getByText('Payments'));

    const moveBtn = screen.getByRole('button', { name: 'Move' });
    expect(moveBtn).not.toBeDisabled();

    fireEvent.click(moveBtn);

    await waitFor(() => {
      expect(onMove).toHaveBeenCalledWith('f-payments');
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('calls onMove with null when choosing Project Root from a folder', async () => {
    const onMove = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();

    render(
      <WorkspaceMoveResourceDialog
        open={true}
        onOpenChange={onOpenChange}
        resourceTitle="Architecture Spec"
        currentFolderId="f-auth"
        folders={mockFolders}
        onMove={onMove}
      />
    );

    // Select Project Root
    fireEvent.click(screen.getByText('Project Root'));

    const moveBtn = screen.getByRole('button', { name: 'Move' });
    fireEvent.click(moveBtn);

    await waitFor(() => {
      expect(onMove).toHaveBeenCalledWith(null);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('displays error message when onMove promise rejects', async () => {
    const onMove = vi.fn().mockRejectedValue(new Error('Network failure'));

    render(
      <WorkspaceMoveResourceDialog
        open={true}
        onOpenChange={vi.fn()}
        resourceTitle="Architecture Spec"
        currentFolderId={null}
        folders={mockFolders}
        onMove={onMove}
      />
    );

    // Select Authentication
    fireEvent.click(screen.getByText('Authentication'));

    const moveBtn = screen.getByRole('button', { name: 'Move' });
    fireEvent.click(moveBtn);

    await waitFor(() => {
      expect(screen.getByText('Failed to move resource. Please try again.')).toBeInTheDocument();
    });
  });
});
