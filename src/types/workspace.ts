export type ResourceKind = 'document' | 'design';

export interface WorkspaceResource {
  id: string;
  projectId: string;
  title: string;
  kind: ResourceKind;
  updatedAt: string;
  createdAt?: string;
  meta?: {
    format?: string;       // 'markdown' | 'xml' | 'text' (documents)
    nodeCount?: number;    // number of nodes (designs)
  };
}

export type WorkspaceSelection =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'document'; id: string }
  | { kind: 'design'; id: string };

export type SidebarFilterKind = 'all' | 'document' | 'design';
