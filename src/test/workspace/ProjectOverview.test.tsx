import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectOverview } from '@/components/ProjectWorkspace/ProjectOverview';
import { WorkspaceResource, WorkspaceFolder } from '@/types/workspace';

describe('ProjectOverview Component (Simplified Landing)', () => {
  const mockFolders: WorkspaceFolder[] = [
    {
      id: 'f-backend',
      projectId: 'p1',
      name: 'Backend Core',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    },
  ];

  const mockResources: WorkspaceResource[] = [
    {
      id: 'doc-1',
      projectId: 'p1',
      title: 'API Reference',
      kind: 'document',
      updatedAt: '2026-09-02T10:00:00Z',
      folderId: 'f-backend',
    },
    {
      id: 'des-1',
      projectId: 'p1',
      title: 'Service Flow',
      kind: 'design',
      updatedAt: '2026-09-03T10:00:00Z',
      folderId: null,
    },
  ];

  const defaultProps = {
    projectName: 'Fintech Engine',
    resources: mockResources,
    folders: mockFolders,
    onOpenDocument: vi.fn(),
    onOpenDesign: vi.fn(),
    onCreateDocument: vi.fn(),
    onCreateDesign: vi.fn(),
  };

  it('renders project name and lightweight resource summary correctly', () => {
    render(<ProjectOverview {...defaultProps} />);

    expect(screen.getByText('Fintech Engine')).toBeInTheDocument();
    expect(screen.getByText(/2 resources/i)).toBeInTheDocument();
    expect(screen.getByText(/1 documents/i)).toBeInTheDocument();
    expect(screen.getByText(/1 designs/i)).toBeInTheDocument();
    expect(screen.getByText(/1 folders/i)).toBeInTheDocument();
  });

  it('renders destination badges (folder name or Root) on recent cards', () => {
    render(<ProjectOverview {...defaultProps} />);

    expect(screen.getByText('Backend Core')).toBeInTheDocument();
    expect(screen.getByText('Root')).toBeInTheDocument();
  });

  it('renders empty state with quick action buttons when project has zero resources', () => {
    render(<ProjectOverview {...defaultProps} resources={[]} />);

    expect(screen.getByText('Your workspace is ready')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /New Document/i }));
    expect(defaultProps.onCreateDocument).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /New Design/i }));
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
