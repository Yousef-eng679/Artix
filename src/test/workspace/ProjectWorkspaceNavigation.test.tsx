import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProjectWorkspace from '@/pages/ProjectWorkspace';
import { toast } from 'sonner';

// Mock sonner
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Mock heavy child components to accurately simulate mount-only state behavior
vi.mock('@/components/Editor/Editor', () => ({
  Editor: ({
    document,
    onBack,
  }: {
    document: { id: string; title: string; content?: string };
    onBack: () => void;
  }) => {
    // Accurately simulates Editor's internal useState which only initializes on mount
    const [title] = React.useState(document.title);
    const [content] = React.useState(() => {
      const draft = localStorage.getItem(`artix.draft.${document.id}`);
      return draft ?? (document.content || '');
    });

    return (
      <div data-testid="editor-view">
        <h2>Editor: {title}</h2>
        <div data-testid="editor-content">{content}</div>
        <button onClick={onBack}>Editor Back</button>
      </div>
    );
  },
}));

vi.mock('@/components/SystemArchitect/SystemArchitect', () => ({
  SystemArchitect: ({
    design,
    onBack,
  }: {
    design: { id: string; name: string };
    onBack: () => void;
  }) => {
    // Accurately simulates SystemArchitect's internal useState/useNodesState which only initializes on mount
    const [name] = React.useState(design.name);
    const [boardDraft] = React.useState(() => {
      const draft = localStorage.getItem(`artix.draft.design-${design.id}`);
      return draft ?? 'default-board-state';
    });

    return (
      <div data-testid="architect-view">
        <h2>Architect: {name}</h2>
        <div data-testid="architect-state">{boardDraft}</div>
        <button onClick={onBack}>Architect Back</button>
      </div>
    );
  },
}));

// Mock hooks
const mockUser = { id: 'user-1', email: 'test@artix.dev' };
const mockProjects = [
  { id: 'p1', name: 'Alpha Engine', user_id: 'user-1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
];

let mockDocs = [
  { id: 'doc-1', project_id: 'p1', title: 'Architecture Spec', content: '# Spec', format: 'markdown' as const, updated_at: '2026-02-01T10:00:00Z' },
  { id: 'doc-2', project_id: 'p1', title: 'API Documentation', content: '# API', format: 'markdown' as const, updated_at: '2026-02-02T10:00:00Z' },
];

let mockDesigns = [
  { id: 'des-1', project_id: 'p1', name: 'Microservices Mesh', board_state: { nodes: [1, 2] }, updated_at: '2026-02-03T10:00:00Z' },
  { id: 'des-2', project_id: 'p1', name: 'Database Cluster', board_state: { nodes: [3] }, updated_at: '2026-02-04T10:00:00Z' },
];

const mockCreateDocument = vi.fn().mockImplementation(async ({ title }) => {
  const newDoc = { id: 'doc-new', project_id: 'p1', title, content: '', format: 'markdown' as const, updated_at: new Date().toISOString() };
  mockDocs.push(newDoc);
  return newDoc;
});

const mockCreateDesign = vi.fn().mockImplementation(async ({ name }) => {
  const newDesign = { id: 'des-new', project_id: 'p1', name, board_state: { nodes: [] }, updated_at: new Date().toISOString() };
  mockDesigns.push(newDesign);
  return newDesign;
});

const mockDeleteDocument = vi.fn().mockResolvedValue(undefined);
const mockDeleteDesign = vi.fn().mockResolvedValue(undefined);
const mockUpdateDocument = vi.fn().mockResolvedValue(undefined);
const mockUpdateDesign = vi.fn().mockResolvedValue(undefined);

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({ projects: mockProjects, isLoading: false }),
}));

vi.mock('@/hooks/useDocuments', () => ({
  useDocuments: () => ({
    documents: mockDocs,
    isLoading: false,
    createDocument: mockCreateDocument,
    updateDocument: mockUpdateDocument,
    deleteDocument: mockDeleteDocument,
  }),
}));

vi.mock('@/hooks/useSystemDesigns', () => ({
  useSystemDesigns: () => ({
    designs: mockDesigns,
    isLoading: false,
    createDesign: mockCreateDesign,
    updateDesign: mockUpdateDesign,
    deleteDesign: mockDeleteDesign,
  }),
}));

vi.mock('@/hooks/useUsageLimits', () => ({
  useUsageLimits: () => ({
    documents: { canCreate: true, used: 2, limit: 10 },
    systemDesigns: { canCreate: true, used: 2, limit: 10 },
  }),
}));

describe('ProjectWorkspace Navigation & Shell Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockDocs = [
      { id: 'doc-1', project_id: 'p1', title: 'Architecture Spec', content: '# Spec', format: 'markdown', updated_at: '2026-02-01T10:00:00Z' },
      { id: 'doc-2', project_id: 'p1', title: 'API Documentation', content: '# API', format: 'markdown', updated_at: '2026-02-02T10:00:00Z' },
    ];
    mockDesigns = [
      { id: 'des-1', project_id: 'p1', name: 'Microservices Mesh', board_state: { nodes: [1, 2] }, updated_at: '2026-02-03T10:00:00Z' },
      { id: 'des-2', project_id: 'p1', name: 'Database Cluster', board_state: { nodes: [3] }, updated_at: '2026-02-04T10:00:00Z' },
    ];
  });

  const renderWorkspace = (initialEntry: string) => {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/workspace/:id" element={<ProjectWorkspace />} />
          <Route path="/projects/:id" element={<ProjectWorkspace />} />
          <Route path="/dashboard" element={<div>Dashboard</div>} />
        </Routes>
      </MemoryRouter>
    );
  };

  it('renders ProjectOverview landing page when no resource query param is present', () => {
    renderWorkspace('/projects/p1');

    expect(screen.getByRole('heading', { name: 'Alpha Engine', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Total Resources')).toBeInTheDocument();
    expect(screen.queryByTestId('editor-view')).not.toBeInTheDocument();
    expect(screen.queryByTestId('architect-view')).not.toBeInTheDocument();
  });

  it('renders Editor component when ?doc=<id> deep-link is provided', () => {
    renderWorkspace('/projects/p1?doc=doc-1');

    expect(screen.getByTestId('editor-view')).toBeInTheDocument();
    expect(screen.getByText('Editor: Architecture Spec')).toBeInTheDocument();
    expect(screen.queryByTestId('architect-view')).not.toBeInTheDocument();
  });

  it('renders SystemArchitect component when ?design=<id> deep-link is provided', () => {
    renderWorkspace('/projects/p1?design=des-1');

    expect(screen.getByTestId('architect-view')).toBeInTheDocument();
    expect(screen.getByText('Architect: Microservices Mesh')).toBeInTheDocument();
    expect(screen.queryByTestId('editor-view')).not.toBeInTheDocument();
  });

  it('resolves conflict (?doc and ?design): doc strictly takes precedence', async () => {
    renderWorkspace('/projects/p1?doc=doc-1&design=des-1');

    expect(screen.getByTestId('editor-view')).toBeInTheDocument();
    expect(screen.queryByTestId('architect-view')).not.toBeInTheDocument();
  });

  it('handles invalid doc parameter by showing toast error and falling back to Overview', async () => {
    renderWorkspace('/projects/p1?doc=non-existent-doc');

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Document not found');
    });

    expect(screen.getByText('Total Resources')).toBeInTheDocument();
    expect(screen.queryByTestId('editor-view')).not.toBeInTheDocument();
  });

  it('handles invalid design parameter by showing toast error and falling back to Overview', async () => {
    renderWorkspace('/projects/p1?design=non-existent-design');

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('System design not found');
    });

    expect(screen.getByText('Total Resources')).toBeInTheDocument();
    expect(screen.queryByTestId('architect-view')).not.toBeInTheDocument();
  });

  it('navigates from Editor back to Overview when clicking Editor Back', async () => {
    renderWorkspace('/projects/p1?doc=doc-1');

    expect(screen.getByTestId('editor-view')).toBeInTheDocument();

    const backButton = screen.getByRole('button', { name: 'Editor Back' });
    fireEvent.click(backButton);

    await waitFor(() => {
      expect(screen.queryByTestId('editor-view')).not.toBeInTheDocument();
      expect(screen.getByText('Total Resources')).toBeInTheDocument();
    });
  });

  it('handles ?action=new-document idempotently and opens creation dialog', async () => {
    renderWorkspace('/projects/p1?action=new-document');

    expect(screen.getByText('Create New Document')).toBeInTheDocument();
  });

  it('creates a new document without false-positive Document not found error', async () => {
    renderWorkspace('/projects/p1');

    const createBtn = screen.getByLabelText('Create new document');
    fireEvent.click(createBtn);

    expect(screen.getByText('Create New Document')).toBeInTheDocument();

    const saveBtn = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockCreateDocument).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('New document created');
      expect(toast.error).not.toHaveBeenCalledWith('Document not found');
    });
  });

  it('creates a new design without false-positive System design not found error', async () => {
    renderWorkspace('/projects/p1');

    const createBtn = screen.getByLabelText('Create new system design');
    fireEvent.click(createBtn);

    expect(screen.getByText('Create New System Design')).toBeInTheDocument();

    const saveBtn = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockCreateDesign).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('New system design created');
      expect(toast.error).not.toHaveBeenCalledWith('System design not found');
    });
  });

  // --- Regression Tests for Resource Switching & Lifecycle ---

  it('navigates from Document A to Document B and renders B, not A (synchronizing sidebar and editor)', async () => {
    renderWorkspace('/projects/p1?doc=doc-1');

    expect(screen.getByTestId('editor-view')).toBeInTheDocument();
    expect(screen.getByText('Editor: Architecture Spec')).toBeInTheDocument();

    const docAButton = screen.getAllByLabelText('Open document: Architecture Spec')[0];
    const docBButton = screen.getAllByLabelText('Open document: API Documentation')[0];
    expect(docAButton).toHaveClass('border-primary');

    // Click Document B in the sidebar
    fireEvent.click(docBButton);

    await waitFor(() => {
      // 1. Rendered Editor represents Document B
      expect(screen.getByText('Editor: API Documentation')).toBeInTheDocument();
      expect(screen.queryByText('Editor: Architecture Spec')).not.toBeInTheDocument();
      // 2. Sidebar active state points to Document B
      expect(docBButton).toHaveClass('border-primary');
      expect(docAButton).not.toHaveClass('border-primary');
    });
  });

  it('navigates from Design A to Design B and renders B, not A (synchronizing sidebar and architect)', async () => {
    renderWorkspace('/projects/p1?design=des-1');

    expect(screen.getByTestId('architect-view')).toBeInTheDocument();
    expect(screen.getByText('Architect: Microservices Mesh')).toBeInTheDocument();

    const desAButton = screen.getAllByLabelText('Open system design: Microservices Mesh')[0];
    const desBButton = screen.getAllByLabelText('Open system design: Database Cluster')[0];
    expect(desAButton).toHaveClass('border-primary');

    // Click Design B in the sidebar
    fireEvent.click(desBButton);

    await waitFor(() => {
      // 1. Rendered Architect represents Design B
      expect(screen.getByText('Architect: Database Cluster')).toBeInTheDocument();
      expect(screen.queryByText('Architect: Microservices Mesh')).not.toBeInTheDocument();
      // 2. Sidebar active state points to Design B
      expect(desBButton).toHaveClass('border-primary');
      expect(desAButton).not.toHaveClass('border-primary');
    });
  });

  it('synchronizes URL and sidebar active selection across switches', async () => {
    renderWorkspace('/projects/p1?doc=doc-1');

    const docAButton = screen.getAllByLabelText('Open document: Architecture Spec')[0];
    expect(docAButton).toHaveClass('border-primary');

    const docBButton = screen.getAllByLabelText('Open document: API Documentation')[0];
    fireEvent.click(docBButton);

    await waitFor(() => {
      expect(docBButton).toHaveClass('border-primary');
      expect(docAButton).not.toHaveClass('border-primary');
    });
  });

  it('preserves recoverable draft state when switching resources', async () => {
    // User has an unsaved recoverable draft in localStorage for doc-1
    localStorage.setItem('artix.draft.doc-1', 'Recoverable draft for Doc A');

    renderWorkspace('/projects/p1?doc=doc-1');

    expect(screen.getByText('Recoverable draft for Doc A')).toBeInTheDocument();

    // Switch to doc-2
    const docBButton = screen.getAllByLabelText('Open document: API Documentation')[0];
    fireEvent.click(docBButton);

    await waitFor(() => {
      expect(screen.getByText('Editor: API Documentation')).toBeInTheDocument();
    });

    // Switch back to doc-1
    const docAButton = screen.getAllByLabelText('Open document: Architecture Spec')[0];
    fireEvent.click(docAButton);

    await waitFor(() => {
      expect(screen.getByText('Editor: Architecture Spec')).toBeInTheDocument();
      expect(screen.getByText('Recoverable draft for Doc A')).toBeInTheDocument();
    });
  });

  it('suppresses false-positive Document not found toast via recentlyCreatedRef even when cache update is delayed', async () => {
    mockCreateDocument.mockImplementationOnce(async ({ title }) => {
      // Return new document without immediately adding it to mockDocs to simulate cache query delay
      return { id: 'doc-delayed-sync', project_id: 'p1', title, content: '', format: 'markdown' as const, updated_at: new Date().toISOString() };
    });

    renderWorkspace('/projects/p1');

    const createBtn = screen.getByLabelText('Create new document');
    fireEvent.click(createBtn);

    const saveBtn = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockCreateDocument).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('New document created');
      // recentlyCreatedRef suppresses toast.error('Document not found') even though doc-delayed-sync is not in mockDocs yet!
      expect(toast.error).not.toHaveBeenCalledWith('Document not found');
    });
  });

  it('supports large resource count (50 docs + 20 designs) without rendering errors (smoke/integrity check)', () => {
    const largeDocs = Array.from({ length: 50 }, (_, i) => ({
      id: `doc-${i + 10}`,
      project_id: 'p1',
      title: `Document ${i + 10}`,
      content: 'Sample content',
      format: 'markdown' as const,
      updated_at: new Date(Date.now() - i * 100000).toISOString(),
    }));

    const largeDesigns = Array.from({ length: 20 }, (_, i) => ({
      id: `des-${i + 10}`,
      project_id: 'p1',
      name: `Design ${i + 10}`,
      board_state: { nodes: [] },
      updated_at: new Date(Date.now() - i * 100000).toISOString(),
    }));

    mockDocs = largeDocs;
    mockDesigns = largeDesigns;

    renderWorkspace('/projects/p1');

    expect(screen.getByText('Total Resources')).toBeInTheDocument();
    expect(screen.getByText('70')).toBeInTheDocument();
  });
});
