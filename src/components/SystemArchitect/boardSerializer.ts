import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { BoardState } from '@/hooks/useSystemDesigns';
import type { Stroke } from './DrawingCanvas';
import { systemDesignTemplates, algorithmTemplates } from './AlgorithmNodeTemplates';

export type ArchitectNodeData = Record<string, unknown> & {
  label: string;
  description?: string;
  nodeType: string;
  icon: string;
  color: string;
};

export type ArchitectFlowNode = Node<ArchitectNodeData>;

export interface DeserializedFlowBoard {
  nodes: ArchitectFlowNode[];
  edges: Edge[];
  strokes: Stroke[];
}

export function getIconFromType(type: string): string {
  const t = [...systemDesignTemplates, ...algorithmTemplates].find((x) => x.type === type);
  return t?.icon || 'Database';
}

export function getColorFromType(type: string): string {
  const t = [...systemDesignTemplates, ...algorithmTemplates].find((x) => x.type === type);
  return t?.color || 'blue';
}

export function deserializeBoardToFlow(board: BoardState): DeserializedFlowBoard {
  const nodes: ArchitectFlowNode[] = (board?.nodes || []).map((n) => ({
    id: n.id,
    type: 'architect',
    position: { x: n.position.x, y: n.position.y },
    data: {
      label: n.data?.label ?? '',
      ...(n.data?.description !== undefined ? { description: n.data.description } : {}),
      nodeType: n.type,
      icon: getIconFromType(n.type),
      color: n.data?.color || getColorFromType(n.type),
    },
  }));

  const edges: Edge[] = (board?.edges || []).map((e) => ({
    ...e,
    type: 'smoothstep',
    label: e.label || '',
    markerEnd: { type: MarkerType.ArrowClosed, color: '#F59E0B', width: 20, height: 20 },
    style: { stroke: '#F59E0B', strokeWidth: 2 },
    labelStyle: { fill: 'hsl(var(--foreground))', fontWeight: 500 },
    labelBgStyle: { fill: 'hsl(var(--card))', fillOpacity: 0.9 },
    labelBgPadding: [8, 4] as [number, number],
    labelBgBorderRadius: 4,
  }));

  const strokes: Stroke[] = (board?.strokes || []).map((s) => ({
    points: s.points.map((p) => ({ x: p.x, y: p.y })),
    color: s.color,
    width: s.width,
  }));

  return { nodes, edges, strokes };
}

export function serializeFlowToBoard(
  nodes: ArchitectFlowNode[],
  edges: Edge[],
  strokes: Stroke[],
): BoardState {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data.nodeType,
      position: { x: n.position.x, y: n.position.y },
      data: {
        label: n.data.label,
        ...(n.data.description !== undefined ? { description: n.data.description } : {}),
        color: n.data.color,
      },
    })),
    edges: edges.map((e) => {
      const label = typeof e.label === 'string' && e.label.length > 0 ? e.label : undefined;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        ...(label !== undefined ? { label } : {}),
      };
    }),
    strokes: strokes.map((s) => ({
      points: s.points.map((p) => ({ x: p.x, y: p.y })),
      color: s.color,
      width: s.width,
    })),
  };
}

export function serializeBoardCanonical(board: BoardState): string {
  const { nodes, edges, strokes } = deserializeBoardToFlow(board);
  return JSON.stringify(serializeFlowToBoard(nodes, edges, strokes));
}
