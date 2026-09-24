export type ResourceKind = 'document' | 'design';

export interface WorkspaceResource {
  id: string;
  projectId: string;
  title: string;
  kind: ResourceKind;
  updatedAt: string;
  createdAt?: string;
  folderId: string | null;
  meta?: {
    format?: string;       // 'markdown' | 'xml' | 'text' (documents)
    nodeCount?: number;    // number of nodes (designs)
  };
}

export interface WorkspaceFolder {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceSelection =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'document'; id: string }
  | { kind: 'design'; id: string };

export type SidebarFilterKind = 'all' | 'document' | 'design';

export interface WorkspaceTab {
  id: string;
  resourceKind: ResourceKind;
  resourceId: string;
}

export interface WorkspaceTabsState {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
}
