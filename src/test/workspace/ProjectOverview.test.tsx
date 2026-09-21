import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectOverview } from '@/components/ProjectWorkspace/ProjectOverview';
import { WorkspaceResource } from '@/types/workspace';

describe('Phase 3: ProjectOverview Component', () => {
  const mockResources: WorkspaceResource[] = [
    {
      id: 'doc-1',
      projectId: 'p1',
      title: 'API Reference',
      kind: 'document',
      updatedAt: '2026-09-02T10:00:00Z',
      meta: { format: 'markdown' },
    },
    {
      id: 'des-1',
      projectId: 'p1',
      title: 'Service Flow',
      kind: 'design',
      updatedAt: '2026-09-03T10:00:00Z',
      meta: { nodeCount: 5 },
    },
  ];

  const defaultProps = {
    projectName: 'Fintech Engine',
    resources: mockResources,
    onOpenDocument: vi.fn(),
    onOpenDesign: vi.fn(),
    onCreateDocument: vi.fn(),
    onCreateDesign: vi.fn(),
  };

  it('renders project name and metrics correctly', () => {
    render(<ProjectOverview {...defaultProps} />);

    expect(screen.getByText('Fintech Engine')).toBeInTheDocument();
    // Total count: 2, Documents count: 1, System designs count: 1
    expect(screen.getByText('2')).toBeInTheDocument();
    const ones = screen.getAllByText('1');
    expect(ones.length).toBe(2);
  });

  it('renders empty state when project has zero resources', () => {
    render(<ProjectOverview {...defaultProps} resources={[]} />);

    expect(screen.getByText('Your workspace is ready')).toBeInTheDocument();
  });

  it('triggers onCreateDocument on clicking Create Document button', () => {
    render(<ProjectOverview {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /Create Document/i }));
    expect(defaultProps.onCreateDocument).toHaveBeenCalledTimes(1);
  });

  it('triggers onCreateDesign on clicking New System Design button', () => {
    render(<ProjectOverview {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /New System Design/i }));
    expect(defaultProps.onCreateDesign).toHaveBeenCalledTimes(1);
  });

  it('triggers onOpenDocument when clicking a recent document card', () => {
    render(<ProjectOverview {...defaultProps} />);

    fireEvent.click(screen.getByText('API Reference'));
    expect(defaultProps.onOpenDocument).toHaveBeenCalledWith('doc-1');
  });

  it('triggers onOpenDesign when clicking a recent design card', () => {
    render(<ProjectOverview {...defaultProps} />);

    fireEvent.click(screen.getByText('Service Flow'));
    expect(defaultProps.onOpenDesign).toHaveBeenCalledWith('des-1');
  });
});
