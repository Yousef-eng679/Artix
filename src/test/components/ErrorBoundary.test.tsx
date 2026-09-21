import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorBoundary } from '@/components/ErrorBoundary';

// Helper component that throws on render
const ThrowError = ({ shouldThrow = true, message = 'Intentional test crash' }: { shouldThrow?: boolean; message?: string }) => {
  if (shouldThrow) {
    throw new Error(message);
  }
  return <div data-testid="healthy-child">Child rendered successfully</div>;
};

describe('ErrorBoundary Component', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Suppress console.error output during deliberate error tests
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders children normally when no render error occurs', () => {
    render(
      <ErrorBoundary>
        <div data-testid="test-child">Healthy Content</div>
      </ErrorBoundary>
    );

    expect(screen.getByTestId('test-child')).toBeInTheDocument();
    expect(screen.getByText('Healthy Content')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('catches render error and displays the default fallback UI with error message', () => {
    render(
      <ErrorBoundary>
        <ThrowError message="Database connection exploded" />
      </ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText(/Database connection exploded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload page/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go to dashboard/i })).toBeInTheDocument();
  });

  it('renders custom ReactNode fallback when provided', () => {
    render(
      <ErrorBoundary fallback={<div data-testid="custom-fallback">Custom Safe Zone</div>}>
        <ThrowError />
      </ErrorBoundary>
    );

    expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
    expect(screen.getByText('Custom Safe Zone')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('renders custom render-function fallback and provides error and reset handler', () => {
    let capturedReset: (() => void) | null = null;

    render(
      <ErrorBoundary
        fallback={({ error, resetErrorBoundary }) => {
          capturedReset = resetErrorBoundary;
          return (
            <div data-testid="function-fallback">
              <span>Error caught: {error.message}</span>
              <button onClick={resetErrorBoundary}>Try Again</button>
            </div>
          );
        }}
      >
        <ThrowError message="Crash in canvas" />
      </ErrorBoundary>
    );

    expect(screen.getByTestId('function-fallback')).toBeInTheDocument();
    expect(screen.getByText('Error caught: Crash in canvas')).toBeInTheDocument();
    expect(typeof capturedReset).toBe('function');
  });

  it('calls window.location.reload when reload button is clicked', () => {
    const originalLocation = window.location;
    const reloadMock = vi.fn();

    // Mock window.location.reload
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...originalLocation, reload: reloadMock },
    });

    render(
      <ErrorBoundary>
        <ThrowError />
      </ErrorBoundary>
    );

    const reloadButton = screen.getByRole('button', { name: /reload page/i });
    fireEvent.click(reloadButton);

    expect(reloadMock).toHaveBeenCalledTimes(1);

    // Restore original window.location
    Object.defineProperty(window, 'location', {
      writable: true,
      value: originalLocation,
    });
  });

  it('calls window.location.href when dashboard button is clicked', () => {
    const originalLocation = window.location;

    // Mock window.location.href
    let assignedHref = '';
    delete (window as any).location;
    window.location = {
      ...originalLocation,
      set href(val: string) {
        assignedHref = val;
      },
      get href() {
        return assignedHref;
      },
    } as any;

    render(
      <ErrorBoundary>
        <ThrowError />
      </ErrorBoundary>
    );

    const dashboardButton = screen.getByRole('button', { name: /go to dashboard/i });
    fireEvent.click(dashboardButton);

    expect(assignedHref).toBe('/dashboard');

    // Restore
    window.location = originalLocation;
  });
});
