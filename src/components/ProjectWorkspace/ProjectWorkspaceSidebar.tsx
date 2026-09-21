import React, { useState } from 'react';
import {
  ArrowLeft,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  ChevronRight,
  FileText,
  GitBranch,
  LayoutDashboard,
  Plus,
  Clock,
} from 'lucide-react';
import { WorkspaceResource, WorkspaceSelection, SidebarFilterKind } from '@/types/workspace';
import { filterWorkspaceResources } from '@/lib/workspace/filterResources';
import { WorkspaceResourceItem } from './WorkspaceResourceItem';
import { WorkspaceSearch } from './WorkspaceSearch';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface ProjectWorkspaceSidebarProps {
  projectName: string;
  resources: WorkspaceResource[];
  selection: WorkspaceSelection;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSelectOverview: () => void;
  onSelectResource: (resource: WorkspaceResource) => void;
  onCreateDocument: () => void;
  onCreateDesign: () => void;
  onRenameResource?: (resource: WorkspaceResource) => void;
  onDeleteResource?: (resource: WorkspaceResource) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onBackToDashboard: () => void;
  filterKind?: SidebarFilterKind;
  onFilterKindChange?: (kind: SidebarFilterKind) => void;
}

export const ProjectWorkspaceSidebar: React.FC<ProjectWorkspaceSidebarProps> = ({
  projectName,
  resources,
  selection,
  searchQuery,
  onSearchChange,
  onSelectOverview,
  onSelectResource,
  onCreateDocument,
  onCreateDesign,
  onRenameResource,
  onDeleteResource,
  collapsed = false,
  onToggleCollapsed,
  onBackToDashboard,
  filterKind = 'all',
}) => {
  const [docsOpen, setDocsOpen] = useState(true);
  const [designsOpen, setDesignsOpen] = useState(true);

  // Filtered resources for search
  const filteredResources = filterWorkspaceResources(resources, searchQuery, filterKind);

  // Grouped resources
  const documents = filteredResources.filter((r) => r.kind === 'document');
  const designs = filteredResources.filter((r) => r.kind === 'design');

  // Total counts from all resources (unfiltered)
  const totalDocsCount = resources.filter((r) => r.kind === 'document').length;
  const totalDesignsCount = resources.filter((r) => r.kind === 'design').length;

  // Recent 3 resources (by updatedAt DESC)
  const recentResources = [...resources]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 3);

  const isOverviewActive = selection.kind === 'none';

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

        {/* Section: Documents */}
        <div>
          {!collapsed ? (
            <div className="flex items-center justify-between px-2 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <button
                type="button"
                onClick={() => setDocsOpen(!docsOpen)}
                className="flex items-center gap-1.5 hover:text-foreground transition-colors"
                aria-expanded={docsOpen}
                aria-label="Toggle documents list"
              >
                {docsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <span>Documents</span>
                <span className="ml-1 text-[10px] font-normal px-1.5 py-0.2 rounded-full bg-muted text-muted-foreground">
                  {totalDocsCount}
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon"
                onClick={onCreateDocument}
                className="h-5 w-5 hover:bg-accent text-muted-foreground hover:text-primary"
                aria-label="Create new document"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <div className="flex justify-center py-1">
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={onCreateDocument}
                      className="h-8 w-8 text-sky-400 hover:bg-sky-500/10"
                      aria-label="New Document"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">New Document ({totalDocsCount})</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          )}

          {(docsOpen || collapsed) && (
            <div className="mt-1 space-y-0.5">
              {documents.length === 0 ? (
                !collapsed && (
                  <p className="text-xs text-muted-foreground/60 px-2 py-1 italic">
                    {searchQuery ? 'No matching documents' : 'No documents yet'}
                  </p>
                )
              ) : (
                documents.map((doc) => (
                  <WorkspaceResourceItem
                    key={doc.id}
                    resource={doc}
                    isActive={selection.kind === 'document' && selection.id === doc.id}
                    onClick={() => onSelectResource(doc)}
                    onRename={onRenameResource}
                    onDelete={onDeleteResource}
                    collapsed={collapsed}
                  />
                ))
              )}
            </div>
          )}
        </div>

        {/* Section: System Designs */}
        <div>
          {!collapsed ? (
            <div className="flex items-center justify-between px-2 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <button
                type="button"
                onClick={() => setDesignsOpen(!designsOpen)}
                className="flex items-center gap-1.5 hover:text-foreground transition-colors"
                aria-expanded={designsOpen}
                aria-label="Toggle system designs list"
              >
                {designsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <span>System Designs</span>
                <span className="ml-1 text-[10px] font-normal px-1.5 py-0.2 rounded-full bg-muted text-muted-foreground">
                  {totalDesignsCount}
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon"
                onClick={onCreateDesign}
                className="h-5 w-5 hover:bg-accent text-muted-foreground hover:text-primary"
                aria-label="Create new system design"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <div className="flex justify-center py-1">
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={onCreateDesign}
                      className="h-8 w-8 text-purple-400 hover:bg-purple-500/10"
                      aria-label="New System Design"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">New System Design ({totalDesignsCount})</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          )}

          {(designsOpen || collapsed) && (
            <div className="mt-1 space-y-0.5">
              {designs.length === 0 ? (
                !collapsed && (
                  <p className="text-xs text-muted-foreground/60 px-2 py-1 italic">
                    {searchQuery ? 'No matching designs' : 'No designs yet'}
                  </p>
                )
              ) : (
                designs.map((design) => (
                  <WorkspaceResourceItem
                    key={design.id}
                    resource={design}
                    isActive={selection.kind === 'design' && selection.id === design.id}
                    onClick={() => onSelectResource(design)}
                    onRename={onRenameResource}
                    onDelete={onDeleteResource}
                    collapsed={collapsed}
                  />
                ))
              )}
            </div>
          )}
        </div>

        {/* Section: Recents (only when not collapsed and not actively searching) */}
        {!collapsed && !searchQuery && recentResources.length > 0 && (
          <div className="pt-2 border-t border-border/30">
            <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <Clock className="h-3 w-3" />
              <span>Recent</span>
            </div>
            <div className="mt-1 space-y-0.5">
              {recentResources.map((res) => (
                <WorkspaceResourceItem
                  key={`recent-${res.id}`}
                  resource={res}
                  isActive={
                    (selection.kind === 'document' && selection.id === res.id) ||
                    (selection.kind === 'design' && selection.id === res.id)
                  }
                  onClick={() => onSelectResource(res)}
                  collapsed={false}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer: Quick create actions */}
      {!collapsed && (
        <div className="p-3 border-t border-border/40 shrink-0 bg-sidebar/50 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onCreateDocument}
            className="flex-1 text-xs h-8 gap-1.5 border-border/60 hover:border-primary/40"
          >
            <FileText className="h-3.5 w-3.5 text-sky-400" />
            + Doc
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onCreateDesign}
            className="flex-1 text-xs h-8 gap-1.5 border-border/60 hover:border-primary/40"
          >
            <GitBranch className="h-3.5 w-3.5 text-purple-400" />
            + Canvas
          </Button>
        </div>
      )}
    </aside>
  );
};
