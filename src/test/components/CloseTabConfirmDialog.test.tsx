import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { CloseTabConfirmDialog } from '@/components/ProjectWorkspace/CloseTabConfirmDialog';

describe('CloseTabConfirmDialog component', () => {
  it('renders confirmation dialog when open', () => {
    render(
      <CloseTabConfirmDialog
        open={true}
        tabTitle="My PRD Draft"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
    expect(screen.getByText('"My PRD Draft"')).toBeInTheDocument();
    expect(screen.getByText(/has unsaved changes/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Keep Tab Open/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Close Tab/i })).toBeInTheDocument();
  });

  it('calls onCancel when clicking Keep Tab Open', () => {
    const handleCancel = vi.fn();
    render(
      <CloseTabConfirmDialog
        open={true}
        tabTitle="Architecture"
        onConfirm={vi.fn()}
        onCancel={handleCancel}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Keep Tab Open/i }));
    expect(handleCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onConfirm when clicking Close Tab', () => {
    const handleConfirm = vi.fn();
    render(
      <CloseTabConfirmDialog
        open={true}
        tabTitle="Architecture"
        onConfirm={handleConfirm}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Close Tab/i }));
    expect(handleConfirm).toHaveBeenCalledTimes(1);
  });
});
