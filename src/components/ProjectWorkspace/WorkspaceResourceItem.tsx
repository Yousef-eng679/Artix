import React from 'react';
import { FileText, GitBranch, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import { WorkspaceResource } from '@/types/workspace';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface WorkspaceResourceItemProps {
  resource: WorkspaceResource;
  isActive: boolean;
  onClick: () => void;
  onRename?: (resource: WorkspaceResource) => void;
  onDelete?: (resource: WorkspaceResource) => void;
  collapsed?: boolean;
}

export const WorkspaceResourceItem: React.FC<WorkspaceResourceItemProps> = ({
  resource,
  isActive,
  onClick,
  onRename,
  onDelete,
  collapsed = false,
}) => {
  const isDoc = resource.kind === 'document';
  const Icon = isDoc ? FileText : GitBranch;
  const iconColor = isDoc ? 'text-sky-400' : 'text-purple-400';
  const iconBg = isDoc ? 'bg-sky-500/10' : 'bg-purple-500/10';

  const content = (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      aria-label={`Open ${isDoc ? 'document' : 'system design'}: ${resource.title}`}
      className={cn(
        'group w-full flex items-center gap-2.5 rounded-lg text-sm transition-all duration-150 cursor-pointer select-none text-left',
        collapsed ? 'justify-center p-2' : 'px-2.5 py-1.5',
        isActive
          ? 'bg-primary/15 text-primary font-medium border-l-2 border-primary'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50 border-l-2 border-transparent'
      )}
    >
      <div className={cn('flex-shrink-0 w-6 h-6 rounded flex items-center justify-center', iconBg)}>
        <Icon className={cn('h-3.5 w-3.5', iconColor)} />
      </div>

      {!collapsed && (
        <>
          <span className="flex-1 min-w-0 truncate font-normal text-sm" title={resource.title}>
            {resource.title}
          </span>

          {(onRename || onDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                  aria-label={`Options for ${resource.title}`}
                >
                  <MoreVertical className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-32">
                {onRename && (
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onRename(resource);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-2" />
                    Rename
                  </DropdownMenuItem>
                )}
                {onDelete && (
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(resource);
                    }}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>
      )}
    </div>
  );

  if (collapsed) {
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>{content}</TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            <p className="font-semibold">{resource.title}</p>
            <p className="text-muted-foreground capitalize">{resource.kind}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return content;
};
