import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { RenameDialog } from '@/components/RenameDialog';

describe('RenameDialog Component', () => {
  it('renders with title and pre-filled currentName', () => {
    render(
      <RenameDialog
        open={true}
        onOpenChange={vi.fn()}
        currentName="New Folder"
        onSave={vi.fn()}
        title="Create New Folder"
      />
    );

    expect(screen.getByText('Create New Folder')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('New Folder');
  });

  it('validates empty name and shows error', async () => {
    const onSave = vi.fn();
    render(
      <RenameDialog
        open={true}
        onOpenChange={vi.fn()}
        currentName=""
        onSave={onSave}
        title="Rename Item"
      />
    );

    const saveButton = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(saveButton);

    expect(await screen.findByText('Name cannot be empty')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('displays custom validation error returned by validate prop and blocks onSave', async () => {
    const onSave = vi.fn();
    const validate = vi.fn().mockReturnValue('A folder named "Authentication" already exists in this project');

    render(
      <RenameDialog
        open={true}
        onOpenChange={vi.fn()}
        currentName="Authentication"
        onSave={onSave}
        validate={validate}
        title="Create New Folder"
      />
    );

    const saveButton = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(saveButton);

    expect(
      await screen.findByText('A folder named "Authentication" already exists in this project')
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('calls onSave with trimmed name and closes on success', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();

    render(
      <RenameDialog
        open={true}
        onOpenChange={onOpenChange}
        currentName="My Folder"
        onSave={onSave}
        title="Create New Folder"
      />
    );

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '  Billing Area  ' } });

    const saveButton = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('Billing Area');
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
