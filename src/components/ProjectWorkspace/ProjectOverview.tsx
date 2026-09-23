import React, { useMemo } from 'react';
import {
  FileText,
  GitBranch,
  Layers,
  Plus,
  Clock,
  Sparkles,
  Folder,
  HardDrive,
} from 'lucide-react';
import { WorkspaceResource, WorkspaceFolder } from '@/types/workspace';
import { Button } from '@/components/ui/button';
import { formatDistanceToNow } from 'date-fns';

export interface ProjectOverviewProps {
  projectName: string;
  resources: WorkspaceResource[];
  folders?: WorkspaceFolder[];
  onOpenDocument: (id: string) => void;
  onOpenDesign: (id: string) => void;
  onCreateDocument: () => void;
  onCreateDesign: () => void;
}

export const ProjectOverview: React.FC<ProjectOverviewProps> = ({
  projectName,
  resources,
  folders = [],
  onOpenDocument,
  onOpenDesign,
  onCreateDocument,
  onCreateDesign,
}) => {
  const documents = resources.filter((r) => r.kind === 'document');
  const designs = resources.filter((r) => r.kind === 'design');
  const totalCount = resources.length;

  const folderMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of folders) {
      map.set(f.id, f.name);
    }
    return map;
  }, [folders]);

  // Top 4 recent resources
  const recents = useMemo(() => {
    return [...resources]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 4);
  }, [resources]);

  return (
    <div className="flex-1 h-full overflow-y-auto bg-background p-6 md:p-8 space-y-6 max-w-5xl mx-auto">
      {/* Header & Identity */}
      <div className="space-y-3 border-b border-border/40 pb-5">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
            <Layers className="h-4 w-4" />
          </div>
          <span className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
            Project Overview
          </span>
        </div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">
          {projectName || 'Untitled Project'}
        </h1>
        <p className="text-xs md:text-sm text-muted-foreground max-w-2xl">
          Unified workspace for software specifications, interactive system architectures, and algorithmic blueprints.
        </p>

        {/* Lightweight Summary Line */}
        <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">{totalCount} resources</span>
          <span>•</span>
          <span>{documents.length} documents</span>
          <span>•</span>
          <span>{designs.length} designs</span>
          <span>•</span>
          <span>{folders.length} folders</span>
        </div>
      </div>

      {/* Continue Working / Recent Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Continue Working
          </h2>
        </div>

        {totalCount === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-6 rounded-xl border border-dashed border-border/80 bg-card/20 text-center">
            <Sparkles className="h-9 w-9 text-primary/60 mb-3" />
            <h3 className="text-base font-semibold text-foreground mb-1">Your workspace is ready</h3>
            <p className="text-muted-foreground text-xs max-w-sm mb-5 leading-relaxed">
              Start by creating a specification document or mapping out an architecture diagram using the sidebar.
            </p>
            <div className="flex gap-3">
              <Button onClick={onCreateDocument} size="sm" className="gap-1.5 text-xs">
                <Plus className="h-3.5 w-3.5" />
                New Document
              </Button>
              <Button onClick={onCreateDesign} variant="outline" size="sm" className="gap-1.5 text-xs">
                <Plus className="h-3.5 w-3.5" />
                New Design
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {recents.map((res) => {
              const isDoc = res.kind === 'document';
              const Icon = isDoc ? FileText : GitBranch;
              const iconColor = isDoc ? 'text-sky-400' : 'text-purple-400';
              const iconBg = isDoc ? 'bg-sky-500/10 border-sky-500/20' : 'bg-purple-500/10 border-purple-500/20';
              const folderName = res.folderId ? folderMap.get(res.folderId) : null;

              return (
                <div
                  key={`recent-${res.id}`}
                  onClick={() => (isDoc ? onOpenDocument(res.id) : onOpenDesign(res.id))}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      if (isDoc) {
                        onOpenDocument(res.id);
                      } else {
                        onOpenDesign(res.id);
                      }
                    }
                  }}
                  className="group flex flex-col justify-between p-4 rounded-xl border border-border/50 bg-card/40 hover:border-primary/40 hover:bg-card/70 transition-all duration-150 cursor-pointer text-left"
                >
                  <div className="flex items-start gap-3">
                    <div className={`w-8 h-8 rounded-lg ${iconBg} border flex items-center justify-center shrink-0`}>
                      <Icon className={`h-4 w-4 ${iconColor}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium text-sm text-foreground truncate group-hover:text-primary transition-colors">
                        {res.title}
                      </h3>
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-1">
                        {folderName ? (
                          <>
                            <Folder className="h-3 w-3 text-amber-400 shrink-0" />
                            <span className="truncate">{folderName}</span>
                          </>
                        ) : (
                          <>
                            <HardDrive className="h-3 w-3 text-muted-foreground shrink-0" />
                            <span>Root</span>
                          </>
                        )}
                        <span>•</span>
                        <span className="capitalize">{res.kind}</span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 pt-2 border-t border-border/30 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>
                      {formatDistanceToNow(new Date(res.updatedAt), { addSuffix: true })}
                    </span>
                    <span className="text-primary opacity-0 group-hover:opacity-100 transition-opacity font-medium">
                      Open →
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
