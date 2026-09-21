import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useWorkspaceNavigation } from '@/hooks/useWorkspaceNavigation';

describe('useWorkspaceNavigation', () => {
  const createWrapper = (initialEntries: string[] = ['/projects/p1']) => {
    return ({ children }: { children: React.ReactNode }) => (
      <MemoryRouter initialEntries={initialEntries}>
        {children}
      </MemoryRouter>
    );
  };

  it('openDocument sets doc parameter and clears design/action', () => {
    const { result } = renderHook(
      () => ({
        nav: useWorkspaceNavigation(),
        location: useLocation(),
      }),
      { wrapper: createWrapper(['/projects/p1?design=des-1&action=new-doc']) }
    );

    act(() => {
      result.current.nav.openDocument('doc-123');
    });

    expect(result.current.location.search).toBe('?doc=doc-123');
  });

  it('openDesign sets design parameter and clears doc/action', () => {
    const { result } = renderHook(
      () => ({
        nav: useWorkspaceNavigation(),
        location: useLocation(),
      }),
      { wrapper: createWrapper(['/projects/p1?doc=doc-1&action=new-design']) }
    );

    act(() => {
      result.current.nav.openDesign('des-456');
    });

    expect(result.current.location.search).toBe('?design=des-456');
  });

  it('openOverview clears doc, design, and action parameters', () => {
    const { result } = renderHook(
      () => ({
        nav: useWorkspaceNavigation(),
        location: useLocation(),
      }),
      { wrapper: createWrapper(['/projects/p1?doc=doc-1&action=new-vibe']) }
    );

    act(() => {
      result.current.nav.openOverview();
    });

    expect(result.current.location.search).toBe('');
  });
});
