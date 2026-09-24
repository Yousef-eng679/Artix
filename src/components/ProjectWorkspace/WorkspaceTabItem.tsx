import React from 'react';
import { FileText, GitBranch, X } from 'lucide-react';
import { WorkspaceTab } from '@/types/workspace';
import { useIsResourceDirty } from '@/lib/workspace/dirtyTracker';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export interface WorkspaceTabItemProps {
  tab: WorkspaceTab;
  title: string;
  isActive: boolean;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

export const WorkspaceTabItem: React.FC<WorkspaceTabItemProps> = ({
  tab,
  title,
  isActive,
  onActivate,
  onClose,
}) => {
  const isDirty = useIsResourceDirty(tab.resourceId, tab.resourceKind);
  const isDoc = tab.resourceKind === 'document';
  const Icon = isDoc ? FileText : GitBranch;
  const iconColor = isDoc ? 'text-sky-400' : 'text-purple-400';

  const handleMouseDown = (e: React.MouseEvent) => {
    // Middle-click to close (button 1)
    if (e.button === 1) {
      e.preventDefault();
      onClose(tab.id);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onActivate(tab.id);
    }
  };

  return (
    <div
      role="tab"
      aria-selected={isActive}
      tabIndex={0}
      onClick={() => onActivate(tab.id)}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      className={cn(
        'group relative flex items-center gap-2 h-9 px-3 shrink-0 cursor-pointer select-none text-xs transition-colors border-r border-border/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary',
        isActive
          ? 'bg-background text-foreground font-medium border-b-2 border-b-primary shadow-sm'
          : 'bg-muted/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground border-b-2 border-b-transparent',
      )}
      data-tab-id={tab.id}
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0', iconColor)} />

      <span className="max-w-[130px] truncate" title={title}>
        {title}
      </span>

      {/* Dirty indicator */}
      {isDirty && (
        <span
          data-testid="dirty-indicator"
          className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0"
          title="Unsaved changes"
        />
      )}

      {/* Close button */}
      <TooltipProvider delayDuration={400}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Close ${title}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              className={cn(
                'ml-1 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus:ring-1 focus:ring-primary',
                // Keep close button visible when dirty or active, else show on hover
                isDirty || isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
              )}
            >
              <X className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Close tab
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
};
