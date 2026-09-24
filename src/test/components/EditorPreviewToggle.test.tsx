import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { Editor, Document } from '@/components/Editor/Editor';

// Mock Monaco Editor for jsdom
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (val: string) => void }) => (
    <textarea
      data-testid="mock-monaco-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

// Mock MarkdownPreview to assert mounting/unmounting cleanly
vi.mock('@/components/Editor/MarkdownPreview', () => ({
  MarkdownPreview: ({ content }: { content: string }) => (
    <div data-testid="markdown-preview-pane">{content}</div>
  ),
}));

// Mock AI Dialogs to keep test fast and focused
vi.mock('@/components/AI/PRDGeneratorDialog', () => ({
  PRDGeneratorDialog: () => null,
}));
vi.mock('@/components/AI/VibeCodingDialog', () => ({
  VibeCodingDialog: () => null,
}));
vi.mock('@/components/AI/AgenticWorkflowDialog', () => ({
  AgenticWorkflowDialog: () => null,
}));

describe('Editor Markdown Preview Toggle Feature', () => {
  const markdownDoc: Document = {
    id: 'doc-preview-toggle-1',
    title: 'Product Requirements',
    content: '# Overview\n\nThis is a sample PRD.',
    format: 'markdown',
    updated_at: '2026-09-23T10:00:00Z',
  };

  const jsonDoc: Document = {
    id: 'doc-json-1',
    title: 'Configuration',
    content: '{ "enabled": true }',
    format: 'json',
    updated_at: '2026-09-23T10:00:00Z',
  };

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('renders toggle preview button in markdown mode and defaults to preview open', () => {
    render(
      <MemoryRouter>
        <Editor document={markdownDoc} onSave={vi.fn()} onBack={vi.fn()} />
      </MemoryRouter>
    );

    // Toggle button should be present
    const toggleBtn = screen.getByLabelText('Toggle markdown preview');
    expect(toggleBtn).toBeInTheDocument();
    expect(toggleBtn).toHaveAttribute('title', 'Hide Preview');

    // Both Monaco editor and MarkdownPreview pane should be visible
    expect(screen.getByTestId('mock-monaco-editor')).toBeInTheDocument();
    expect(screen.getByTestId('markdown-preview-pane')).toBeInTheDocument();
  });

  it('clicking toggle button hides preview and persists preference to localStorage', () => {
    render(
      <MemoryRouter>
        <Editor document={markdownDoc} onSave={vi.fn()} onBack={vi.fn()} />
      </MemoryRouter>
    );

    const toggleBtn = screen.getByLabelText('Toggle markdown preview');
    fireEvent.click(toggleBtn);

    // MarkdownPreview should be unmounted / hidden
    expect(screen.queryByTestId('markdown-preview-pane')).not.toBeInTheDocument();
    // Monaco editor expands full-width and remains rendered
    expect(screen.getByTestId('mock-monaco-editor')).toBeInTheDocument();

    // Button updates title and label
    expect(toggleBtn).toHaveAttribute('title', 'Show Preview');

    // Preference should be stored in localStorage
    expect(localStorage.getItem('artix.editor.showPreview')).toBe('false');
  });

  it('clicking toggle button again restores preview and updates localStorage', () => {
    render(
      <MemoryRouter>
        <Editor document={markdownDoc} onSave={vi.fn()} onBack={vi.fn()} />
      </MemoryRouter>
    );

    const toggleBtn = screen.getByLabelText('Toggle markdown preview');

    // Hide preview
    fireEvent.click(toggleBtn);
    expect(screen.queryByTestId('markdown-preview-pane')).not.toBeInTheDocument();

    // Show preview again
    fireEvent.click(toggleBtn);
    expect(screen.getByTestId('markdown-preview-pane')).toBeInTheDocument();
    expect(localStorage.getItem('artix.editor.showPreview')).toBe('true');
  });

  it('initializes with preview closed if user preference in localStorage was false', () => {
    localStorage.setItem('artix.editor.showPreview', 'false');

    render(
      <MemoryRouter>
        <Editor document={markdownDoc} onSave={vi.fn()} onBack={vi.fn()} />
      </MemoryRouter>
    );

    // Preview should be closed on initial mount
    expect(screen.queryByTestId('markdown-preview-pane')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-monaco-editor')).toBeInTheDocument();

    const toggleBtn = screen.getByLabelText('Toggle markdown preview');
    expect(toggleBtn).toHaveAttribute('title', 'Show Preview');
  });

  it('omits toggle preview button when document format is not markdown', () => {
    render(
      <MemoryRouter>
        <Editor document={jsonDoc} onSave={vi.fn()} onBack={vi.fn()} />
      </MemoryRouter>
    );

    // Toggle button should NOT exist for JSON documents
    expect(screen.queryByLabelText('Toggle markdown preview')).not.toBeInTheDocument();
    expect(screen.queryByTestId('markdown-preview-pane')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-monaco-editor')).toBeInTheDocument();
  });
});
