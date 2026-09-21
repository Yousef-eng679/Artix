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

// Mock heavy child components to isolate workspace shell and navigation logic
vi.mock('@/components/Editor/Editor', () => ({
  Editor: ({ document, onBack }: { document: { title: string }; onBack: () => void }) => (
    <div data-testid="editor-view">
      <h2>Editor: {document.title}</h2>
      <button onClick={onBack}>Editor Back</button>
    </div>
  ),
}));

vi.mock('@/components/SystemArchitect/SystemArchitect', () => ({
  SystemArchitect: ({ design, onBack }: { design: { name: string }; onBack: () => void }) => (
    <div data-testid="architect-view">
      <h2>Architect: {design.name}</h2>
      <button onClick={onBack}>Architect Back</button>
    </div>
  ),
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
    systemDesigns: { canCreate: true, used: 1, limit: 10 },
  }),
}));

describe('ProjectWorkspace Navigation & Shell Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDocs = [
      { id: 'doc-1', project_id: 'p1', title: 'Architecture Spec', content: '# Spec', format: 'markdown', updated_at: '2026-02-01T10:00:00Z' },
      { id: 'doc-2', project_id: 'p1', title: 'API Documentation', content: '# API', format: 'markdown', updated_at: '2026-02-02T10:00:00Z' },
    ];
    mockDesigns = [
      { id: 'des-1', project_id: 'p1', name: 'Microservices Mesh', board_state: { nodes: [1, 2] }, updated_at: '2026-02-03T10:00:00Z' },
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
    // Overview metrics
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

    // doc must win
    expect(screen.getByTestId('editor-view')).toBeInTheDocument();
    expect(screen.queryByTestId('architect-view')).not.toBeInTheDocument();
  });

  it('handles invalid doc parameter by showing toast error and falling back to Overview', async () => {
    renderWorkspace('/projects/p1?doc=non-existent-doc');

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Document not found');
    });

    // Falls back to overview
    expect(screen.getByText('Total Resources')).toBeInTheDocument();
    expect(screen.queryByTestId('editor-view')).not.toBeInTheDocument();
  });

  it('handles invalid design parameter by showing toast error and falling back to Overview', async () => {
    renderWorkspace('/projects/p1?design=non-existent-design');

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('System design not found');
    });

    // Falls back to overview
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

  it('handles ?action=new-design idempotently and opens creation dialog', async () => {
    renderWorkspace('/projects/p1?action=new-design');

    expect(screen.getByText('Create New System Design')).toBeInTheDocument();
  });

  it('supports large resource count (50 docs + 20 designs) without errors', () => {
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
    // 50 docs + 20 designs = 70 total
    expect(screen.getByText('70')).toBeInTheDocument();
  });
});
