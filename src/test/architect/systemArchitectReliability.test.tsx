import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import React from 'react';
import * as tabCloseGuardModule from '@/lib/cache/tabCloseGuard';
import * as saveQueueModule from '@/lib/cache/saveQueue';
import * as debouncedSaveModule from '@/lib/cache/debouncedSave';
import { dirtyTracker } from '@/lib/workspace/dirtyTracker';
import { SystemArchitect } from '@/components/SystemArchitect/SystemArchitect';
import type { BoardState, SystemDesign } from '@/hooks/useSystemDesigns';

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/components/AI/ArchitectureGeneratorDialog', () => ({
  ArchitectureGeneratorDialog: () => null,
}));

// Polyfill browser layout primitives required by real @xyflow/react in jsdom
class MockResizeObserver {
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: {
            width: 800,
            height: 600,
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            bottom: 600,
            right: 800,
            toJSON: () => ({}),
          },
          borderBoxSize: [{ inlineSize: 800, blockSize: 600 }],
          contentBoxSize: [{ inlineSize: 800, blockSize: 600 }],
          devicePixelContentBoxSize: [{ inlineSize: 800, blockSize: 600 }],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

class MockDOMMatrixReadOnly {
  m22 = 1;
  constructor(_init?: string | number[]) {}
}

describe('TASK-19: SystemArchitect Canvas Reliability & Persistence', () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalDOMMatrixReadOnly = (globalThis as any).DOMMatrixReadOnly;
  const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    dirtyTracker.clear();

    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    (globalThis as any).DOMMatrixReadOnly = MockDOMMatrixReadOnly;
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      value: 600,
    });
  });

  afterEach(() => {
    cleanup();
    dirtyTracker.clear();
    localStorage.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();

    globalThis.ResizeObserver = originalResizeObserver;
    (globalThis as any).DOMMatrixReadOnly = originalDOMMatrixReadOnly;
    if (originalOffsetWidth) {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
    }
    if (originalOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
    }
  });

  function makeDesign(overrides: Partial<SystemDesign> = {}): SystemDesign {
    return {
      id: 'design-rel-1',
      project_id: 'proj-1',
      user_id: 'user-1',
      name: 'Core Architecture',
      board_state: {
        nodes: [
          {
            id: 'node-2',
            type: 'database',
            position: { x: 120, y: 140 },
            data: { label: 'Initial DB' },
          },
        ],
        edges: [],
        strokes: [],
      },
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
      local_revision: 1,
      ...overrides,
    };
  }

  it('1. persists inline ArchitectNode label edits on blur and reflects external data.label updates when clean', async () => {
    const onSave = vi.fn().mockResolvedValue({
      local_revision: 2,
      updated_at: '2026-03-01T00:01:00.000Z',
    });
    const design = makeDesign();

    const { rerender } = render(
      <SystemArchitect design={design} onSave={onSave} onBack={vi.fn()} />,
    );

    const nodeLabel = screen.getByText('Initial DB');
    const nodeEl = nodeLabel.closest('.architect-node')!;
    expect(nodeEl).toBeTruthy();

    // Double-click node to enter inline label editing
    fireEvent.doubleClick(nodeEl);
    const input = screen.getByDisplayValue('Initial DB');
    fireEvent.change(input, { target: { value: 'Analytics Warehouse' } });
    fireEvent.blur(input);

    // Advance past 1000ms auto-save debounce
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const savedBoard = onSave.mock.calls[0][0] as BoardState;
    expect(savedBoard.nodes[0].data.label).toBe('Analytics Warehouse');

    // Now simulate clean remote update changing node label externally
    const remoteUpdatedDesign = makeDesign({
      local_revision: 3,
      updated_at: '2026-03-01T00:02:00.000Z',
      board_state: {
        nodes: [
          {
            id: 'node-2',
            type: 'database',
            position: { x: 120, y: 140 },
            data: { label: 'Remote Replicated DB' },
          },
        ],
        edges: [],
        strokes: [],
      },
    });

    rerender(
      <SystemArchitect design={remoteUpdatedDesign} onSave={onSave} onBack={vi.fn()} />,
    );

    expect(screen.getByText('Remote Replicated DB')).toBeInTheDocument();
  });

  it('2. preserves custom node color across save and remount round-trips', async () => {
    const onSave = vi.fn().mockResolvedValue({
      local_revision: 2,
      updated_at: '2026-03-01T00:01:00.000Z',
    });
    const design = makeDesign({
      board_state: { nodes: [], edges: [], strokes: [] },
    });

    const { unmount } = render(
      <SystemArchitect design={design} onSave={onSave} onBack={vi.fn()} />,
    );

    // Open "Add Node" dropdown and choose Custom Node
    const addNodeTrigger = screen.getByRole('button', { name: /Add Node/i });
    fireEvent.keyDown(addNodeTrigger, { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: /Custom/i }));

    // Fill Custom Node dialog with custom label and purple color
    const nameInput = screen.getByLabelText(/Node Name/i);
    fireEvent.change(nameInput, { target: { value: 'Purple Cache' } });
    fireEvent.click(screen.getByRole('button', { name: /^purple$/i }));
    // Click "Add Node" inside dialog footer
    const dialogButtons = screen.getAllByRole('button', { name: /^Add Node$/i });
    fireEvent.click(dialogButtons[dialogButtons.length - 1]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const savedBoard = onSave.mock.calls[0][0] as BoardState;
    expect(savedBoard.nodes).toHaveLength(1);
    expect(savedBoard.nodes[0].data.label).toBe('Purple Cache');
    expect(savedBoard.nodes[0].data.color).toBe('purple');

    unmount();

    // Remount with saved board_state and verify purple styling is retained
    const reloadedDesign = makeDesign({
      local_revision: 2,
      board_state: savedBoard,
    });
    render(<SystemArchitect design={reloadedDesign} onSave={onSave} onBack={vi.fn()} />);

    const renderedCustomNode = screen.getByText('Purple Cache').closest('.architect-node')!;
    expect(renderedCustomNode.className).toContain('bg-purple-500/20');
  });

  it('3. generates collision-free UUID node IDs when adding nodes onto a board containing node-2', async () => {
    const onSave = vi.fn().mockResolvedValue({
      local_revision: 2,
      updated_at: '2026-03-01T00:01:00.000Z',
    });
    // Board already has 1 node with id "node-2" (e.g. after node-1 was deleted in a prior session)
    const design = makeDesign();

    render(<SystemArchitect design={design} onSave={onSave} onBack={vi.fn()} />);

    // Open "Add Node" dropdown and add a new Database node from the palette
    const addNodeTrigger = screen.getByRole('button', { name: /Add Node/i });
    fireEvent.keyDown(addNodeTrigger, { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: /Database/i }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const savedBoard = onSave.mock.calls[0][0] as BoardState;
    expect(savedBoard.nodes).toHaveLength(2);
    const ids = savedBoard.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(2);
    const addedNodeId = ids.find((id) => id !== 'node-2')!;
    expect(addedNodeId).toBeDefined();
    expect(addedNodeId).not.toBe('node-2');
    // Verify UUID-based ID rather than sequential integer counter
    expect(addedNodeId).toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it('4. does NOT mark dirty, write localStorage draft, or trigger onSave on mount measurement or node selection', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const design = makeDesign();

    render(<SystemArchitect design={design} onSave={onSave} onBack={vi.fn()} />);

    // Click node to select it (triggers ReactFlow selection change without modifying persisted board state)
    const nodeEl = screen.getByText('Initial DB').closest('.architect-node')!;
    fireEvent.click(nodeEl);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(dirtyTracker.isDirty(design.id)).toBe(false);
    const draftCalls = setItemSpy.mock.calls.filter(([key]) =>
      key.startsWith(`artix.draft.design-${design.id}`),
    );
    expect(draftCalls).toHaveLength(0);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('5. does NOT re-instantiate tabCloseGuard, saveQueue, or debouncedSaver on re-renders', () => {
    const guardSpy = vi.spyOn(tabCloseGuardModule, 'createTabCloseGuard');
    const queueSpy = vi.spyOn(saveQueueModule, 'createSaveQueue');
    const saverSpy = vi.spyOn(debouncedSaveModule, 'createDebouncedSaver');

    const design = makeDesign();
    const onSave = vi.fn().mockResolvedValue({});

    const { rerender } = render(
      <SystemArchitect design={design} onSave={onSave} onBack={vi.fn()} documents={[]} />,
    );

    rerender(
      <SystemArchitect
        design={design}
        onSave={onSave}
        onBack={vi.fn()}
        documents={[{ id: 'd1', title: 'Spec', content: '# Spec' }]}
      />,
    );
    rerender(
      <SystemArchitect
        design={design}
        onSave={onSave}
        onBack={vi.fn()}
        documents={[{ id: 'd1', title: 'Spec 2', content: '# Spec 2' }]}
      />,
    );

    expect(guardSpy).toHaveBeenCalledTimes(1);
    expect(queueSpy).toHaveBeenCalledTimes(1);
    expect(saverSpy).toHaveBeenCalledTimes(1);
  });

  it('6. provides canonical boardSerializer module that round-trips nodes, custom colors, edges, and strokes', async () => {
    const serializerModPath = '../../components/SystemArchitect/boardSerializer';
    const serializer = await import(/* @vite-ignore */ serializerModPath);

    const inputBoard: BoardState = {
      nodes: [
        {
          id: 'n-custom',
          type: 'custom',
          position: { x: 42, y: 84 },
          data: { label: 'Gateway', description: 'Edge proxy', color: 'cyan' },
        },
      ],
      edges: [
        {
          id: 'e-1',
          source: 'n-custom',
          target: 'n-custom',
          label: 'loopback',
        },
      ],
      strokes: [
        {
          points: [
            { x: 1, y: 2 },
            { x: 10, y: 20 },
          ],
          color: '#3b82f6',
          width: 4,
        },
      ],
    };

    const flow = serializer.deserializeBoardToFlow(inputBoard);
    expect(flow.nodes[0].data.color).toBe('cyan');

    const roundTripped = serializer.serializeFlowToBoard(
      flow.nodes,
      flow.edges,
      flow.strokes,
    );
    expect(roundTripped).toEqual(inputBoard);
    expect(serializer.serializeBoardCanonical(inputBoard)).toBe(JSON.stringify(roundTripped));
  });
});
