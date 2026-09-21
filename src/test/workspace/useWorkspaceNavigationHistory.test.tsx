import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { useWorkspaceNavigation } from '@/hooks/useWorkspaceNavigation';

const NavigationHistoryHarness: React.FC = () => {
  const nav = useWorkspaceNavigation();
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <div>
      <div data-testid="current-search">{location.search}</div>
      <button onClick={() => nav.openDocument('doc-a')}>Open Doc A</button>
      <button onClick={() => nav.openDocument('doc-b')}>Open Doc B</button>
      <button onClick={() => nav.openDesign('des-c')}>Open Design C</button>
      <button onClick={() => nav.openOverview()}>Open Overview</button>
      <button onClick={() => navigate(-1)}>Browser Back</button>
      <button onClick={() => navigate(1)}>Browser Forward</button>
    </div>
  );
};

describe('useWorkspaceNavigation History Semantics & Traversal', () => {
  const renderHarness = (initialEntry = '/projects/p1') => {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/projects/:id" element={<NavigationHistoryHarness />} />
        </Routes>
      </MemoryRouter>
    );
  };

  it('proves openDocument uses PUSH semantics via browser history back traversal', () => {
    renderHarness('/projects/p1?doc=doc-initial');

    expect(screen.getByTestId('current-search')).toHaveTextContent('?doc=doc-initial');

    // Push Doc A
    fireEvent.click(screen.getByRole('button', { name: 'Open Doc A' }));
    expect(screen.getByTestId('current-search')).toHaveTextContent('?doc=doc-a');

    // Browser Back should return to doc-initial
    fireEvent.click(screen.getByRole('button', { name: 'Browser Back' }));
    expect(screen.getByTestId('current-search')).toHaveTextContent('?doc=doc-initial');
  });

  it('proves openDesign uses PUSH semantics via browser history back traversal', () => {
    renderHarness('/projects/p1?design=des-initial');

    expect(screen.getByTestId('current-search')).toHaveTextContent('?design=des-initial');

    // Push Design C
    fireEvent.click(screen.getByRole('button', { name: 'Open Design C' }));
    expect(screen.getByTestId('current-search')).toHaveTextContent('?design=des-c');

    // Browser Back should return to des-initial
    fireEvent.click(screen.getByRole('button', { name: 'Browser Back' }));
    expect(screen.getByTestId('current-search')).toHaveTextContent('?design=des-initial');
  });

  it('rigorously proves openOverview uses REPLACE semantics by bypassing Design C on Browser Back', () => {
    // Sequence: Overview -> Doc A (push) -> Doc B (push) -> Design C (push) -> Overview (replace)
    renderHarness('/projects/p1');

    expect(screen.getByTestId('current-search')).toHaveTextContent('');

    // 1. Doc A (push)
    fireEvent.click(screen.getByRole('button', { name: 'Open Doc A' }));
    expect(screen.getByTestId('current-search')).toHaveTextContent('?doc=doc-a');

    // 2. Doc B (push)
    fireEvent.click(screen.getByRole('button', { name: 'Open Doc B' }));
    expect(screen.getByTestId('current-search')).toHaveTextContent('?doc=doc-b');

    // 3. Design C (push)
    fireEvent.click(screen.getByRole('button', { name: 'Open Design C' }));
    expect(screen.getByTestId('current-search')).toHaveTextContent('?design=des-c');

    // 4. Overview via openOverview() (replace semantics - replaces Design C in history stack)
    fireEvent.click(screen.getByRole('button', { name: 'Open Overview' }));
    expect(screen.getByTestId('current-search')).toHaveTextContent('');

    // 5. Browser Back:
    // If openOverview were push, Back would land on Design C.
    // Because openOverview used replace, Design C was overwritten and Back MUST land on Doc B!
    fireEvent.click(screen.getByRole('button', { name: 'Browser Back' }));
    expect(screen.getByTestId('current-search')).toHaveTextContent('?doc=doc-b');

    // 6. Browser Back again: returns to Doc A
    fireEvent.click(screen.getByRole('button', { name: 'Browser Back' }));
    expect(screen.getByTestId('current-search')).toHaveTextContent('?doc=doc-a');

    // 7. Browser Forward: returns to Doc B
    fireEvent.click(screen.getByRole('button', { name: 'Browser Forward' }));
    expect(screen.getByTestId('current-search')).toHaveTextContent('?doc=doc-b');
  });
});
