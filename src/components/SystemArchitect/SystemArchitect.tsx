import { useCallback, useRef, useEffect, useState, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  Connection,
  ConnectionLineType,
  Panel,
  MarkerType,
  Position,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowLeft, Save, Plus, Pencil, Network, FlaskConical, Palette, Sparkles,
  Database, Server, Monitor, Cloud, Cpu, HardDrive,
  LayoutList, ArrowUpDown, Repeat, Split,
  GitBranch, Circle, CheckCircle, ListOrdered, Layers,
  Link, Hash, Triangle, Variable, MousePointer,
  HelpCircle, Terminal, Check, Loader2, AlertCircle, AlertTriangle,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArchitectureGeneratorDialog } from '@/components/AI/ArchitectureGeneratorDialog';
import dagre from '@dagrejs/dagre';
import { createDebouncedSaver, type DebouncedSaver } from '@/lib/cache/debouncedSave';
import { createTabCloseGuard, type TabCloseGuard } from '@/lib/cache/tabCloseGuard';
import { createSaveQueue, type SaveQueue } from '@/lib/cache/saveQueue';
import { getRecoverableBoardDraft } from '@/lib/cache/draftRecovery';
import { dirtyTracker } from '@/lib/workspace/dirtyTracker';
import { StaleBufferError } from '@/lib/local/errors';
import { Button } from '@/components/ui/button';
import { SystemDesign, BoardState } from '@/hooks/useSystemDesigns';
import { ArchitectNode } from './ArchitectNode';
import { DrawingCanvas, Stroke } from './DrawingCanvas';
import {
  deserializeBoardToFlow,
  serializeFlowToBoard,
  serializeBoardCanonical,
  getIconFromType,
  getColorFromType,
  type ArchitectFlowNode,
} from './boardSerializer';
import { cn } from '@/lib/utils';
import { systemDesignTemplates, algorithmTemplates, NodeTemplate } from './AlgorithmNodeTemplates';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const nodeTypes = {
  architect: ArchitectNode,
};

const allIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  Database, Server, Monitor, Cloud, Cpu, HardDrive,
  LayoutList, ArrowUpDown, Repeat, Split,
  GitBranch, Circle, CheckCircle, ListOrdered, Layers,
  Link, Hash, Triangle, Variable, MousePointer,
  HelpCircle, Terminal, Palette,
};

interface SystemArchitectProps {
  design: SystemDesign;
  onSave: (boardState: BoardState, options?: { expectedLocalRevision?: number }) => Promise<unknown>;
  onUpdateName?: (name: string) => Promise<unknown>;
  onSaveAsCopy?: (copy: { name: string; boardState: BoardState }) => Promise<unknown>;
  onBack: () => void;
  documents?: Array<{ id: string; title: string; content: string }>;
}

export function SystemArchitect({
  design,
  onSave,
  onUpdateName,
  onSaveAsCopy,
  onBack,
  documents = [],
}: SystemArchitectProps) {
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [staleRemoteDesign, setStaleRemoteDesign] = useState<SystemDesign | null>(null);

  // Check for recovered draft (Task §2.3) across mount only
  const initialRecoveredDraft = useMemo(() => {
    return getRecoverableBoardDraft<BoardState>(`design-${design.id}`, design.board_state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design.id]);

  const initialFlow = useMemo(
    () => deserializeBoardToFlow(initialRecoveredDraft ?? design.board_state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [design.id],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<ArchitectFlowNode>(initialFlow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialFlow.edges);

  // Edge label editing state
  const [editingEdge, setEditingEdge] = useState<Edge | null>(null);
  const [edgeLabelInput, setEdgeLabelInput] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [designName, setDesignName] = useState(design.name);
  const [mode, setMode] = useState<'system' | 'algorithm'>('system');
  const [isDrawing, setIsDrawing] = useState(false);
  const [strokes, setStrokes] = useState<Stroke[]>(initialFlow.strokes);
  const [customNodeDialog, setCustomNodeDialog] = useState(false);
  const [customNodeColor, setCustomNodeColor] = useState('blue');
  const [customNodeLabel, setCustomNodeLabel] = useState('Custom Node');
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false);

  // Track base revision & canonical board snapshot from which local buffer was derived
  const baseRef = useRef({
    localRevision: design.local_revision,
    updatedAt: design.updated_at,
    name: design.name,
    serializedBoard: serializeBoardCanonical(design.board_state),
  });
  const staleRef = useRef<SystemDesign | null>(null);
  const applyingRemoteRef = useRef(false);
  const latestPropDesignRef = useRef(design);
  latestPropDesignRef.current = design;

  const isDragging = useMemo(() => nodes.some((n) => Boolean(n.dragging)), [nodes]);

  const currentSerializedRef = useRef<string>(baseRef.current.serializedBoard);
  if (!isDragging) {
    currentSerializedRef.current = JSON.stringify(serializeFlowToBoard(nodes, edges, strokes));
  }
  const designNameRef = useRef(designName);
  designNameRef.current = designName;

  // Escape key exits draw mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isDrawing) {
        setIsDrawing(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDrawing]);

  const groupedTemplates = mode === 'algorithm'
    ? algorithmTemplates.reduce<Record<string, NodeTemplate[]>>((acc, t) => {
        const cat = t.category || 'Other';
        (acc[cat] = acc[cat] || []).push(t);
        return acc;
      }, {})
    : null;

  // Store onSave callback in ref to prevent infinite loops when reference changes
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  // --- Shared auto-save with debounce + serial queue + tab-close protection (lazy-initialized once) ---
  const guardRef = useRef<TabCloseGuard | null>(null);
  if (!guardRef.current) {
    guardRef.current = createTabCloseGuard();
  }

  const queueRef = useRef<SaveQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = createSaveQueue(async (payload) => {
      if (staleRef.current) {
        return { updated_at: baseRef.current.updatedAt };
      }
      const boardState: BoardState = JSON.parse(payload.content);
      const expectedLocalRevision = baseRef.current.localRevision;
      const res = (await onSaveRef.current(
        boardState,
        expectedLocalRevision !== undefined ? { expectedLocalRevision } : undefined,
      )) as Partial<SystemDesign> | undefined;

      baseRef.current = {
        localRevision: res?.local_revision ?? baseRef.current.localRevision,
        updatedAt: res?.updated_at ?? baseRef.current.updatedAt,
        name: designNameRef.current,
        serializedBoard: payload.content,
      };
      return { updated_at: res?.updated_at || new Date().toISOString() };
    });
  }

  const saverRef = useRef<DebouncedSaver | null>(null);
  if (!saverRef.current) {
    saverRef.current = createDebouncedSaver(
      async (content: string) => {
        if (staleRef.current) return;
        try {
          setSaveStatus('saving');
          await queueRef.current!.enqueue({ id: design.id, content });
          guardRef.current!.markClean(design.id);
          dirtyTracker.markClean(design.id);
          setSaveStatus('saved');
          setTimeout(() => setSaveStatus('idle'), 2000);
        } catch (err: any) {
          if (err instanceof StaleBufferError || err?.code === 'STALE_BUFFER') {
            saverRef.current?.cancel();
            staleRef.current = latestPropDesignRef.current;
            setStaleRemoteDesign(latestPropDesignRef.current);
          } else {
            console.error('Canvas auto-save failed:', err);
          }
          setSaveStatus('error');
        }
      },
      1000,
      `design-${design.id}`,
    );
  }

  // Cleanup on unmount
  useEffect(() => {
    const guard = guardRef.current!;
    const saver = saverRef.current!;
    const onBeforeUnload = () => {
      if (!staleRef.current) {
        saver.flushSync();
        guard.handleBeforeUnload();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      saver.cancel();
      guard.destroy();
    };
  }, []);

  const triggerAutoSave = useCallback(() => {
    if (staleRef.current || isDragging) return;
    const serialized = JSON.stringify(serializeFlowToBoard(nodes, edges, strokes));

    // Ignore non-persisted changes (selection, hover, ResizeObserver dimensions, or reverted edits)
    if (serialized === baseRef.current.serializedBoard) {
      if (saverRef.current?.hasPending()) {
        saverRef.current.cancel();
      }
      try {
        localStorage.removeItem(`artix.draft.design-${design.id}`);
      } catch {
        // ignore
      }
      guardRef.current?.markClean(design.id);
      dirtyTracker.markClean(design.id);
      return;
    }

    guardRef.current!.markDirty(design.id, serialized);
    dirtyTracker.markDirty(design.id);
    saverRef.current!.save(serialized);
  }, [nodes, edges, strokes, design.id, isDragging]);

  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      if (initialRecoveredDraft) {
        triggerAutoSave();
      }
      return;
    }
    if (applyingRemoteRef.current) {
      applyingRemoteRef.current = false;
      return;
    }
    if (isDragging) {
      return;
    }
    triggerAutoSave();
  }, [nodes, edges, strokes, isDragging, triggerAutoSave, initialRecoveredDraft]);

  // Reconcile incoming remote / cross-tab updates against clean vs dirty board state
  useEffect(() => {
    const incomingSerialized = serializeBoardCanonical(design.board_state);
    const revisionChanged =
      design.local_revision !== undefined &&
      baseRef.current.localRevision !== undefined &&
      design.local_revision !== baseRef.current.localRevision;
    const payloadDiffersFromBase =
      incomingSerialized !== baseRef.current.serializedBoard ||
      design.name !== baseRef.current.name;

    if (!revisionChanged && !payloadDiffersFromBase) {
      if (design.local_revision !== undefined) {
        baseRef.current.localRevision = design.local_revision;
      }
      baseRef.current.updatedAt = design.updated_at;
      return;
    }

    const isDirty =
      currentSerializedRef.current !== baseRef.current.serializedBoard ||
      designNameRef.current !== baseRef.current.name;

    if (!isDirty && !staleRef.current) {
      const nextFlow = deserializeBoardToFlow(design.board_state);
      applyingRemoteRef.current = true;
      setNodes(nextFlow.nodes);
      setEdges(nextFlow.edges);
      setStrokes(nextFlow.strokes);
      setDesignName(design.name);
      baseRef.current = {
        localRevision: design.local_revision,
        updatedAt: design.updated_at,
        name: design.name,
        serializedBoard: incomingSerialized,
      };
    } else {
      saverRef.current?.cancel();
      staleRef.current = design;
      setStaleRemoteDesign(design);
    }
  }, [
    design,
    design.local_revision,
    design.updated_at,
    design.name,
    design.board_state,
    setNodes,
    setEdges,
  ]);

  const handleLoadRemote = useCallback(() => {
    const target = staleRef.current || latestPropDesignRef.current;
    saverRef.current?.cancel();
    try {
      localStorage.removeItem(`artix.draft.design-${design.id}`);
    } catch {
      // ignore
    }
    guardRef.current?.markClean(design.id);
    dirtyTracker.markClean(design.id);

    const incomingSerialized = serializeBoardCanonical(target.board_state);
    const nextFlow = deserializeBoardToFlow(target.board_state);
    applyingRemoteRef.current = true;
    setNodes(nextFlow.nodes);
    setEdges(nextFlow.edges);
    setStrokes(nextFlow.strokes);
    setDesignName(target.name);
    baseRef.current = {
      localRevision: target.local_revision,
      updatedAt: target.updated_at,
      name: target.name,
      serializedBoard: incomingSerialized,
    };
    staleRef.current = null;
    setStaleRemoteDesign(null);
  }, [design.id, setNodes, setEdges]);

  const handleKeepMine = useCallback(async () => {
    const target = staleRef.current || latestPropDesignRef.current;
    baseRef.current.localRevision = target.local_revision;
    baseRef.current.updatedAt = target.updated_at;
    staleRef.current = null;
    setStaleRemoteDesign(null);

    setSaveStatus('saving');
    try {
      const boardState = serializeFlowToBoard(nodes, edges, strokes);
      const serialized = JSON.stringify(boardState);
      const res = (await onSave(
        boardState,
        target.local_revision !== undefined
          ? { expectedLocalRevision: target.local_revision }
          : undefined,
      )) as Partial<SystemDesign> | undefined;
      baseRef.current = {
        localRevision: res?.local_revision ?? target.local_revision,
        updatedAt: res?.updated_at ?? target.updated_at,
        name: designNameRef.current,
        serializedBoard: serialized,
      };
      try {
        localStorage.removeItem(`artix.draft.design-${design.id}`);
      } catch {
        // ignore
      }
      guardRef.current?.markClean(design.id);
      dirtyTracker.markClean(design.id);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
    }
  }, [design.id, nodes, edges, strokes, onSave]);

  const handleSaveMineAsCopy = useCallback(async () => {
    if (!onSaveAsCopy) return;
    await onSaveAsCopy({
      name: `${designNameRef.current} (Copy)`,
      boardState: serializeFlowToBoard(nodes, edges, strokes),
    });
    handleLoadRemote();
  }, [onSaveAsCopy, nodes, edges, strokes, handleLoadRemote]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            type: 'smoothstep',
            label: '',
            markerEnd: { type: MarkerType.ArrowClosed, color: '#F59E0B', width: 20, height: 20 },
            style: { stroke: '#F59E0B', strokeWidth: 2 },
            labelStyle: { fill: 'hsl(var(--foreground))', fontWeight: 500 },
            labelBgStyle: { fill: 'hsl(var(--card))', fillOpacity: 0.9 },
            labelBgPadding: [8, 4] as [number, number],
            labelBgBorderRadius: 4,
          },
          eds
        )
      );
    },
    [setEdges]
  );

  const onEdgeDoubleClick = useCallback((_event: React.MouseEvent, edge: Edge) => {
    setEditingEdge(edge);
    setEdgeLabelInput((edge.label as string) || '');
  }, []);

  const handleEdgeLabelSave = useCallback(() => {
    if (editingEdge) {
      setEdges((eds) =>
        eds.map((e) =>
          e.id === editingEdge.id
            ? { ...e, label: edgeLabelInput }
            : e
        )
      );
      setEditingEdge(null);
      setEdgeLabelInput('');
    }
  }, [editingEdge, edgeLabelInput, setEdges]);

  const addNode = (template: NodeTemplate, overrideColor?: string, overrideLabel?: string) => {
    if (template.type === 'custom' && !overrideColor) {
      setCustomNodeDialog(true);
      return;
    }
    const newNode: ArchitectFlowNode = {
      id: `node-${crypto.randomUUID()}`,
      type: 'architect',
      position: { x: 250 + Math.random() * 100, y: 150 + Math.random() * 100 },
      data: {
        label: overrideLabel || template.label,
        nodeType: template.type,
        icon: template.icon,
        color: overrideColor || template.color,
      },
    };
    setNodes((nds) => [...nds, newNode]);
  };

  const handleCustomNodeAdd = () => {
    const template = systemDesignTemplates.find(t => t.type === 'custom')!;
    addNode(template, customNodeColor, customNodeLabel.trim() || 'Custom Node');
    setCustomNodeDialog(false);
    setCustomNodeLabel('Custom Node');
    setCustomNodeColor('blue');
  };

  const applyGeneratedBoard = useCallback((board: BoardState) => {
    // Remap incoming ids with collision-free UUIDs so they never collide across reloads/sessions.
    const idMap = new Map<string, string>();
    board.nodes.forEach((n) => {
      idMap.set(n.id, `node-${crypto.randomUUID()}`);
    });

    // Layered layout via dagre — LR for System Architecture, TB for Algorithm Visualizer
    const NODE_W = 240;
    const NODE_H = 100;
    const g = new dagre.graphlib.Graph();
    const rankDir = mode === 'system' ? 'LR' : 'TB';
    g.setGraph({
      rankdir: rankDir,
      nodesep: 110,
      ranksep: 200,
      edgesep: 50,
      marginx: 60,
      marginy: 60,
      ranker: 'network-simplex',
    });
    g.setDefaultEdgeLabel(() => ({}));
    board.nodes.forEach((n) => {
      g.setNode(idMap.get(n.id)!, { width: NODE_W, height: NODE_H });
    });
    board.edges.forEach((e) => {
      const s = idMap.get(e.source);
      const t = idMap.get(e.target);
      if (s && t) g.setEdge(s, t, { minlen: 1, weight: 1 });
    });
    dagre.layout(g);

    // Place laid-out graph cleanly
    const maxY = nodes.reduce((m, n) => Math.max(m, n.position.y + 120), 0);
    const xOffset = 100;
    const yOffset = nodes.length > 0 ? maxY + 160 : 80;

    const newNodes: ArchitectFlowNode[] = board.nodes.map((n) => {
      const id = idMap.get(n.id)!;
      const pos = g.node(id);
      return {
        id,
        type: 'architect',
        position: {
          x: xOffset + (pos?.x ?? 0) - NODE_W / 2,
          y: yOffset + (pos?.y ?? 0) - NODE_H / 2,
        },
        sourcePosition: rankDir === 'LR' ? Position.Right : Position.Bottom,
        targetPosition: rankDir === 'LR' ? Position.Left : Position.Top,
        data: {
          label: n.data.label,
          ...(n.data.description !== undefined ? { description: n.data.description } : {}),
          nodeType: n.type,
          icon: getIconFromType(n.type),
          color: n.data.color || getColorFromType(n.type),
        },
      };
    });

    const newEdges = board.edges
      .filter((e) => idMap.has(e.source) && idMap.has(e.target))
      .map((e) => ({
        id: `edge-${crypto.randomUUID()}`,
        source: idMap.get(e.source)!,
        target: idMap.get(e.target)!,
        type: 'smoothstep',
        pathOptions: { borderRadius: 16, offset: 20 },
        label: e.label || '',
        markerEnd: { type: MarkerType.ArrowClosed as const, color: '#F59E0B' as const, width: 22, height: 22 },
        style: { stroke: '#F59E0B' as const, strokeWidth: 2.5 },
        labelStyle: { fill: 'hsl(var(--foreground))', fontWeight: 600, fontSize: 12 },
        labelBgStyle: { fill: 'hsl(var(--card))', fillOpacity: 0.95 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 6,
      }));
    setNodes((nds) => [...nds, ...newNodes]);
    setEdges((eds) => [...eds, ...(newEdges as typeof eds)]);
    toast.success(`Added ${newNodes.length} nodes and ${newEdges.length} connections`);
  }, [nodes, mode, setNodes, setEdges]);

  const handleAutoLayout = useCallback(() => {
    if (nodes.length === 0) return;
    const NODE_W = 240;
    const NODE_H = 100;
    const g = new dagre.graphlib.Graph();
    const rankDir = mode === 'system' ? 'LR' : 'TB';
    g.setGraph({
      rankdir: rankDir,
      nodesep: 110,
      ranksep: 200,
      edgesep: 50,
      marginx: 80,
      marginy: 80,
      ranker: 'network-simplex',
    });
    g.setDefaultEdgeLabel(() => ({}));

    nodes.forEach((n) => {
      g.setNode(n.id, { width: NODE_W, height: NODE_H });
    });
    edges.forEach((e) => {
      g.setEdge(e.source, e.target);
    });

    dagre.layout(g);

    setNodes((prevNodes) =>
      prevNodes.map((node) => {
        const pos = g.node(node.id);
        return {
          ...node,
          position: {
            x: (pos?.x ?? 0) - NODE_W / 2 + 150,
            y: (pos?.y ?? 0) - NODE_H / 2 + 120,
          },
          sourcePosition: rankDir === 'LR' ? Position.Right : Position.Bottom,
          targetPosition: rankDir === 'LR' ? Position.Left : Position.Top,
        };
      })
    );
    toast.success(`Arranged ${nodes.length} nodes cleanly (${rankDir === 'LR' ? 'Horizontal Flow' : 'Vertical Flow'})`);
  }, [nodes, edges, mode, setNodes]);

  const handleManualSave = async () => {
    if (staleRef.current) return;
    setSaveStatus('saving');
    try {
      const boardState = serializeFlowToBoard(nodes, edges, strokes);
      const serialized = JSON.stringify(boardState);
      const expectedLocalRevision = baseRef.current.localRevision;
      const res = (await onSave(
        boardState,
        expectedLocalRevision !== undefined ? { expectedLocalRevision } : undefined,
      )) as Partial<SystemDesign> | undefined;
      baseRef.current = {
        localRevision: res?.local_revision ?? baseRef.current.localRevision,
        updatedAt: res?.updated_at ?? baseRef.current.updatedAt,
        name: designNameRef.current,
        serializedBoard: serialized,
      };
      guardRef.current?.markClean(design.id);
      dirtyTracker.markClean(design.id);
      setSaveStatus('saved');
      toast.success('Design saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err: any) {
      if (err instanceof StaleBufferError || err?.code === 'STALE_BUFFER') {
        saverRef.current?.cancel();
        staleRef.current = latestPropDesignRef.current;
        setStaleRemoteDesign(latestPropDesignRef.current);
      } else {
        toast.error('Failed to save design');
      }
      setSaveStatus('error');
    }
  };

  const handleNameSave = async () => {
    const trimmedName = designName.trim();
    if (trimmedName && trimmedName !== design.name && onUpdateName && !staleRef.current) {
      const res = (await onUpdateName(trimmedName)) as Partial<SystemDesign> | undefined;
      baseRef.current.name = trimmedName;
      if (res?.local_revision !== undefined) {
        baseRef.current.localRevision = res.local_revision;
      }
      if (res?.updated_at) {
        baseRef.current.updatedAt = res.updated_at;
      }
      toast.success('Design renamed');
    }
    setIsEditingName(false);
  };

  return (
    <div className="dark-canvas h-screen w-full bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-background/95 backdrop-blur flex items-center h-14 px-4 gap-4 shrink-0">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          {isEditingName ? (
            <Input
              value={designName}
              onChange={(e) => setDesignName(e.target.value)}
              onBlur={handleNameSave}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNameSave();
                if (e.key === 'Escape') {
                  setDesignName(design.name);
                  setIsEditingName(false);
                }
              }}
              className="h-8 max-w-xs"
              autoFocus
            />
          ) : (
            <h1
              className="font-semibold text-foreground truncate cursor-pointer hover:text-primary transition-colors"
              onClick={() => setIsEditingName(true)}
              title="Click to rename"
            >
              {designName}
            </h1>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Mode toggle */}
          <div className="flex items-center border border-border rounded-lg overflow-hidden">
            <Button
              variant={mode === 'system' ? 'default' : 'ghost'}
              size="sm"
              className="rounded-none gap-1.5 h-9"
              onClick={() => setMode('system')}
            >
              <Network className="h-4 w-4" />
              System
            </Button>
            <Button
              variant={mode === 'algorithm' ? 'default' : 'ghost'}
              size="sm"
              className="rounded-none gap-1.5 h-9"
              onClick={() => setMode('algorithm')}
            >
              <FlaskConical className="h-4 w-4" />
              Algorithm
            </Button>
          </div>

          {/* Draw toggle */}
          <Button
            variant={isDrawing ? 'default' : 'outline'}
            size="sm"
            className="gap-1.5 h-9"
            onClick={() => setIsDrawing(!isDrawing)}
          >
            <Pencil className="h-4 w-4" />
            Draw
          </Button>

          <Button variant="outline" className="gap-2" onClick={() => setGenerateDialogOpen(true)}>
            <Sparkles className="h-4 w-4" />
            Generate
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2">
                <Plus className="h-4 w-4" />
                Add Node
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
              {mode === 'system' ? (
                systemDesignTemplates.map((template) => {
                  const Icon = allIcons[template.icon];
                  return (
                    <DropdownMenuItem key={template.type} onClick={() => addNode(template)}>
                      {Icon && <Icon className="h-4 w-4 mr-2" />}
                      {template.label}
                    </DropdownMenuItem>
                  );
                })
              ) : (
                Object.entries(groupedTemplates!).map(([category, templates]) => (
                  <div key={category}>
                    <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      {category}
                    </div>
                    {templates.map((template) => {
                      const Icon = allIcons[template.icon];
                      return (
                        <DropdownMenuItem key={template.type} onClick={() => addNode(template)}>
                          {Icon && <Icon className="h-4 w-4 mr-2" />}
                          {template.label}
                        </DropdownMenuItem>
                      );
                    })}
                  </div>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button variant="outline" className="gap-2" onClick={handleAutoLayout} title="Auto-arrange nodes cleanly with zero overlap">
            <LayoutList className="h-4 w-4" />
            Auto Layout
          </Button>
          <AnimatePresence mode="wait">
            <motion.div
              key={saveStatus}
              initial={{ opacity: 0, y: -5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 5 }}
              className={cn(
                "flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-md mr-1",
                saveStatus === 'saving' && "text-muted-foreground",
                saveStatus === 'saved' && "text-success",
                saveStatus === 'error' && "text-destructive",
                saveStatus === 'idle' && "text-muted-foreground/50"
              )}
            >
              {saveStatus === 'saving' && (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Saving...</span>
                </>
              )}
              {saveStatus === 'saved' && (
                <>
                  <Check className="h-3 w-3" />
                  <span>Saved</span>
                </>
              )}
              {saveStatus === 'error' && (
                <>
                  <AlertCircle className="h-3 w-3" />
                  <span>Error</span>
                </>
              )}
              {saveStatus === 'idle' && (
                <span className="text-muted-foreground/40">Auto-save enabled</span>
              )}
            </motion.div>
          </AnimatePresence>

          <Button onClick={handleManualSave} className="gap-2">
            <Save className="h-4 w-4" />
            Save
          </Button>
        </div>
      </header>

      {staleRemoteDesign && (
        <div
          data-testid="stale-buffer-banner"
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b border-amber-500/40 bg-amber-500/10 text-sm text-foreground shrink-0"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
            <span>
              Remote board changes arrived while you have unsaved edits. Auto-save is paused to prevent overwriting remote work.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={handleLoadRemote}>
              Load remote (discard mine)
            </Button>
            <Button size="sm" variant="default" onClick={handleKeepMine}>
              Keep mine
            </Button>
            {onSaveAsCopy && (
              <Button size="sm" variant="secondary" onClick={handleSaveMineAsCopy}>
                Save mine as copy
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Canvas */}
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onEdgeDoubleClick={onEdgeDoubleClick}
          nodeTypes={nodeTypes}
          fitView
          deleteKeyCode={isDrawing ? [] : ['Backspace', 'Delete']}
          nodesDraggable={!isDrawing}
          elementsSelectable={!isDrawing}
          panOnDrag={!isDrawing}
          panOnScroll={false}
          zoomOnScroll={true}
          zoomOnPinch={true}
          zoomOnDoubleClick={!isDrawing}
          selectionOnDrag={false}
          className="bg-background"
          connectionLineType={ConnectionLineType.SmoothStep}
          connectionLineStyle={{ stroke: '#F59E0B', strokeWidth: 2, strokeDasharray: '6 3' }}
          defaultEdgeOptions={{
            type: 'smoothstep',
            markerEnd: { type: MarkerType.ArrowClosed, color: '#F59E0B', width: 20, height: 20 },
            style: { stroke: '#F59E0B', strokeWidth: 2 },
          }}>
          <Background color="hsl(var(--muted-foreground) / 0.2)" gap={20} />
          <Controls className="bg-card border border-border rounded-lg" />
          <MiniMap
            className="bg-card border border-border rounded-lg"
            nodeColor="hsl(var(--primary))"
            maskColor="hsl(var(--background) / 0.8)"
          />
          <Panel position="bottom-center" className="bg-card/80 backdrop-blur border border-border rounded-lg px-4 py-2 text-sm text-muted-foreground z-0">
            {isDrawing
              ? 'Drawing mode active • Click Draw again to return to editing'
              : mode === 'algorithm'
                ? 'Algorithm mode • Add nodes to visualize data structures & algorithms'
                : 'Drag to connect • Double-click to edit labels • Delete/Backspace to remove'}
          </Panel>
          <DrawingCanvas
            isActive={isDrawing}
            strokes={strokes}
            onStrokesChange={setStrokes}
          />
        </ReactFlow>
      </div>

      {/* Edge Label Edit Dialog */}
      <Dialog open={!!editingEdge} onOpenChange={(open) => !open && setEditingEdge(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Connection Label</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="edge-label">Label</Label>
              <Input
                id="edge-label"
                value={edgeLabelInput}
                onChange={(e) => setEdgeLabelInput(e.target.value)}
                placeholder="e.g., REST API, WebSocket, gRPC..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleEdgeLabelSave();
                  }
                }}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingEdge(null)}>
              Cancel
            </Button>
            <Button onClick={handleEdgeLabelSave}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Custom Node Color Dialog */}
      <Dialog open={customNodeDialog} onOpenChange={setCustomNodeDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Custom Node</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="custom-label">Node Name</Label>
              <Input
                id="custom-label"
                value={customNodeLabel}
                onChange={(e) => setCustomNodeLabel(e.target.value)}
                placeholder="Enter node name..."
                onKeyDown={(e) => { if (e.key === 'Enter') handleCustomNodeAdd(); }}
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label>Color</Label>
              <div className="flex flex-wrap gap-2">
                {(['blue', 'green', 'purple', 'cyan', 'orange', 'pink'] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => setCustomNodeColor(c)}
                    className={cn(
                      'w-10 h-10 rounded-lg border-2 transition-all flex items-center justify-center text-xs font-medium capitalize',
                      customNodeColor === c
                        ? 'border-foreground scale-110 ring-2 ring-primary/50'
                        : 'border-transparent hover:scale-105',
                      c === 'blue' && 'bg-blue-500/20 text-blue-400',
                      c === 'green' && 'bg-green-500/20 text-green-400',
                      c === 'purple' && 'bg-purple-500/20 text-purple-400',
                      c === 'cyan' && 'bg-cyan-500/20 text-cyan-400',
                      c === 'orange' && 'bg-orange-500/20 text-orange-400',
                      c === 'pink' && 'bg-pink-500/20 text-pink-400',
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCustomNodeDialog(false)}>Cancel</Button>
            <Button onClick={handleCustomNodeAdd}>Add Node</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ArchitectureGeneratorDialog
        open={generateDialogOpen}
        onOpenChange={setGenerateDialogOpen}
        mode={mode}
        documents={documents}
        onApply={applyGeneratedBoard}
      />
    </div>
  );
}
