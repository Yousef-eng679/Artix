import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProjects } from '@/hooks/useProjects';
import { useDocuments } from '@/hooks/useDocuments';
import { useSystemDesigns, BoardState } from '@/hooks/useSystemDesigns';
import { useUsageLimits } from '@/hooks/useUsageLimits';
import { useWorkspaceNavigation } from '@/hooks/useWorkspaceNavigation';
import { toWorkspaceResources } from '@/lib/workspace/resourceAdapter';
import { WorkspaceSelection, SidebarFilterKind } from '@/types/workspace';
import { ProjectWorkspaceLayout } from '@/components/ProjectWorkspace/ProjectWorkspaceLayout';
import { ProjectWorkspaceSidebar } from '@/components/ProjectWorkspace/ProjectWorkspaceSidebar';
import { ProjectOverview } from '@/components/ProjectWorkspace/ProjectOverview';
import { Editor, Document } from '@/components/Editor/Editor';
import { SystemArchitect } from '@/components/SystemArchitect/SystemArchitect';
import { RenameDialog } from '@/components/RenameDialog';
import { UpgradePrompt } from '@/components/UpgradePrompt';
import { toast } from 'sonner';

const ProjectWorkspace = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const { projects, isLoading: projectsLoading } = useProjects();
  const {
    documents,
    isLoading: docsLoading,
    createDocument,
    updateDocument,
    deleteDocument,
  } = useDocuments(id);
  const {
    designs,
    isLoading: designsLoading,
    createDesign,
    updateDesign,
    deleteDesign,
  } = useSystemDesigns(id);

  const { openOverview, openDocument, openDesign } = useWorkspaceNavigation();

  // Sidebar controls
  const [searchQuery, setSearchQuery] = useState('');
  const [filterKind, setFilterKind] = useState<SidebarFilterKind>('all');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Dialog states
  const [renameDoc, setRenameDoc] = useState<{ id: string; title: string } | null>(null);
  const [renameDesign, setRenameDesign] = useState<{ id: string; name: string } | null>(null);
  const [isCreateDocOpen, setIsCreateDocOpen] = useState(false);
  const [isCreateDesignOpen, setIsCreateDesignOpen] = useState(false);
  const [upgradePrompt, setUpgradePrompt] = useState<{ feature: string; used: number; limit: number } | null>(null);

  const usage = useUsageLimits();
  const project = projects.find((p) => p.id === id);

  // Adapter: convert raw domain entities to normalized WorkspaceResource[]
  const workspaceResources = useMemo(() => {
    return toWorkspaceResources(documents, designs, id || '');
  }, [documents, designs, id]);

  // Raw URL parameters
  const rawDocId = searchParams.get('doc');
  const rawDesignId = searchParams.get('design');

  // Conflict resolution: doc strictly takes precedence over design
  // Canonicalize URL by stripping design parameter if both exist
  useEffect(() => {
    if (rawDocId && rawDesignId) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('design');
      setSearchParams(nextParams, { replace: true });
    }
  }, [rawDocId, rawDesignId, searchParams, setSearchParams]);

  // Canonicalization on missing resource or project boundary violation
  useEffect(() => {
    if (docsLoading || designsLoading) return;

    if (rawDocId) {
      const docExists = documents.some((d) => d.id === rawDocId);
      if (!docExists) {
        toast.error('Document not found');
        const nextParams = new URLSearchParams(searchParams);
        nextParams.delete('doc');
        setSearchParams(nextParams, { replace: true });
      }
    } else if (rawDesignId) {
      const designExists = designs.some((d) => d.id === rawDesignId);
      if (!designExists) {
        toast.error('System design not found');
        const nextParams = new URLSearchParams(searchParams);
        nextParams.delete('design');
        setSearchParams(nextParams, { replace: true });
      }
    }
  }, [rawDocId, rawDesignId, docsLoading, designsLoading, documents, designs, searchParams, setSearchParams]);

  // Purely derived selection state (zero duplicate useState)
  const selection: WorkspaceSelection = useMemo(() => {
    if (rawDocId) {
      const doc = documents.find((d) => d.id === rawDocId);
      if (doc) {
        return { kind: 'document', resourceId: doc.id };
      }
    }
    if (rawDesignId && !rawDocId) {
      const design = designs.find((d) => d.id === rawDesignId);
      if (design) {
        return { kind: 'design', resourceId: design.id };
      }
    }
    return { kind: 'none' };
  }, [rawDocId, rawDesignId, documents, designs]);

  // Active resource models
  const activeDocument = useMemo(() => {
    if (selection.kind !== 'document') return null;
    return documents.find((d) => d.id === selection.resourceId) ?? null;
  }, [selection, documents]);

  const activeDesign = useMemo(() => {
    if (selection.kind !== 'design') return null;
    return designs.find((d) => d.id === selection.resourceId) ?? null;
  }, [selection, designs]);

  // Auth redirect
  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth', { replace: true });
    }
  }, [user, authLoading, navigate]);

  // Project validation redirect
  useEffect(() => {
    if (!projectsLoading && projects.length > 0 && !project && user) {
      navigate('/dashboard', { replace: true });
      toast.error('Project not found');
    }
  }, [project, projects, projectsLoading, user, navigate]);

  // Action parameter idempotency guard
  const executedActionRef = useRef<string | null>(null);

  useEffect(() => {
    if (projectsLoading || docsLoading || designsLoading || !id) return;

    const action = searchParams.get('action');
    if (!action || executedActionRef.current === action) return;

    executedActionRef.current = action;

    // Clear search param immediately to prevent repeating action on re-render/refresh
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('action');
    setSearchParams(nextParams, { replace: true });

    if (action === 'new-document') {
      setIsCreateDocOpen(true);
    } else if (action === 'new-design') {
      setIsCreateDesignOpen(true);
    } else if (action === 'new-vibe') {
      createDocument({ projectId: id, title: 'Untitled Document' })
        .then((newDoc) => {
          toast.success('Vibe Scratchpad created');
          const vibeParams = new URLSearchParams(searchParams);
          vibeParams.delete('action');
          vibeParams.set('doc', newDoc.id);
          vibeParams.set('vibe', 'true');
          setSearchParams(vibeParams, { replace: true });
        })
        .catch(() => {
          toast.error('Failed to start vibe coding');
        });
    }
  }, [projectsLoading, docsLoading, designsLoading, id, searchParams, setSearchParams, createDocument]);

  const handleSaveDesign = useCallback(async (boardState: BoardState) => {
    if (!activeDesign?.id) return;
    await updateDesign({ id: activeDesign.id, board_state: boardState });
  }, [activeDesign?.id, updateDesign]);

  const handleUpdateDesignName = useCallback(async (name: string) => {
    if (!activeDesign?.id) return;
    await updateDesign({ id: activeDesign.id, name });
  }, [activeDesign?.id, updateDesign]);

  const handleConfirmCreateDocument = async (title: string) => {
    if (!id) return;
    if (!usage.documents.canCreate) {
      setUpgradePrompt({ feature: 'document', used: usage.documents.used, limit: usage.documents.limit! });
      return;
    }
    try {
      const newDoc = await createDocument({ projectId: id, title });
      openDocument(newDoc.id);
      setIsCreateDocOpen(false);
      toast.success('New document created');
    } catch {
      toast.error('Failed to create document');
    }
  };

  const handleConfirmCreateDesign = async (name: string) => {
    if (!id) return;
    if (!usage.systemDesigns.canCreate) {
      setUpgradePrompt({ feature: 'system design', used: usage.systemDesigns.used, limit: usage.systemDesigns.limit! });
      return;
    }
    try {
      const newDesign = await createDesign({ name, projectId: id });
      openDesign(newDesign.id);
      setIsCreateDesignOpen(false);
      toast.success('New system design created');
    } catch {
      toast.error('Failed to create system design');
    }
  };

  const handleSaveDocument = async (updates: Partial<Document>) => {
    if (!updates.id) return;
    try {
      await updateDocument(updates as Partial<Document> & { id: string });
    } catch (error) {
      toast.error('Failed to save document');
      throw error;
    }
  };

  const handleDeleteDocument = async (docId: string) => {
    try {
      await deleteDocument(docId);
      if (selection.kind === 'document' && selection.resourceId === docId) {
        openOverview();
      }
      toast.success('Document deleted');
    } catch {
      toast.error('Failed to delete document');
    }
  };

  const handleDeleteDesign = async (designId: string) => {
    try {
      await deleteDesign(designId);
      if (selection.kind === 'design' && selection.resourceId === designId) {
        openOverview();
      }
      toast.success('System design deleted');
    } catch {
      toast.error('Failed to delete system design');
    }
  };

  const handleRenameDocument = async (newTitle: string) => {
    if (!renameDoc) return;
    await updateDocument({ id: renameDoc.id, title: newTitle });
    setRenameDoc(null);
    toast.success('Document renamed');
  };

  const handleRenameDesign = async (newName: string) => {
    if (!renameDesign) return;
    await updateDesign({ id: renameDesign.id, name: newName });
    setRenameDesign(null);
    toast.success('Design renamed');
  };

  // Auth / Projects loading
  if (authLoading || projectsLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Not authenticated
  if (!user) {
    return null;
  }

  const projectName = project?.name || 'Project Workspace';

  return (
    <ProjectWorkspaceLayout
      projectName={projectName}
      isMobileOpen={isMobileSidebarOpen}
      onMobileOpenChange={setIsMobileSidebarOpen}
      sidebar={
        <ProjectWorkspaceSidebar
          projectName={projectName}
          resources={workspaceResources}
          selection={selection}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSelectOverview={() => {
            openOverview();
            setIsMobileSidebarOpen(false);
          }}
          onSelectResource={(res) => {
            if (res.kind === 'document') {
              openDocument(res.id);
            } else {
              openDesign(res.id);
            }
            setIsMobileSidebarOpen(false);
          }}
          onCreateDocument={() => setIsCreateDocOpen(true)}
          onCreateDesign={() => setIsCreateDesignOpen(true)}
          onRenameResource={(res) => {
            if (res.kind === 'document') {
              setRenameDoc({ id: res.id, title: res.title });
            } else {
              setRenameDesign({ id: res.id, name: res.title });
            }
          }}
          onDeleteResource={(res) => {
            if (res.kind === 'document') {
              handleDeleteDocument(res.id);
            } else {
              handleDeleteDesign(res.id);
            }
          }}
          collapsed={isSidebarCollapsed}
          onToggleCollapsed={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          onBackToDashboard={() => navigate('/dashboard')}
          filterKind={filterKind}
          onFilterKindChange={setFilterKind}
        />
      }
    >
      {/* Workspace Content View */}
      {selection.kind === 'document' ? (
        activeDocument ? (
          <Editor
            document={activeDocument}
            onSave={handleSaveDocument}
            onBack={openOverview}
            projectId={id}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        )
      ) : selection.kind === 'design' ? (
        activeDesign ? (
          <SystemArchitect
            design={activeDesign}
            onSave={handleSaveDesign}
            onUpdateName={handleUpdateDesignName}
            onBack={openOverview}
            documents={documents.map((d) => ({ id: d.id, title: d.title, content: d.content || '' }))}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        )
      ) : (
        <ProjectOverview
          projectName={projectName}
          resources={workspaceResources}
          onOpenDocument={openDocument}
          onOpenDesign={openDesign}
          onCreateDocument={() => setIsCreateDocOpen(true)}
          onCreateDesign={() => setIsCreateDesignOpen(true)}
        />
      )}

      {/* Rename Dialogs */}
      <RenameDialog
        open={!!renameDoc}
        onOpenChange={(open) => {
          if (!open) setRenameDoc(null);
        }}
        currentName={renameDoc?.title || ''}
        onSave={handleRenameDocument}
        title="Rename Document"
      />
      <RenameDialog
        open={!!renameDesign}
        onOpenChange={(open) => {
          if (!open) setRenameDesign(null);
        }}
        currentName={renameDesign?.name || ''}
        onSave={handleRenameDesign}
        title="Rename System Design"
      />

      {/* Create Dialogs */}
      <RenameDialog
        open={isCreateDocOpen}
        onOpenChange={setIsCreateDocOpen}
        currentName="Untitled Document"
        onSave={handleConfirmCreateDocument}
        title="Create New Document"
      />
      <RenameDialog
        open={isCreateDesignOpen}
        onOpenChange={setIsCreateDesignOpen}
        currentName="New System Design"
        onSave={handleConfirmCreateDesign}
        title="Create New System Design"
      />

      {/* Upgrade Prompt */}
      <UpgradePrompt
        open={!!upgradePrompt}
        onOpenChange={(open) => {
          if (!open) setUpgradePrompt(null);
        }}
        feature={upgradePrompt?.feature ?? ''}
        used={upgradePrompt?.used ?? 0}
        limit={upgradePrompt?.limit ?? 0}
      />
    </ProjectWorkspaceLayout>
  );
};

export default ProjectWorkspace;
