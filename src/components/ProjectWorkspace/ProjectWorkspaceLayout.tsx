import React from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

interface ProjectWorkspaceLayoutProps {
  sidebar: React.ReactNode;
  tabBar?: React.ReactNode;
  children: React.ReactNode;
  isMobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
  projectName: string;
}

export const ProjectWorkspaceLayout: React.FC<ProjectWorkspaceLayoutProps> = ({
  sidebar,
  tabBar,
  children,
  isMobileOpen,
  onMobileOpenChange,
  projectName,
}) => {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/* Desktop Persistent Sidebar */}
      <div className="hidden md:flex h-full shrink-0">
        {sidebar}
      </div>

      {/* Mobile Drawer (Sheet) */}
      <Sheet open={isMobileOpen} onOpenChange={onMobileOpenChange}>
        <SheetContent side="left" className="p-0 w-72 bg-sidebar border-r border-border/40">
          <SheetTitle className="sr-only">{projectName} Navigation</SheetTitle>
          <div className="h-full w-full">
            {sidebar}
          </div>
        </SheetContent>
      </Sheet>

      {/* Main Workspace Area */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden min-w-0">
        {/* Mobile Header Bar */}
        <header className="md:hidden flex items-center h-12 px-3 border-b border-border/40 bg-background shrink-0 gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onMobileOpenChange(true)}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            aria-label="Open navigation menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="font-semibold text-sm truncate flex-1 text-foreground">
            {projectName || 'Project Workspace'}
          </span>
        </header>

        {/* Tab bar */}
        {tabBar}

        {/* Content pane */}
        <main className="flex-1 h-full overflow-hidden min-w-0 relative">
          {children}
        </main>
      </div>
    </div>
  );
};
