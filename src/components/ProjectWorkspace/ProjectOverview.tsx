import React from 'react';
import {
  FileText,
  GitBranch,
  Layers,
  Plus,
  ArrowRight,
  Clock,
  Sparkles,
} from 'lucide-react';
import { WorkspaceResource } from '@/types/workspace';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDistanceToNow } from 'date-fns';

interface ProjectOverviewProps {
  projectName: string;
  resources: WorkspaceResource[];
  onOpenDocument: (id: string) => void;
  onOpenDesign: (id: string) => void;
  onCreateDocument: () => void;
  onCreateDesign: () => void;
}

export const ProjectOverview: React.FC<ProjectOverviewProps> = ({
  projectName,
  resources,
  onOpenDocument,
  onOpenDesign,
  onCreateDocument,
  onCreateDesign,
}) => {
  const documents = resources.filter((r) => r.kind === 'document');
  const designs = resources.filter((r) => r.kind === 'design');
  const totalCount = resources.length;

  // Top 6 recent resources
  const recents = [...resources]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 6);

  return (
    <div className="flex-1 h-full overflow-y-auto bg-background p-6 md:p-8 space-y-8 max-w-6xl mx-auto">
      {/* Hero / Header */}
      <div className="space-y-2 border-b border-border/40 pb-6">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
            <Layers className="h-4 w-4" />
          </div>
          <span className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
            Project Workspace
          </span>
        </div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">
          {projectName || 'Untitled Project'}
        </h1>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Unified workspace for software specifications, interactive system architectures, and algorithmic blueprints.
        </p>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="bg-card/60 border-border/50 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase">
              Total Resources
            </CardTitle>
            <Layers className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">{totalCount}</div>
            <p className="text-xs text-muted-foreground mt-1">Documents & Visual Boards</p>
          </CardContent>
        </Card>

        <Card className="bg-card/60 border-border/50 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase">
              Documents
            </CardTitle>
            <FileText className="h-4 w-4 text-sky-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">{documents.length}</div>
            <p className="text-xs text-muted-foreground mt-1">PRDs, RFCs & Markdown notes</p>
          </CardContent>
        </Card>

        <Card className="bg-card/60 border-border/50 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase">
              System Designs
            </CardTitle>
            <GitBranch className="h-4 w-4 text-purple-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">{designs.length}</div>
            <p className="text-xs text-muted-foreground mt-1">Architectures & Algorithm flows</p>
          </CardContent>
        </Card>
      </div>

      {/* Quick Action Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <button
          onClick={onCreateDocument}
          className="group flex items-start gap-4 p-5 rounded-xl border border-border/60 bg-gradient-to-br from-card/80 to-card/40 hover:border-sky-500/40 hover:bg-card transition-all duration-200 text-left cursor-pointer"
        >
          <div className="w-10 h-10 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400 shrink-0 group-hover:scale-105 transition-transform">
            <Plus className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-foreground group-hover:text-sky-400 transition-colors">
                Create Document
              </h3>
              <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
            </div>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Author technical requirements, architecture decision records, or product specs in Markdown.
            </p>
          </div>
        </button>

        <button
          onClick={onCreateDesign}
          className="group flex items-start gap-4 p-5 rounded-xl border border-border/60 bg-gradient-to-br from-card/80 to-card/40 hover:border-purple-500/40 hover:bg-card transition-all duration-200 text-left cursor-pointer"
        >
          <div className="w-10 h-10 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 shrink-0 group-hover:scale-105 transition-transform">
            <Plus className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-foreground group-hover:text-purple-400 transition-colors">
                New System Design
              </h3>
              <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
            </div>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Design reactive microservices, databases, API gateways, and distributed message topologies.
            </p>
          </div>
        </button>
      </div>

      {/* Recents Grid */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Recent Activity
          </h2>
        </div>

        {totalCount === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-6 rounded-xl border border-dashed border-border/80 bg-card/20 text-center">
            <Sparkles className="h-10 w-10 text-primary/60 mb-3" />
            <h3 className="text-base font-semibold text-foreground mb-1">Your workspace is ready</h3>
            <p className="text-muted-foreground text-xs max-w-sm mb-5 leading-relaxed">
              Start by creating a specification document or mapping out an architecture diagram.
            </p>
            <div className="flex gap-3">
              <Button onClick={onCreateDocument} size="sm" className="gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                New Document
              </Button>
              <Button onClick={onCreateDesign} variant="outline" size="sm" className="gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                New Design
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {recents.map((res) => {
              const isDoc = res.kind === 'document';
              const Icon = isDoc ? FileText : GitBranch;
              const iconColor = isDoc ? 'text-sky-400' : 'text-purple-400';
              const iconBg = isDoc ? 'bg-sky-500/10 border-sky-500/20' : 'bg-purple-500/10 border-purple-500/20';

              return (
                <div
                  key={`card-${res.id}`}
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
                  className="group flex flex-col justify-between p-4 rounded-xl border border-border/50 bg-card/40 hover:border-primary/40 hover:bg-card/80 transition-all duration-150 cursor-pointer text-left"
                >
                  <div className="flex items-start gap-3">
                    <div className={`w-8 h-8 rounded-lg ${iconBg} border flex items-center justify-center shrink-0`}>
                      <Icon className={`h-4 w-4 ${iconColor}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium text-sm text-foreground truncate group-hover:text-primary transition-colors">
                        {res.title}
                      </h4>
                      <p className="text-[11px] text-muted-foreground capitalize mt-0.5">
                        {res.kind}
                        {res.meta?.format && ` • ${res.meta.format}`}
                        {res.meta?.nodeCount !== undefined && ` • ${res.meta.nodeCount} nodes`}
                      </p>
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
