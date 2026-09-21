import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectWorkspaceSidebar } from '@/components/ProjectWorkspace/ProjectWorkspaceSidebar';
import { WorkspaceResource, WorkspaceSelection } from '@/types/workspace';

describe('Phase 2: ProjectWorkspaceSidebar Component', () => {
  const mockResources: WorkspaceResource[] = [
    {
      id: 'doc-1',
      projectId: 'proj-1',
      title: 'Product PRD',
      kind: 'document',
      updatedAt: '2026-09-02T10:00:00Z',
    },
    {
      id: 'doc-2',
      projectId: 'proj-1',
      title: 'API Spec',
      kind: 'document',
      updatedAt: '2026-09-01T10:00:00Z',
    },
    {
      id: 'des-1',
      projectId: 'proj-1',
      title: 'System Architecture',
      kind: 'design',
      updatedAt: '2026-09-03T10:00:00Z',
    },
  ];

  const defaultProps = {
    projectName: 'Artix Command Center',
    resources: mockResources,
    selection: { kind: 'none' } as WorkspaceSelection,
    searchQuery: '',
    onSearchChange: vi.fn(),
    onSelectOverview: vi.fn(),
    onSelectResource: vi.fn(),
    onCreateDocument: vi.fn(),
    onCreateDesign: vi.fn(),
    onRenameResource: vi.fn(),
    onDeleteResource: vi.fn(),
    onBackToDashboard: vi.fn(),
  };

  it('renders project title and overview button', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    expect(screen.getByText('Artix Command Center')).toBeInTheDocument();
    expect(screen.getByLabelText('Project Overview')).toBeInTheDocument();
  });

  it('renders document and system design groups with correct counts', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    expect(screen.getByText('Documents')).toBeInTheDocument();
    expect(screen.getByText('System Designs')).toBeInTheDocument();

    // Documents count is 2, System Designs count is 1
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();

    // Renders resource titles
    expect(screen.getAllByText('Product PRD').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('API Spec').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('System Architecture').length).toBeGreaterThanOrEqual(1);
  });

  it('calls onSelectOverview when Overview item is clicked', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Project Overview'));
    expect(defaultProps.onSelectOverview).toHaveBeenCalledTimes(1);
  });

  it('calls onSelectResource when a resource item is clicked', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    fireEvent.click(screen.getAllByText('Product PRD')[0]);
    expect(defaultProps.onSelectResource).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'doc-1', title: 'Product PRD' })
    );
  });

  it('calls onCreateDocument when "+" document button is clicked', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Create new document'));
    expect(defaultProps.onCreateDocument).toHaveBeenCalledTimes(1);
  });

  it('calls onCreateDesign when "+" design button is clicked', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Create new system design'));
    expect(defaultProps.onCreateDesign).toHaveBeenCalledTimes(1);
  });

  it('collapses and expands the documents group on toggle click', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    const toggleBtn = screen.getByLabelText('Toggle documents list');
    expect(toggleBtn).toBeInTheDocument();

    // Toggle collapse
    fireEvent.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');

    // Toggle expand
    fireEvent.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
  });

  it('calls onSearchChange when text is entered into the search box', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    const searchInput = screen.getByLabelText('Search resources');
    fireEvent.change(searchInput, { target: { value: 'PRD' } });

    expect(defaultProps.onSearchChange).toHaveBeenCalledWith('PRD');
  });

  it('calls onBackToDashboard when back button is clicked', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Back to dashboard'));
    expect(defaultProps.onBackToDashboard).toHaveBeenCalledTimes(1);
  });
});
