import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('Draft Recovery in Editor Component', () => {
  const sampleDoc: Document = {
    id: 'doc-test-recovery-1',
    title: 'Architecture Spec',
    content: 'Original server content',
    format: 'markdown',
    updated_at: '2026-09-20T10:00:00Z',
  };

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('initializes with recovered draft and flushes save to onSave callback', async () => {
    const draftKey = `artix.draft.${sampleDoc.id}`;
    const recoveredText = 'Recovered draft from uncommitted crash session';
    localStorage.setItem(draftKey, recoveredText);

    const handleSave = vi.fn().mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <Editor document={sampleDoc} onSave={handleSave} onBack={() => {}} />
      </MemoryRouter>
    );

    // Initial state in editor should be the recovered draft
    const editorTextarea = screen.getByTestId('mock-monaco-editor') as HTMLTextAreaElement;
    expect(editorTextarea.value).toBe(recoveredText);

    // The mount effect should trigger save to flush the recovered draft to Supabase
    await waitFor(() => {
      expect(handleSave).toHaveBeenCalledWith(
        expect.objectContaining({
          id: sampleDoc.id,
          content: recoveredText,
        })
      );
    }, { timeout: 3000 });
  });

  it('silently cleans up draft and does not trigger extra save when draft matches server content', async () => {
    const draftKey = `artix.draft.${sampleDoc.id}`;
    localStorage.setItem(draftKey, sampleDoc.content); // Identical to server content

    const handleSave = vi.fn().mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <Editor document={sampleDoc} onSave={handleSave} onBack={() => {}} />
      </MemoryRouter>
    );

    const editorTextarea = screen.getByTestId('mock-monaco-editor') as HTMLTextAreaElement;
    expect(editorTextarea.value).toBe(sampleDoc.content);

    // Redundant draft should be deleted from localStorage
    expect(localStorage.getItem(draftKey)).toBeNull();

    // No auto-save should be triggered on mount
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(handleSave).not.toHaveBeenCalled();
  });

  it('initializes normally without calling onSave when no draft exists', async () => {
    const draftKey = `artix.draft.${sampleDoc.id}`;
    expect(localStorage.getItem(draftKey)).toBeNull();

    const handleSave = vi.fn().mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <Editor document={sampleDoc} onSave={handleSave} onBack={() => {}} />
      </MemoryRouter>
    );

    const editorTextarea = screen.getByTestId('mock-monaco-editor') as HTMLTextAreaElement;
    expect(editorTextarea.value).toBe(sampleDoc.content);

    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(handleSave).not.toHaveBeenCalled();
  });

  it('recovers board draft and clears localStorage after successful pipeline save', async () => {
    vi.useFakeTimers();
    const designId = 'design-test-board-1';
    const draftKey = `artix.draft.${designId}`;
    const serverBoard = {
      nodes: [{ id: 'n1', type: 'database', position: { x: 0, y: 0 }, data: { label: 'DB' } }],
      edges: [],
    };
    const uncommittedDraft = {
      nodes: [
        { id: 'n1', type: 'database', position: { x: 0, y: 0 }, data: { label: 'DB' } },
        { id: 'n2', type: 'server', position: { x: 100, y: 100 }, data: { label: 'Auth Server' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };

    localStorage.setItem(draftKey, JSON.stringify(uncommittedDraft));

    const { getRecoverableBoardDraft } = await import('@/lib/cache/draftRecovery');
    const recovered = getRecoverableBoardDraft(designId, serverBoard);
    expect(recovered).toEqual(uncommittedDraft);

    const { createDebouncedSaver } = await import('@/lib/cache/debouncedSave');
    const mockSave = vi.fn().mockResolvedValue(undefined);
    const saver = createDebouncedSaver(mockSave, 100, designId);

    saver.save(JSON.stringify(recovered));
    await vi.advanceTimersByTimeAsync(150);

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(draftKey)).toBeNull();
    vi.useRealTimers();
  });
});
