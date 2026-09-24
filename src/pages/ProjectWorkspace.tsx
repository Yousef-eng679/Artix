import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProjects } from '@/hooks/useProjects';
import { useDocuments } from '@/hooks/useDocuments';
import { useSystemDesigns, BoardState } from '@/hooks/useSystemDesigns';
import { useUsageLimits } from '@/hooks/useUsageLimits';
import { useWorkspaceNavigation } from '@/hooks/useWorkspaceNavigation';
import { useWorkspaceFolders } from '@/hooks/useWorkspaceFolders';
import { toWorkspaceResources } from '@/lib/workspace/resourceAdapter';
import { WorkspaceSelection, WorkspaceFolder, SidebarFilterKind } from '@/types/workspace';
import { ProjectWorkspaceLayout } from '@/components/ProjectWorkspace/ProjectWorkspaceLayout';
import { ProjectWorkspaceSidebar } from '@/components/ProjectWorkspace/ProjectWorkspaceSidebar';
import { ProjectOverview } from '@/components/ProjectWorkspace/ProjectOverview';
import { Editor, Document } from '@/components/Editor/Editor';
import { SystemArchitect } from '@/components/SystemArchitect/SystemArchitect';
import { RenameDialog } from '@/components/RenameDialog';
import { WorkspaceMoveResourceDialog } from '@/components/ProjectWorkspace/WorkspaceMoveResourceDialog';
import { WorkspaceTabBar } from '@/components/ProjectWorkspace/WorkspaceTabBar';
import { CloseTabConfirmDialog } from '@/components/ProjectWorkspace/CloseTabConfirmDialog';
import { useWorkspaceTabs } from '@/hooks/useWorkspaceTabs';
import { parseTabId } from '@/lib/workspace/workspaceTabs';
import { dirtyTracker } from '@/lib/workspace/dirtyTracker';
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
  const {
    folders,
    createFolder,
    renameFolder: renameFolderMutation,
    deleteFolder,
  } = useWorkspaceFolders(id);

  const { openOverview, openDocument, openDesign } = useWorkspaceNavigation();

  // Sidebar controls
  const [searchQuery, setSearchQuery] = useState('');
  const [filterKind, setFilterKind] = useState<SidebarFilterKind>('all');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Dialog states
  const [renameDoc, setRenameDoc] = useState<{ id: string; title: string } | null>(null);
  const [renameDesign, setRenameDesign] = useState<{ id: string; name: string } | null>(null);
  const [renameFolder, setRenameFolder] = useState<WorkspaceFolder | null>(null);
  const [isCreateDocOpen, setIsCreateDocOpen] = useState(false);
  const [isCreateDesignOpen, setIsCreateDesignOpen] = useState(false);
  const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
  const [targetFolderForNewResource, setTargetFolderForNewResource] = useState<string | null>(null);
  const [moveResource, setMoveResource] = useState<WorkspaceResource | null>(null);
  const [upgradePrompt, setUpgradePrompt] = useState<{ feature: string; used: number; limit: number } | null>(null);

  const usage = useUsageLimits();
  const project = projects.find((p) => p.id === id);

  // Adapter: convert raw domain entities to normalized WorkspaceResource[]
  const workspaceResources = useMemo(() => {
    return toWorkspaceResources(documents, designs, id || '');
  }, [documents, designs, id]);

  const isResourcesLoaded = !docsLoading && !designsLoading;
  const {
    tabs,
    activeTabId,
    openTab,
    activateTab,
    closeTab,
    closeAllTabs,
  } = useWorkspaceTabs(id || '', workspaceResources, isResourcesLoaded);

  // Close protection for dirty tabs
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);

  const handleRequestCloseTab = useCallback(
    (tabId: string) => {
      const parsed = parseTabId(tabId);
      if (parsed && dirtyTracker.isDirty(parsed.resourceId, parsed.resourceKind)) {
        setPendingCloseTabId(tabId);
      } else {
        closeTab(tabId);
      }
    },
    [closeTab],
  );

  const handleConfirmCloseDirtyTab = useCallback(() => {
    if (pendingCloseTabId) {
      closeTab(pendingCloseTabId);
      setPendingCloseTabId(null);
    }
  }, [pendingCloseTabId, closeTab]);

  const handleCancelCloseDirtyTab = useCallback(() => {
    setPendingCloseTabId(null);
  }, []);

  const pendingCloseTabTitle = useMemo(() => {
    if (!pendingCloseTabId) return '';
    const parsed = parseTabId(pendingCloseTabId);
    if (!parsed) return '';
    const res = workspaceResources.find(
      (r) => r.id === parsed.resourceId && r.kind === parsed.resourceKind,
    );
    return res?.title || (parsed.resourceKind === 'document' ? 'Document' : 'System Design');
  }, [pendingCloseTabId, workspaceResources]);

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

  // Track IDs created in the current session to avoid race condition with async cache refetch
  const recentlyCreatedRef = useRef<Set<string>>(new Set());

  // Canonicalization on missing resource or project boundary violation
  useEffect(() => {
    if (docsLoading || designsLoading) return;

    if (rawDocId) {
      if (recentlyCreatedRef.current.has(rawDocId)) {
        if (documents.some((d) => d.id === rawDocId)) {
          recentlyCreatedRef.current.delete(rawDocId);
        }
        return;
      }

      const docExists = documents.some((d) => d.id === rawDocId);
      if (!docExists) {
        toast.error('Document not found');
        const nextParams = new URLSearchParams(searchParams);
        nextParams.delete('doc');
        setSearchParams(nextParams, { replace: true });
      }
    } else if (rawDesignId) {
      if (recentlyCreatedRef.current.has(rawDesignId)) {
        if (designs.some((d) => d.id === rawDesignId)) {
          recentlyCreatedRef.current.delete(rawDesignId);
        }
        return;
      }

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
        return { kind: 'document', id: doc.id };
      }
    }
    if (rawDesignId && !rawDocId) {
      const design = designs.find((d) => d.id === rawDesignId);
      if (design) {
        return { kind: 'design', id: design.id };
      }
    }
    return { kind: 'none' };
  }, [rawDocId, rawDesignId, documents, designs]);

  // Active resource models
  const activeDocument = useMemo(() => {
    if (selection.kind !== 'document') return null;
    return documents.find((d) => d.id === selection.id) ?? null;
  }, [selection, documents]);

  const activeDesign = useMemo(() => {
    if (selection.kind !== 'design') return null;
    return designs.find((d) => d.id === selection.id) ?? null;
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
          recentlyCreatedRef.current.add(newDoc.id);
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

  // Helper to detect duplicate resource names in the same folder / location
  const isResourceNameDuplicate = useCallback(
    (candidateName: string, targetFolderId: string | null, excludeResourceId?: string): boolean => {
      const trimmed = candidateName.trim().toLowerCase();
      const target = targetFolderId ?? null;
      return workspaceResources.some(
        (r) =>
          r.id !== excludeResourceId &&
          (r.folderId ?? null) === target &&
          r.title.trim().toLowerCase() === trimmed
      );
    },
    [workspaceResources]
  );

  // Helper to suggest a non-colliding default document name for the target folder
  const defaultNewDocName = useMemo(() => {
    const base = 'Untitled Document';
    const target = targetFolderForNewResource ?? null;
    const exists = (candidate: string) =>
      workspaceResources.some(
        (r) => (r.folderId ?? null) === target && r.title.trim().toLowerCase() === candidate.toLowerCase()
      );
    if (!exists(base)) return base;
    let counter = 2;
    while (exists(`${base} ${counter}`)) {
      counter++;
    }
    return `${base} ${counter}`;
  }, [workspaceResources, targetFolderForNewResource]);

  // Helper to suggest a non-colliding default system design name for the target folder
  const defaultNewDesignName = useMemo(() => {
    const base = 'New System Design';
    const target = targetFolderForNewResource ?? null;
    const exists = (candidate: string) =>
      workspaceResources.some(
        (r) => (r.folderId ?? null) === target && r.title.trim().toLowerCase() === candidate.toLowerCase()
      );
    if (!exists(base)) return base;
    let counter = 2;
    while (exists(`${base} ${counter}`)) {
      counter++;
    }
    return `${base} ${counter}`;
  }, [workspaceResources, targetFolderForNewResource]);

  const handleConfirmCreateDocument = async (title: string) => {
    if (!id) return;
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error('Document title cannot be empty');
    }
    if (isResourceNameDuplicate(trimmed, targetFolderForNewResource)) {
      const location = targetFolderForNewResource
        ? `in folder "${folders.find((f) => f.id === targetFolderForNewResource)?.name || 'this folder'}"`
        : 'in Root';
      const errMsg = `A resource named "${trimmed}" already exists ${location}`;
      toast.error(errMsg);
      throw new Error(errMsg);
    }
    if (!usage.documents.canCreate) {
      setUpgradePrompt({ feature: 'document', used: usage.documents.used, limit: usage.documents.limit! });
      return;
    }
    try {
      const newDoc = await createDocument({
        projectId: id,
        title: trimmed,
        folderId: targetFolderForNewResource,
      });
      recentlyCreatedRef.current.add(newDoc.id);
      openTab({ kind: 'document', id: newDoc.id });
      setIsCreateDocOpen(false);
      setTargetFolderForNewResource(null);
      toast.success('New document created');
    } catch (err: any) {
      if (!err?.message?.includes('already exists')) {
        toast.error('Failed to create document');
      }
      throw err;
    }
  };

  const handleConfirmCreateDesign = async (name: string) => {
    if (!id) return;
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Design name cannot be empty');
    }
    if (isResourceNameDuplicate(trimmed, targetFolderForNewResource)) {
      const location = targetFolderForNewResource
        ? `in folder "${folders.find((f) => f.id === targetFolderForNewResource)?.name || 'this folder'}"`
        : 'in Root';
      const errMsg = `A resource named "${trimmed}" already exists ${location}`;
      toast.error(errMsg);
      throw new Error(errMsg);
    }
    if (!usage.systemDesigns.canCreate) {
      setUpgradePrompt({ feature: 'system design', used: usage.systemDesigns.used, limit: usage.systemDesigns.limit! });
      return;
    }
    try {
      const newDesign = await createDesign({
        name: trimmed,
        projectId: id,
        folderId: targetFolderForNewResource,
      });
      recentlyCreatedRef.current.add(newDesign.id);
      openTab({ kind: 'design', id: newDesign.id });
      setIsCreateDesignOpen(false);
      setTargetFolderForNewResource(null);
      toast.success('New system design created');
    } catch (err: any) {
      if (!err?.message?.includes('already exists')) {
        toast.error('Failed to create system design');
      }
      throw err;
    }
  };

  // Helper to suggest a non-colliding default folder name
  const defaultNewFolderName = useMemo(() => {
    const base = 'New Folder';
    if (!folders.some((f) => f.name.trim().toLowerCase() === base.toLowerCase())) {
      return base;
    }
    let counter = 2;
    while (folders.some((f) => f.name.trim().toLowerCase() === `${base} ${counter}`.toLowerCase())) {
      counter++;
    }
    return `${base} ${counter}`;
  }, [folders]);

  const handleCreateFolder = async (name: string) => {
    if (!id) return;
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Folder name cannot be empty');
    }
    const isDuplicate = folders.some(
      (f) => f.name.trim().toLowerCase() === trimmed.toLowerCase()
    );
    if (isDuplicate) {
      const errMsg = `A folder named "${trimmed}" already exists in this project`;
      toast.error(errMsg);
      throw new Error(errMsg);
    }
    try {
      await createFolder({ name: trimmed, projectId: id });
      setIsCreateFolderOpen(false);
      toast.success('Folder created');
    } catch (err: any) {
      if (!err?.message?.includes('already exists')) {
        toast.error('Failed to create folder');
      }
      throw err;
    }
  };

  const handleRenameFolder = async (newName: string) => {
    if (!renameFolder) return;
    const trimmed = newName.trim();
    if (!trimmed) {
      throw new Error('Folder name cannot be empty');
    }
    if (trimmed.toLowerCase() === renameFolder.name.trim().toLowerCase()) {
      setRenameFolder(null);
      return;
    }
    const isDuplicate = folders.some(
      (f) => f.id !== renameFolder.id && f.name.trim().toLowerCase() === trimmed.toLowerCase()
    );
    if (isDuplicate) {
      const errMsg = `A folder named "${trimmed}" already exists in this project`;
      toast.error(errMsg);
      throw new Error(errMsg);
    }
    try {
      await renameFolderMutation({ id: renameFolder.id, name: trimmed });
      setRenameFolder(null);
      toast.success('Folder renamed');
    } catch (err: any) {
      if (!err?.message?.includes('already exists')) {
        toast.error('Failed to rename folder');
      }
      throw err;
    }
  };

  const handleDeleteFolder = async (folder: WorkspaceFolder) => {
    try {
      await deleteFolder(folder.id);
      toast.success(`Folder "${folder.name}" deleted. Contained resources moved to Root.`);
    } catch {
      toast.error('Failed to delete folder');
    }
  };

  const handleMoveResource = async (targetFolderId: string | null) => {
    if (!moveResource) return;
    if (isResourceNameDuplicate(moveResource.title, targetFolderId, moveResource.id)) {
      const targetName = targetFolderId
        ? `folder "${folders.find((f) => f.id === targetFolderId)?.name || 'target folder'}"`
        : 'Root';
      toast.error(`A resource named "${moveResource.title}" already exists in ${targetName}`);
      return;
    }
    try {
      if (moveResource.kind === 'document') {
        await updateDocument({ id: moveResource.id, folder_id: targetFolderId });
      } else {
        await updateDesign({ id: moveResource.id, folder_id: targetFolderId });
      }
      setMoveResource(null);
      toast.success('Resource moved');
    } catch {
      toast.error('Failed to move resource');
      throw new Error('Failed to move resource');
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
      closeTab(`document:${docId}`);
      toast.success('Document deleted');
    } catch {
      toast.error('Failed to delete document');
    }
  };

  const handleDeleteDesign = async (designId: string) => {
    try {
      await deleteDesign(designId);
      closeTab(`design:${designId}`);
      toast.success('System design deleted');
    } catch {
      toast.error('Failed to delete system design');
    }
  };

  const handleRenameDocument = async (newTitle: string) => {
    if (!renameDoc) return;
    const trimmed = newTitle.trim();
    if (!trimmed) {
      throw new Error('Document title cannot be empty');
    }
    if (trimmed.toLowerCase() === renameDoc.title.trim().toLowerCase()) {
      setRenameDoc(null);
      return;
    }
    const currentFolderId = workspaceResources.find((r) => r.id === renameDoc.id)?.folderId ?? null;
    if (isResourceNameDuplicate(trimmed, currentFolderId, renameDoc.id)) {
      const location = currentFolderId
        ? `in folder "${folders.find((f) => f.id === currentFolderId)?.name || 'this folder'}"`
        : 'in Root';
      const errMsg = `A resource named "${trimmed}" already exists ${location}`;
      toast.error(errMsg);
      throw new Error(errMsg);
    }
    try {
      await updateDocument({ id: renameDoc.id, title: trimmed });
      setRenameDoc(null);
      toast.success('Document renamed');
    } catch (err: any) {
      if (!err?.message?.includes('already exists')) {
        toast.error('Failed to rename document');
      }
      throw err;
    }
  };

  const handleRenameDesign = async (newName: string) => {
    if (!renameDesign) return;
    const trimmed = newName.trim();
    if (!trimmed) {
      throw new Error('Design name cannot be empty');
    }
    if (trimmed.toLowerCase() === renameDesign.name.trim().toLowerCase()) {
      setRenameDesign(null);
      return;
    }
    const currentFolderId = workspaceResources.find((r) => r.id === renameDesign.id)?.folderId ?? null;
    if (isResourceNameDuplicate(trimmed, currentFolderId, renameDesign.id)) {
      const location = currentFolderId
        ? `in folder "${folders.find((f) => f.id === currentFolderId)?.name || 'this folder'}"`
        : 'in Root';
      const errMsg = `A resource named "${trimmed}" already exists ${location}`;
      toast.error(errMsg);
      throw new Error(errMsg);
    }
    try {
      await updateDesign({ id: renameDesign.id, name: trimmed });
      setRenameDesign(null);
      toast.success('Design renamed');
    } catch (err: any) {
      if (!err?.message?.includes('already exists')) {
        toast.error('Failed to rename design');
      }
      throw err;
    }
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
          folders={folders}
          selection={selection}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSelectOverview={() => {
            openOverview();
            setIsMobileSidebarOpen(false);
          }}
          onSelectResource={(res) => {
            openTab({ kind: res.kind, id: res.id });
            setIsMobileSidebarOpen(false);
          }}
          onCreateDocument={(folderId) => {
            setTargetFolderForNewResource(folderId ?? null);
            setIsCreateDocOpen(true);
          }}
          onCreateDesign={(folderId) => {
            setTargetFolderForNewResource(folderId ?? null);
            setIsCreateDesignOpen(true);
          }}
          onCreateFolder={() => setIsCreateFolderOpen(true)}
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
          onRenameFolder={(f) => setRenameFolder(f)}
          onDeleteFolder={handleDeleteFolder}
          onMoveResource={(res) => setMoveResource(res)}
          collapsed={isSidebarCollapsed}
          onToggleCollapsed={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          onBackToDashboard={() => navigate('/dashboard')}
          filterKind={filterKind}
          onFilterKindChange={setFilterKind}
        />
      }
      tabBar={
        <WorkspaceTabBar
          tabs={tabs}
          activeTabId={activeTabId}
          resources={workspaceResources}
          onActivateTab={activateTab}
          onCloseTab={handleRequestCloseTab}
          onCloseAllTabs={closeAllTabs}
        />
      }
    >
      {/* Workspace Content View */}
      {selection.kind === 'document' ? (
        activeDocument ? (
          <Editor
            key={activeDocument.id}
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
            key={activeDesign.id}
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
          folders={folders}
          onOpenDocument={(docId) => openTab({ kind: 'document', id: docId })}
          onOpenDesign={(designId) => openTab({ kind: 'design', id: designId })}
          onCreateDocument={() => {
            setTargetFolderForNewResource(null);
            setIsCreateDocOpen(true);
          }}
          onCreateDesign={() => {
            setTargetFolderForNewResource(null);
            setIsCreateDesignOpen(true);
          }}
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
        validate={(newName) => {
          if (!renameDoc) return null;
          const trimmed = newName.trim();
          if (trimmed.toLowerCase() === renameDoc.title.trim().toLowerCase()) return null;
          const currentFolderId = workspaceResources.find((r) => r.id === renameDoc.id)?.folderId ?? null;
          if (isResourceNameDuplicate(trimmed, currentFolderId, renameDoc.id)) {
            const location = currentFolderId
              ? `in folder "${folders.find((f) => f.id === currentFolderId)?.name || 'this folder'}"`
              : 'in Root';
            return `A resource named "${trimmed}" already exists ${location}`;
          }
          return null;
        }}
      />
      <RenameDialog
        open={!!renameDesign}
        onOpenChange={(open) => {
          if (!open) setRenameDesign(null);
        }}
        currentName={renameDesign?.name || ''}
        onSave={handleRenameDesign}
        title="Rename System Design"
        validate={(newName) => {
          if (!renameDesign) return null;
          const trimmed = newName.trim();
          if (trimmed.toLowerCase() === renameDesign.name.trim().toLowerCase()) return null;
          const currentFolderId = workspaceResources.find((r) => r.id === renameDesign.id)?.folderId ?? null;
          if (isResourceNameDuplicate(trimmed, currentFolderId, renameDesign.id)) {
            const location = currentFolderId
              ? `in folder "${folders.find((f) => f.id === currentFolderId)?.name || 'this folder'}"`
              : 'in Root';
            return `A resource named "${trimmed}" already exists ${location}`;
          }
          return null;
        }}
      />
      <RenameDialog
        open={!!renameFolder}
        onOpenChange={(open) => {
          if (!open) setRenameFolder(null);
        }}
        currentName={renameFolder?.name || ''}
        onSave={handleRenameFolder}
        title="Rename Folder"
        validate={(newName) => {
          if (!renameFolder) return null;
          const trimmed = newName.trim();
          if (trimmed.toLowerCase() === renameFolder.name.trim().toLowerCase()) {
            return null; // keeping same name is valid
          }
          const isDuplicate = folders.some(
            (f) => f.id !== renameFolder.id && f.name.trim().toLowerCase() === trimmed.toLowerCase()
          );
          if (isDuplicate) {
            return `A folder named "${trimmed}" already exists in this project`;
          }
          return null;
        }}
      />

      {/* Create Dialogs */}
      <RenameDialog
        open={isCreateDocOpen}
        onOpenChange={(open) => {
          setIsCreateDocOpen(open);
          if (!open) setTargetFolderForNewResource(null);
        }}
        currentName={defaultNewDocName}
        onSave={handleConfirmCreateDocument}
        title={targetFolderForNewResource ? 'Create Document in Folder' : 'Create New Document'}
        validate={(newName) => {
          const trimmed = newName.trim();
          if (isResourceNameDuplicate(trimmed, targetFolderForNewResource)) {
            const location = targetFolderForNewResource
              ? `in folder "${folders.find((f) => f.id === targetFolderForNewResource)?.name || 'this folder'}"`
              : 'in Root';
            return `A resource named "${trimmed}" already exists ${location}`;
          }
          return null;
        }}
      />
      <RenameDialog
        open={isCreateDesignOpen}
        onOpenChange={(open) => {
          setIsCreateDesignOpen(open);
          if (!open) setTargetFolderForNewResource(null);
        }}
        currentName={defaultNewDesignName}
        onSave={handleConfirmCreateDesign}
        title={targetFolderForNewResource ? 'Create Design in Folder' : 'Create New System Design'}
        validate={(newName) => {
          const trimmed = newName.trim();
          if (isResourceNameDuplicate(trimmed, targetFolderForNewResource)) {
            const location = targetFolderForNewResource
              ? `in folder "${folders.find((f) => f.id === targetFolderForNewResource)?.name || 'this folder'}"`
              : 'in Root';
            return `A resource named "${trimmed}" already exists ${location}`;
          }
          return null;
        }}
      />
      <RenameDialog
        open={isCreateFolderOpen}
        onOpenChange={setIsCreateFolderOpen}
        currentName={defaultNewFolderName}
        onSave={handleCreateFolder}
        title="Create New Folder"
        validate={(newName) => {
          const trimmed = newName.trim();
          const isDuplicate = folders.some(
            (f) => f.name.trim().toLowerCase() === trimmed.toLowerCase()
          );
          if (isDuplicate) {
            return `A folder named "${trimmed}" already exists in this project`;
          }
          return null;
        }}
      />

      {/* Move Resource Dialog */}
      <WorkspaceMoveResourceDialog
        open={!!moveResource}
        onOpenChange={(open) => {
          if (!open) setMoveResource(null);
        }}
        resourceTitle={moveResource?.title || ''}
        currentFolderId={moveResource?.folderId ?? null}
        folders={folders}
        onMove={handleMoveResource}
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

      {/* Dirty Tab Close Protection Confirmation */}
      <CloseTabConfirmDialog
        open={!!pendingCloseTabId}
        tabTitle={pendingCloseTabTitle}
        onConfirm={handleConfirmCloseDirtyTab}
        onCancel={handleCancelCloseDirtyTab}
      />
    </ProjectWorkspaceLayout>
  );
};

export default ProjectWorkspace;
