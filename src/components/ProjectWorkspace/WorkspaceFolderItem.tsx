import React from 'react';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  MoreVertical,
  Pencil,
  Trash2,
  Plus,
  FileText,
  GitBranch,
} from 'lucide-react';
import { WorkspaceFolder } from '@/types/workspace';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export interface WorkspaceFolderItemProps {
  folder: WorkspaceFolder;
  resourceCount: number;
  isExpanded: boolean;
  onToggle: () => void;
  onRename?: (folder: WorkspaceFolder) => void;
  onDelete?: (folder: WorkspaceFolder) => void;
  onCreateDocument?: (folderId: string) => void;
  onCreateDesign?: (folderId: string) => void;
  children?: React.ReactNode;
  collapsed?: boolean;
}

export const WorkspaceFolderItem: React.FC<WorkspaceFolderItemProps> = ({
  folder,
  resourceCount,
  isExpanded,
  onToggle,
  onRename,
  onDelete,
  onCreateDocument,
  onCreateDesign,
  children,
  collapsed = false,
}) => {
  if (collapsed) {
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex justify-center py-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggle}
                className={cn(
                  'h-8 w-8 text-amber-400 hover:bg-amber-500/10',
                  isExpanded && 'bg-accent/40 text-foreground'
                )}
                aria-label={`Folder: ${folder.name}`}
              >
                {isExpanded ? <FolderOpen className="h-4 w-4" /> : <Folder className="h-4 w-4" />}
              </Button>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">
            {folder.name} ({resourceCount})
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <div className="space-y-0.5 select-none" data-testid={`folder-group-${folder.id}`}>
      {/* Folder Header Row */}
      <div
        className={cn(
          'group flex items-center justify-between px-2 py-1.5 rounded-lg text-xs font-medium text-foreground hover:bg-accent/40 transition-colors cursor-pointer'
        )}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        aria-expanded={isExpanded}
        aria-label={`Toggle folder ${folder.name}`}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="text-muted-foreground group-hover:text-foreground">
            {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </span>
          <span className="text-amber-400 shrink-0">
            {isExpanded ? <FolderOpen className="h-3.5 w-3.5" /> : <Folder className="h-3.5 w-3.5" />}
          </span>
          <span className="truncate font-medium text-xs text-foreground/90" title={folder.name}>
            {folder.name}
          </span>
          <span className="ml-1 text-[10px] px-1.5 py-0.2 rounded-full bg-muted/70 text-muted-foreground shrink-0">
            {resourceCount}
          </span>
        </div>

        {/* Folder Actions Menu */}
        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {(onCreateDocument || onCreateDesign) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                  aria-label={`Add to ${folder.name}`}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                {onCreateDocument && (
                  <DropdownMenuItem onClick={() => onCreateDocument(folder.id)}>
                    <FileText className="h-3.5 w-3.5 mr-2 text-sky-400" />
                    New Document
                  </DropdownMenuItem>
                )}
                {onCreateDesign && (
                  <DropdownMenuItem onClick={() => onCreateDesign(folder.id)}>
                    <GitBranch className="h-3.5 w-3.5 mr-2 text-purple-400" />
                    New Design
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {(onRename || onDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                  aria-label={`Folder options for ${folder.name}`}
                >
                  <MoreVertical className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-32">
                {onRename && (
                  <DropdownMenuItem onClick={() => onRename(folder)}>
                    <Pencil className="h-3.5 w-3.5 mr-2" />
                    Rename
                  </DropdownMenuItem>
                )}
                {onDelete && (
                  <DropdownMenuItem
                    onClick={() => onDelete(folder)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Children resources when folder is open */}
      {isExpanded && (
        <div className="space-y-0.5 mt-0.5">
          {resourceCount === 0 ? (
            <p className="text-[11px] text-muted-foreground/60 italic pl-7 py-1">
              Folder is empty
            </p>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
};
