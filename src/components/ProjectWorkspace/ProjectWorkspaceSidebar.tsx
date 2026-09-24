import React, { useState } from 'react';
import {
  ArrowLeft,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  LayoutDashboard,
  Plus,
  FileText,
  GitBranch,
} from 'lucide-react';
import { WorkspaceResource, WorkspaceSelection, WorkspaceFolder, SidebarFilterKind } from '@/types/workspace';
import { filterWorkspaceResources } from '@/lib/workspace/filterResources';
import { groupResourcesByFolder } from '@/lib/workspace/groupResourcesByFolder';
import { WorkspaceResourceItem } from './WorkspaceResourceItem';
import { WorkspaceFolderItem } from './WorkspaceFolderItem';
import { WorkspaceSearch } from './WorkspaceSearch';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface ProjectWorkspaceSidebarProps {
  projectName: string;
  resources: WorkspaceResource[];
  folders?: WorkspaceFolder[];
  selection: WorkspaceSelection;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSelectOverview: () => void;
  onSelectResource: (resource: WorkspaceResource) => void;
  onCreateDocument: (folderId?: string | null) => void;
  onCreateDesign: (folderId?: string | null) => void;
  onCreateFolder?: () => void;
  onRenameResource?: (resource: WorkspaceResource) => void;
  onDeleteResource?: (resource: WorkspaceResource) => void;
  onRenameFolder?: (folder: WorkspaceFolder) => void;
  onDeleteFolder?: (folder: WorkspaceFolder) => void;
  onMoveResource?: (resource: WorkspaceResource) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onBackToDashboard: () => void;
  filterKind?: SidebarFilterKind;
  onFilterKindChange?: (kind: SidebarFilterKind) => void;
}

export const ProjectWorkspaceSidebar: React.FC<ProjectWorkspaceSidebarProps> = ({
  projectName,
  resources,
  folders = [],
  selection,
  searchQuery,
  onSearchChange,
  onSelectOverview,
  onSelectResource,
  onCreateDocument,
  onCreateDesign,
  onCreateFolder,
  onRenameResource,
  onDeleteResource,
  onRenameFolder,
  onDeleteFolder,
  onMoveResource,
  collapsed = false,
  onToggleCollapsed,
  onBackToDashboard,
  filterKind = 'all',
}) => {
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(() => new Set());
  const [rootOpen, setRootOpen] = useState(true);

  // Filter resources for search
  const filteredResources = filterWorkspaceResources(resources, searchQuery, filterKind);

  // Group resources by folder
  const groups = groupResourcesByFolder(filteredResources, folders);

  const folderGroups = groups.filter((g) => g.folder !== null);
  const rootGroup = groups.find((g) => g.folder === null);
  const rootResources = rootGroup ? rootGroup.resources : [];

  const isOverviewActive = selection.kind === 'none';
  const isSearching = searchQuery.trim().length > 0;

  const toggleFolder = (folderId: string) => {
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  return (
    <aside
      className={cn(
        'flex flex-col h-full bg-sidebar/80 backdrop-blur-md border-r border-border/40 transition-all duration-200 select-none overflow-hidden',
        collapsed ? 'w-16' : 'w-64'
      )}
      aria-label="Project Workspace Sidebar"
    >
      {/* Header: Project name + Back + Collapse */}
      <div className="flex items-center justify-between h-14 px-3 border-b border-border/40 shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onBackToDashboard}
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label="Back to dashboard"
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Back to Dashboard</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {!collapsed && (
            <span
              className="font-semibold text-sm text-foreground truncate min-w-0 flex-1"
              title={projectName}
            >
              {projectName || 'Untitled Project'}
            </span>
          )}
        </div>

        {onToggleCollapsed && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleCollapsed}
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground hidden md:flex"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          </Button>
        )}
      </div>

      {/* Search Input (only when not collapsed) */}
      {!collapsed && (
        <div className="px-3 pt-3 pb-2 shrink-0">
          <WorkspaceSearch value={searchQuery} onChange={onSearchChange} />
        </div>
      )}

      {/* Scrollable Navigation Tree */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-4 min-h-0">
        {/* Overview link */}
        <div className="space-y-1">
          {collapsed ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onSelectOverview}
                    className={cn(
                      'w-full flex items-center justify-center p-2 rounded-lg text-sm transition-colors',
                      isOverviewActive
                        ? 'bg-primary/15 text-primary font-medium border-l-2 border-primary'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent/40 border-l-2 border-transparent'
                    )}
                    aria-label="Project Overview"
                  >
                    <LayoutDashboard className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Project Overview</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <button
              onClick={onSelectOverview}
              className={cn(
                'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-sm transition-colors text-left',
                isOverviewActive
                  ? 'bg-primary/15 text-primary font-medium border-l-2 border-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/40 border-l-2 border-transparent'
              )}
              aria-label="Project Overview"
            >
              <LayoutDashboard className="h-4 w-4 text-primary" />
              <span>Overview</span>
            </button>
          )}
        </div>

        {/* FOLDERS Section */}
        <div>
          {!collapsed ? (
            <div className="flex items-center justify-between px-2 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <span>Folders</span>
              {onCreateFolder && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onCreateFolder}
                  className="h-5 w-5 hover:bg-accent text-muted-foreground hover:text-primary"
                  aria-label="Create new folder"
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ) : (
            onCreateFolder && (
              <div className="flex justify-center py-1">
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={onCreateFolder}
                        className="h-8 w-8 text-amber-400 hover:bg-amber-500/10"
                        aria-label="New Folder"
                      >
                        <FolderPlus className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">New Folder</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            )
          )}

          <div className="mt-1 space-y-1">
            {folderGroups.length === 0 && !collapsed && (
              <p className="text-xs text-muted-foreground/60 px-2 py-1 italic">
                {isSearching ? 'No matching folders' : 'No folders yet'}
              </p>
            )}

            {folderGroups.map(({ folder, resources: folderResources }) => {
              if (!folder) return null;
              // When searching, hide folders that have 0 matching resources
              if (isSearching && folderResources.length === 0) return null;

              const isExpanded = isSearching ? true : expandedFolderIds.has(folder.id);

              return (
                <WorkspaceFolderItem
                  key={folder.id}
                  folder={folder}
                  resourceCount={folderResources.length}
                  isExpanded={isExpanded}
                  onToggle={() => toggleFolder(folder.id)}
                  onRename={onRenameFolder}
                  onDelete={onDeleteFolder}
                  onCreateDocument={onCreateDocument ? () => onCreateDocument(folder.id) : undefined}
                  onCreateDesign={onCreateDesign ? () => onCreateDesign(folder.id) : undefined}
                  collapsed={collapsed}
                >
                  {folderResources.map((res) => (
                    <WorkspaceResourceItem
                      key={res.id}
                      resource={res}
                      depth={1}
                      isActive={
                        (selection.kind === 'document' && selection.id === res.id) ||
                        (selection.kind === 'design' && selection.id === res.id)
                      }
                      onClick={() => onSelectResource(res)}
                      onRename={onRenameResource}
                      onDelete={onDeleteResource}
                      onMove={onMoveResource}
                      collapsed={collapsed}
                    />
                  ))}
                </WorkspaceFolderItem>
              );
            })}
          </div>
        </div>

        {/* ROOT / UNORGANIZED Section */}
        <div>
          {!collapsed ? (
            <div className="flex items-center justify-between px-2 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <button
                type="button"
                onClick={() => setRootOpen(!rootOpen)}
                className="flex items-center gap-1.5 hover:text-foreground transition-colors"
                aria-expanded={rootOpen}
                aria-label="Toggle root resources list"
              >
                {rootOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <span>Root</span>
                <span className="ml-1 text-[10px] font-normal px-1.5 py-0.2 rounded-full bg-muted text-muted-foreground">
                  {rootResources.length}
                </span>
              </button>
            </div>
          ) : (
            <div className="flex justify-center py-1">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase">
                Root
              </span>
            </div>
          )}

          {(rootOpen || collapsed) && (
            <div className="mt-1 space-y-0.5">
              {rootResources.length === 0 ? (
                !collapsed && (
                  <p className="text-xs text-muted-foreground/60 px-2 py-1 italic">
                    {isSearching ? 'No matching resources' : 'No root resources'}
                  </p>
                )
              ) : (
                rootResources.map((res) => (
                  <WorkspaceResourceItem
                    key={res.id}
                    resource={res}
                    isActive={
                      (selection.kind === 'document' && selection.id === res.id) ||
                      (selection.kind === 'design' && selection.id === res.id)
                    }
                    onClick={() => onSelectResource(res)}
                    onRename={onRenameResource}
                    onDelete={onDeleteResource}
                    onMove={onMoveResource}
                    collapsed={collapsed}
                  />
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer: Quick Actions */}
      {!collapsed && (
        <div className="p-3 border-t border-border/40 shrink-0 bg-sidebar/50 space-y-2">
          {onCreateFolder && (
            <Button
              variant="outline"
              size="sm"
              onClick={onCreateFolder}
              className="w-full text-xs h-8 gap-1.5 border-border/60 hover:border-amber-400/40 text-foreground"
            >
              <FolderPlus className="h-3.5 w-3.5 text-amber-400" />
              + New Folder
            </Button>
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onCreateDocument(null)}
              className="flex-1 text-xs h-8 gap-1.5 border-border/60 hover:border-primary/40"
              aria-label="Create new document"
            >
              <FileText className="h-3.5 w-3.5 text-sky-400" />
              + Doc
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onCreateDesign(null)}
              className="flex-1 text-xs h-8 gap-1.5 border-border/60 hover:border-primary/40"
              aria-label="Create new system design"
            >
              <GitBranch className="h-3.5 w-3.5 text-purple-400" />
              + Canvas
            </Button>
          </div>
        </div>
      )}
    </aside>
  );
};
