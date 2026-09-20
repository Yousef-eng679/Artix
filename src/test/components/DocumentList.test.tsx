import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { DocumentList } from '@/components/DocumentList';
import { Document } from '@/components/Editor/Editor';

describe('DocumentList Component', () => {
  const onSelect = vi.fn();
  const onDelete = vi.fn();
  const onCreate = vi.fn();

  const sampleDocs: Document[] = [
    {
      id: 'doc-1',
      title: 'Architecture Overview',
      content: '# Heading',
      format: 'markdown',
      updated_at: new Date().toISOString(),
    },
    {
      id: 'doc-2',
      title: 'Config Schema',
      content: '<xml></xml>',
      format: 'xml',
      updated_at: new Date().toISOString(),
    },
  ];

  it('should render empty state when document list is empty', () => {
    render(
      <DocumentList
        documents={[]}
        onSelect={onSelect}
        onDelete={onDelete}
        onCreate={onCreate}
      />
    );

    expect(screen.getByText('No documents yet')).toBeInTheDocument();
    expect(screen.getByText(/Create your first document to start writing/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create document/i })).toBeInTheDocument();
  });

  it('should call onCreate when clicking New Document button in header', () => {
    render(
      <DocumentList
        documents={sampleDocs}
        onSelect={onSelect}
        onDelete={onDelete}
        onCreate={onCreate}
      />
    );

    const newBtn = screen.getByRole('button', { name: /new document/i });
    fireEvent.click(newBtn);

    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('should render document titles and format badges', () => {
    render(
      <DocumentList
        documents={sampleDocs}
        onSelect={onSelect}
        onDelete={onDelete}
        onCreate={onCreate}
      />
    );

    expect(screen.getByText('Architecture Overview')).toBeInTheDocument();
    expect(screen.getByText('Config Schema')).toBeInTheDocument();
    expect(screen.getByText('Markdown')).toBeInTheDocument();
    expect(screen.getByText('XML')).toBeInTheDocument();
  });

  it('should call onSelect when a document row is clicked', () => {
    render(
      <DocumentList
        documents={sampleDocs}
        onSelect={onSelect}
        onDelete={onDelete}
        onCreate={onCreate}
      />
    );

    const docRow = screen.getByText('Architecture Overview');
    fireEvent.click(docRow);

    expect(onSelect).toHaveBeenCalledWith(sampleDocs[0]);
  });

  it('should display loading state when isCreating is true', () => {
    render(
      <DocumentList
        documents={sampleDocs}
        onSelect={onSelect}
        onDelete={onDelete}
        onCreate={onCreate}
        isCreating={true}
      />
    );

    const btn = screen.getByRole('button', { name: /creating\.\.\./i });
    expect(btn).toBeDisabled();
  });
});
