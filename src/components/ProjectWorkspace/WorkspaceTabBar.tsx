import React, { useRef } from 'react';
import { WorkspaceTab, WorkspaceResource } from '@/types/workspace';
import { WorkspaceTabItem } from './WorkspaceTabItem';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export interface WorkspaceTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  resources: WorkspaceResource[];
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseAllTabs?: () => void;
}

export const WorkspaceTabBar: React.FC<WorkspaceTabBarProps> = ({
  tabs,
  activeTabId,
  resources,
  onActivateTab,
  onCloseTab,
  onCloseAllTabs,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  if (tabs.length === 0) {
    return null;
  }

  const getTabTitle = (tab: WorkspaceTab): string => {
    const res = resources.find(
      (r) => r.id === tab.resourceId && r.kind === tab.resourceKind,
    );
    if (res?.title) return res.title;
    return tab.resourceKind === 'document' ? 'Untitled Document' : 'New System Design';
  };

  return (
    <div
      role="tablist"
      aria-label="Workspace open tabs"
      className="flex items-center h-9 w-full bg-muted/20 border-b border-border/40 select-none shrink-0 min-w-0"
    >
      <div
        ref={containerRef}
        className="flex items-center h-full overflow-x-auto overflow-y-hidden flex-1 scrollbar-none min-w-0"
      >
        {tabs.map((tab) => (
          <WorkspaceTabItem
            key={tab.id}
            tab={tab}
            title={getTabTitle(tab)}
            isActive={tab.id === activeTabId}
            onActivate={onActivateTab}
            onClose={onCloseTab}
          />
        ))}
      </div>

      {onCloseAllTabs && tabs.length > 1 && (
        <div className="shrink-0 px-1 border-l border-border/40 flex items-center h-full">
          <TooltipProvider delayDuration={400}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={onCloseAllTabs}
                  aria-label="Close all tabs"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">
                Close all tabs
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}
    </div>
  );
};
