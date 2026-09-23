import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectWorkspaceSidebar } from '@/components/ProjectWorkspace/ProjectWorkspaceSidebar';
import { WorkspaceResource, WorkspaceSelection, WorkspaceFolder } from '@/types/workspace';

describe('ProjectWorkspaceSidebar Component (Folder-First)', () => {
  const mockFolders: WorkspaceFolder[] = [
    {
      id: 'f-auth',
      projectId: 'proj-1',
      name: 'Authentication',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    },
    {
      id: 'f-payments',
      projectId: 'proj-1',
      name: 'Payments',
      createdAt: '2026-09-02T00:00:00Z',
      updatedAt: '2026-09-02T00:00:00Z',
    },
  ];

  const mockResources: WorkspaceResource[] = [
    {
      id: 'doc-1',
      projectId: 'proj-1',
      title: 'Auth PRD',
      kind: 'document',
      updatedAt: '2026-09-02T10:00:00Z',
      folderId: 'f-auth',
    },
    {
      id: 'des-1',
      projectId: 'proj-1',
      title: 'Auth Architecture',
      kind: 'design',
      updatedAt: '2026-09-03T10:00:00Z',
      folderId: 'f-auth',
    },
    {
      id: 'doc-root',
      projectId: 'proj-1',
      title: 'Root Project Notes',
      kind: 'document',
      updatedAt: '2026-09-01T10:00:00Z',
      folderId: null,
    },
  ];

  const defaultProps = {
    projectName: 'Artix Command Center',
    resources: mockResources,
    folders: mockFolders,
    selection: { kind: 'none' } as WorkspaceSelection,
    searchQuery: '',
    onSearchChange: vi.fn(),
    onSelectOverview: vi.fn(),
    onSelectResource: vi.fn(),
    onCreateDocument: vi.fn(),
    onCreateDesign: vi.fn(),
    onCreateFolder: vi.fn(),
    onRenameResource: vi.fn(),
    onDeleteResource: vi.fn(),
    onRenameFolder: vi.fn(),
    onDeleteFolder: vi.fn(),
    onMoveResource: vi.fn(),
    onBackToDashboard: vi.fn(),
  };

  it('renders project title and overview button', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    expect(screen.getByText('Artix Command Center')).toBeInTheDocument();
    expect(screen.getByLabelText('Project Overview')).toBeInTheDocument();
  });

  it('renders folders and root sections with correct counts', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    expect(screen.getByText('Folders')).toBeInTheDocument();
    expect(screen.getByText('Authentication')).toBeInTheDocument();
    expect(screen.getByText('Payments')).toBeInTheDocument();
    expect(screen.getByText('Root')).toBeInTheDocument();

    // Authentication folder has 2 resources, Payments has 0, Root has 1
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('calls onSelectOverview when Overview item is clicked', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Project Overview'));
    expect(defaultProps.onSelectOverview).toHaveBeenCalledTimes(1);
  });

  it('calls onSelectResource when a root resource item is clicked', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    fireEvent.click(screen.getByText('Root Project Notes'));
    expect(defaultProps.onSelectResource).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'doc-root', title: 'Root Project Notes' })
    );
  });

  it('expands folder and reveals contained resources on click', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    // Initially collapsed
    expect(screen.queryByText('Auth PRD')).not.toBeInTheDocument();

    const folderToggle = screen.getByLabelText('Toggle folder Authentication');
    fireEvent.click(folderToggle);

    // Now expanded
    expect(screen.getByText('Auth PRD')).toBeInTheDocument();
    expect(screen.getByText('Auth Architecture')).toBeInTheDocument();

    // Clicking resource inside expanded folder
    fireEvent.click(screen.getByText('Auth PRD'));
    expect(defaultProps.onSelectResource).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'doc-1', title: 'Auth PRD' })
    );
  });

  it('calls onCreateFolder when "+ New Folder" button is clicked', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    const newFolderBtn = screen.getByRole('button', { name: /\+ New Folder/i });
    fireEvent.click(newFolderBtn);
    expect(defaultProps.onCreateFolder).toHaveBeenCalledTimes(1);
  });

  it('calls onCreateDocument and onCreateDesign for root when footer buttons are clicked', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Create new document'));
    expect(defaultProps.onCreateDocument).toHaveBeenCalledWith(null);

    fireEvent.click(screen.getByLabelText('Create new system design'));
    expect(defaultProps.onCreateDesign).toHaveBeenCalledWith(null);
  });

  it('collapses and expands the root resources group on toggle click', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    const toggleBtn = screen.getByLabelText('Toggle root resources list');
    expect(toggleBtn).toBeInTheDocument();

    // Toggle collapse
    fireEvent.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Root Project Notes')).not.toBeInTheDocument();

    // Toggle expand
    fireEvent.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Root Project Notes')).toBeInTheDocument();
  });

  it('calls onSearchChange when text is entered into the search box', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    const searchInput = screen.getByLabelText('Search resources');
    fireEvent.change(searchInput, { target: { value: 'Auth' } });

    expect(defaultProps.onSearchChange).toHaveBeenCalledWith('Auth');
  });

  it('calls onBackToDashboard when back button is clicked', () => {
    render(<ProjectWorkspaceSidebar {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Back to dashboard'));
    expect(defaultProps.onBackToDashboard).toHaveBeenCalledTimes(1);
  });
});
