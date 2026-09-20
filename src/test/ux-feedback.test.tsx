import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { CreateProjectModal } from '../components/CreateProjectModal';
import { RenameDialog } from '../components/RenameDialog';

describe('UX & Feedback Real Component Suite', () => {
  describe('CreateProjectModal', () => {
    it('should show required validation error and disable submit when empty', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const onOpenChange = vi.fn();

      render(
        <CreateProjectModal
          open={true}
          onOpenChange={onOpenChange}
          onSubmit={onSubmit}
        />
      );

      const input = screen.getByPlaceholderText('e.g. Acme System Specs');
      const submitBtn = screen.getByRole('button', { name: /create project/i });

      // Type and clear to trigger touched validation
      fireEvent.change(input, { target: { value: 'a' } });
      fireEvent.blur(input);
      fireEvent.change(input, { target: { value: '' } });

      expect(screen.getByText(/project name is required/i)).toBeInTheDocument();
      expect(submitBtn).toBeDisabled();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('should detect duplicate project names case-insensitively and show error message', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const onOpenChange = vi.fn();

      render(
        <CreateProjectModal
          open={true}
          onOpenChange={onOpenChange}
          onSubmit={onSubmit}
          existingNames={['Artix Core', 'Beta Platform']}
        />
      );

      const input = screen.getByPlaceholderText('e.g. Acme System Specs');
      const submitBtn = screen.getByRole('button', { name: /create project/i });

      // Enter matching duplicate in lowercase
      fireEvent.change(input, { target: { value: 'artix core' } });

      expect(screen.getByText(/a project with this name already exists/i)).toBeInTheDocument();
      expect(submitBtn).toBeDisabled();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('should submit trimmed name when valid and close dialog', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const onOpenChange = vi.fn();

      render(
        <CreateProjectModal
          open={true}
          onOpenChange={onOpenChange}
          onSubmit={onSubmit}
          existingNames={['Existing Project']}
        />
      );

      const input = screen.getByPlaceholderText('e.g. Acme System Specs');
      const submitBtn = screen.getByRole('button', { name: /create project/i });

      fireEvent.change(input, { target: { value: '  New Clean System  ' } });
      expect(submitBtn).not.toBeDisabled();

      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith('New Clean System');
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });
    });
  });

  describe('RenameDialog', () => {
    it('should reject empty or whitespace names with validation error', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      const onOpenChange = vi.fn();

      render(
        <RenameDialog
          open={true}
          onOpenChange={onOpenChange}
          currentName="Initial Doc"
          onSave={onSave}
          title="Rename Document"
        />
      );

      const input = screen.getByDisplayValue('Initial Doc');
      const saveBtn = screen.getByRole('button', { name: /^save$/i });

      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.click(saveBtn);

      expect(screen.getByText('Name cannot be empty')).toBeInTheDocument();
      expect(onSave).not.toHaveBeenCalled();
    });

    it('should reject names longer than 100 characters', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      const onOpenChange = vi.fn();

      render(
        <RenameDialog
          open={true}
          onOpenChange={onOpenChange}
          currentName="Initial Doc"
          onSave={onSave}
          title="Rename Document"
        />
      );

      const input = screen.getByDisplayValue('Initial Doc');
      const saveBtn = screen.getByRole('button', { name: /^save$/i });

      fireEvent.change(input, { target: { value: 'a'.repeat(105) } });
      fireEvent.click(saveBtn);

      expect(screen.getByText('Name must be less than 100 characters')).toBeInTheDocument();
      expect(onSave).not.toHaveBeenCalled();
    });

    it('should display error message when onSave rejects', async () => {
      const onSave = vi.fn().mockRejectedValue(new Error('Network error'));
      const onOpenChange = vi.fn();

      render(
        <RenameDialog
          open={true}
          onOpenChange={onOpenChange}
          currentName="Old Name"
          onSave={onSave}
          title="Rename Item"
        />
      );

      const input = screen.getByDisplayValue('Old Name');
      const saveBtn = screen.getByRole('button', { name: /^save$/i });

      fireEvent.change(input, { target: { value: 'Valid New Name' } });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(screen.getByText('Failed to save. Please try again.')).toBeInTheDocument();
      });
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });
  });
});
