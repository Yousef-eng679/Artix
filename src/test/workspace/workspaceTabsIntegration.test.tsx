import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProjectWorkspace from '@/pages/ProjectWorkspace';
import { dirtyTracker } from '@/lib/workspace/dirtyTracker';
import { saveWorkspaceTabs } from '@/lib/workspace/tabPersistence';

// Mock modules that connect to external services or heavy engines
let mockDocs: any[] = [];
let mockDesigns: any[] = [];
let mockFolders: any[] = [];

const mockDeleteDoc = vi.fn(async (id: string) => {
  mockDocs = mockDocs.filter((d) => d.id !== id);
});
const mockDeleteDesign = vi.fn(async (id: string) => {
  mockDesigns = mockDesigns.filter((d) => d.id !== id);
});

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1' }, loading: false }),
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    projects: [{ id: 'p1', name: 'Integration Project' }],
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useDocuments', () => ({
  useDocuments: () => ({
    documents: mockDocs,
    isLoading: false,
    createDocument: vi.fn(),
    updateDocument: vi.fn(),
    deleteDocument: mockDeleteDoc,
  }),
}));

vi.mock('@/hooks/useSystemDesigns', () => ({
  useSystemDesigns: () => ({
    designs: mockDesigns,
    isLoading: false,
    createDesign: vi.fn(),
    updateDesign: vi.fn(),
    deleteDesign: mockDeleteDesign,
  }),
}));

vi.mock('@/hooks/useWorkspaceFolders', () => ({
  useWorkspaceFolders: () => ({
    folders: mockFolders,
    isLoading: false,
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    isCreatingFolder: false,
  }),
}));

vi.mock('@/hooks/useUsageLimits', () => ({
  useUsageLimits: () => ({
    documents: { canCreate: true, used: 2, limit: 10 },
    systemDesigns: { canCreate: true, used: 1, limit: 10 },
  }),
}));

// Mock Editor and SystemArchitect
vi.mock('@/components/Editor/Editor', () => ({
  Editor: ({ document }: { document: any }) => (
    <div data-testid="editor-view" data-doc-id={document.id}>
      <h1>Editor: {document.title}</h1>
    </div>
  ),
}));

vi.mock('@/components/SystemArchitect/SystemArchitect', () => ({
  SystemArchitect: ({ design }: { design: any }) => (
    <div data-testid="architect-view" data-design-id={design.id}>
      <h1>Architect: {design.name}</h1>
    </div>
  ),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Workspace Tabs Integration Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    dirtyTracker.clear();

    mockDocs = [
      {
        id: 'doc-1',
        project_id: 'p1',
        title: 'Auth PRD',
        content: '# PRD',
        format: 'markdown',
        updated_at: '2026-09-24T00:00:00Z',
        folder_id: null,
      },
      {
        id: 'doc-2',
        project_id: 'p1',
        title: 'Database Schema',
        content: '# Schema',
        format: 'markdown',
        updated_at: '2026-09-24T00:00:00Z',
        folder_id: null,
      },
    ];

    mockDesigns = [
      {
        id: 'des-1',
        project_id: 'p1',
        name: 'System Architecture',
        board_state: { nodes: [] },
        updated_at: '2026-09-24T00:00:00Z',
        folder_id: null,
      },
    ];

    mockFolders = [];
  });

  const renderWorkspace = (initialEntry: string = '/projects/p1') => {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/projects/:id" element={<ProjectWorkspace />} />
        </Routes>
      </MemoryRouter>,
    );
  };

  it('opens documents and designs in tabs from the sidebar and renders only the active resource', async () => {
    renderWorkspace('/projects/p1');

    // Initially in Overview mode
    expect(screen.getByText('Continue Working')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();

    const sidebar = screen.getByLabelText('Project Workspace Sidebar');

    // 1. Click "Auth PRD" in sidebar
    fireEvent.click(within(sidebar).getByText('Auth PRD'));

    // Verify TabBar appears with Auth PRD tab active
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    const docTab = within(screen.getByRole('tablist')).getByRole('tab', { name: /Auth PRD/i });
    expect(docTab).toHaveAttribute('aria-selected', 'true');

    // Verify Editor is mounted for Auth PRD
    expect(screen.getByTestId('editor-view')).toHaveAttribute('data-doc-id', 'doc-1');
    expect(screen.queryByTestId('architect-view')).not.toBeInTheDocument();

    // 2. Click "System Architecture" design in sidebar
    fireEvent.click(within(sidebar).getByText('System Architecture'));

    // Verify both tabs exist in TabBar, and design is now active
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(within(screen.getByRole('tablist')).getByRole('tab', { name: /System Architecture/i })).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('tablist')).getByRole('tab', { name: /Auth PRD/i })).toHaveAttribute('aria-selected', 'false');

    // Verify SystemArchitect is now mounted, Editor unmounted (no concurrent heavy mounting!)
    expect(screen.getByTestId('architect-view')).toHaveAttribute('data-design-id', 'des-1');
    expect(screen.queryByTestId('editor-view')).not.toBeInTheDocument();

    // 3. Switch back by clicking "Auth PRD" tab directly in TabBar
    fireEvent.click(within(screen.getByRole('tablist')).getByText('Auth PRD'));

    expect(within(screen.getByRole('tablist')).getByRole('tab', { name: /Auth PRD/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('editor-view')).toHaveAttribute('data-doc-id', 'doc-1');
  });

  it('clicking Overview keeps all open tabs in TabBar and deactivates active tab', async () => {
    renderWorkspace('/projects/p1?doc=doc-1');

    const sidebar = screen.getByLabelText('Project Workspace Sidebar');

    // Open second tab from sidebar
    fireEvent.click(within(sidebar).getByText('System Architecture'));

    expect(within(screen.getByRole('tablist')).getAllByRole('tab')).toHaveLength(2);

    // Click Overview in sidebar
    const overviewBtn = within(sidebar).getByRole('button', { name: /Project Overview/i });
    fireEvent.click(overviewBtn);

    // Overview content renders
    expect(screen.getByText('Continue Working')).toBeInTheDocument();

    // TabBar remains visible with both tabs, none active
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(within(screen.getByRole('tablist')).getAllByRole('tab')).toHaveLength(2);
    expect(within(screen.getByRole('tablist')).getByRole('tab', { name: /Auth PRD/i })).toHaveAttribute('aria-selected', 'false');
    expect(within(screen.getByRole('tablist')).getByRole('tab', { name: /System Architecture/i })).toHaveAttribute('aria-selected', 'false');

    // Clicking any tab returns directly to that resource
    fireEvent.click(within(screen.getByRole('tablist')).getByRole('tab', { name: /Auth PRD/i }));
    expect(screen.getByTestId('editor-view')).toBeInTheDocument();
  });

  it('protects closing dirty tabs with confirmation dialog', async () => {
    renderWorkspace('/projects/p1?doc=doc-1');

    // Mark doc-1 as dirty inside act()
    act(() => {
      dirtyTracker.markDirty('doc-1');
    });

    // Verify dirty indicator shows in TabBar
    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument();

    // Try to close tab
    const closeBtn = screen.getByLabelText('Close Auth PRD');
    fireEvent.click(closeBtn);

    // Confirmation dialog must appear
    expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
    expect(screen.getByText(/"Auth PRD"/i)).toBeInTheDocument();

    // Click "Keep Tab Open"
    fireEvent.click(screen.getByRole('button', { name: /Keep Tab Open/i }));

    // Tab remains open
    expect(within(screen.getByRole('tablist')).getByRole('tab', { name: /Auth PRD/i })).toBeInTheDocument();

    // Try to close again, this time click "Close Tab" (discard)
    fireEvent.click(screen.getByLabelText('Close Auth PRD'));
    fireEvent.click(screen.getByRole('button', { name: /Close Tab/i }));

    // Tab is closed
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /Auth PRD/i })).not.toBeInTheDocument();
    });
  });

  it('restores open tabs across mounts from project persistence', async () => {
    saveWorkspaceTabs('p1', [
      { id: 'document:doc-1', resourceKind: 'document', resourceId: 'doc-1' },
      { id: 'design:des-1', resourceKind: 'design', resourceId: 'des-1' },
    ]);

    renderWorkspace('/projects/p1?doc=doc-1');

    // Both tabs restored
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(within(screen.getByRole('tablist')).getByRole('tab', { name: /Auth PRD/i })).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('tablist')).getByRole('tab', { name: /System Architecture/i })).toHaveAttribute('aria-selected', 'false');
  });

  it('deep link automatically adds the resource to tabs if not already present', async () => {
    renderWorkspace('/projects/p1?design=des-1');

    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(within(screen.getByRole('tablist')).getByRole('tab', { name: /System Architecture/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('architect-view')).toBeInTheDocument();
  });
});
