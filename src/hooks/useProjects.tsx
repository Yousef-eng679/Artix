import { useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { useUserSyncRuntime } from '@/contexts/UserSyncRuntimeContext';
import { ArtixDB, getUserArtixDB } from '@/lib/local/db';
import { LocalProject, OutboxEntry, SyncMetadata } from '@/lib/local/types';
import { ProjectRepository } from '@/lib/repositories/projectRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { getTabCoordinator } from '@/lib/sync/tabCoordinator';

export interface Project {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  local_revision?: number;
  document_count?: number;
  design_count?: number;
}

async function readLocalProjectState(db: ArtixDB, userId: string) {
  const [localProjects, localDocs, localDesigns, projectOutbox, projectMeta, hydrationMeta] =
    await Promise.all([
      db.projects.where('userId').equals(userId).toArray().catch(() => [] as LocalProject[]),
      db.documents.where('userId').equals(userId).toArray().catch(() => []),
      db.system_designs.where('userId').equals(userId).toArray().catch(() => []),
      db.outbox
        .where('userId')
        .equals(userId)
        .filter((e) => e.entityType === 'project')
        .toArray()
        .catch(() => [] as OutboxEntry[]),
      db.sync_metadata
        .where('[userId+entityType]')
        .equals([userId, 'project'])
        .toArray()
        .catch(() => [] as SyncMetadata[]),
      db.database_meta.get('hydration_complete').catch(() => undefined),
    ]);

  const isHydrated = Boolean(hydrationMeta?.value);
  const hasAnyLocalEntities = localDocs.length > 0 || localDesigns.length > 0;

  const liveDocIdsByProject = new Map<string, Set<string>>();
  const deletedDocIds = new Set<string>();
  for (const doc of localDocs) {
    if (doc.isDeleted) {
      deletedDocIds.add(doc.id);
      continue;
    }
    if (doc.projectId) {
      let bucket = liveDocIdsByProject.get(doc.projectId);
      if (!bucket) {
        bucket = new Set<string>();
        liveDocIdsByProject.set(doc.projectId, bucket);
      }
      bucket.add(doc.id);
    }
  }

  const liveDesignIdsByProject = new Map<string, Set<string>>();
  const deletedDesignIds = new Set<string>();
  for (const design of localDesigns) {
    if (design.isDeleted) {
      deletedDesignIds.add(design.id);
      continue;
    }
    let bucket = liveDesignIdsByProject.get(design.projectId);
    if (!bucket) {
      bucket = new Set<string>();
      liveDesignIdsByProject.set(design.projectId, bucket);
    }
    bucket.add(design.id);
  }

  const activeOutboxProjectIds = new Set<string>();
  for (const entry of projectOutbox) {
    if (entry.state === 'pending' || entry.state === 'in_flight' || entry.state === 'blocked') {
      activeOutboxProjectIds.add(entry.entityId);
    }
  }

  const metaByProjectId = new Map<string, SyncMetadata>();
  for (const meta of projectMeta) {
    metaByProjectId.set(meta.entityId, meta);
  }

  return {
    localProjects,
    isHydrated,
    hasAnyLocalEntities,
    liveDocIdsByProject,
    deletedDocIds,
    liveDesignIdsByProject,
    deletedDesignIds,
    activeOutboxProjectIds,
    metaByProjectId,
  };
}

function mapLocalProjectsToProjects(
  localProjects: LocalProject[],
  state: Awaited<ReturnType<typeof readLocalProjectState>>,
): Project[] {
  const useLocalEntityCounts = state.isHydrated || state.hasAnyLocalEntities;

  return localProjects
    .filter((p) => !p.isDeleted)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map((project) => ({
      id: project.id,
      user_id: project.userId,
      name: project.name,
      created_at: project.createdAt,
      updated_at: project.updatedAt,
      local_revision: project.localRevision ?? 1,
      document_count: useLocalEntityCounts
        ? (state.liveDocIdsByProject.get(project.id)?.size ?? 0)
        : (project.cachedDocumentCount ?? 0),
      design_count: useLocalEntityCounts
        ? (state.liveDesignIdsByProject.get(project.id)?.size ?? 0)
        : (project.cachedDesignCount ?? 0),
    }));
}

export function useProjects() {
  const auth = useAuth();
  const { user } = auth;
  const isOfflineSession = Boolean(auth.isOfflineSession || auth.reauthRequired);
  const queryClient = useQueryClient();
  const runtimeContext = useUserSyncRuntime();
  const isRuntimeReady = !runtimeContext || runtimeContext.isReady;

  const userDb = useMemo(
    () => runtimeContext?.db || getUserArtixDB(user?.id),
    [runtimeContext?.db, user?.id],
  );
  const outboxRepo = useMemo(
    () => runtimeContext?.outboxRepo || new OutboxRepository(userDb),
    [runtimeContext?.outboxRepo, userDb],
  );
  const projectRepo = useMemo(
    () => runtimeContext?.projectRepo || new ProjectRepository(userDb, outboxRepo),
    [runtimeContext?.projectRepo, userDb, outboxRepo],
  );
  const coordinator = useMemo(
    () => runtimeContext?.tabCoordinator || getTabCoordinator(user?.id),
    [runtimeContext?.tabCoordinator, user?.id],
  );

  useEffect(() => {
    const unsub = coordinator.onCrossTabChange((event) => {
      if (
        event.entityType === 'project' ||
        event.entityType === 'document' ||
        event.entityType === 'system_design'
      ) {
        queryClient.invalidateQueries({ queryKey: ['projects', user?.id] });
      }
    });
    return unsub;
  }, [coordinator, queryClient, user?.id]);

  const projectsQuery = useQuery({
    queryKey: ['projects', user?.id],
    queryFn: async (): Promise<Project[]> => {
      if (!user) return [];

      const localState = await readLocalProjectState(userDb, user.id);
      const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;

      if (localState.isHydrated || browserOffline || isOfflineSession) {
        return mapLocalProjectsToProjects(localState.localProjects, localState);
      }

      try {
        const { data: projectsData, error: projectsError } = await supabase
          .from('projects')
          .select('*')
          .eq('user_id', user.id)
          .order('updated_at', { ascending: false });

        if (projectsError || !projectsData) {
          return mapLocalProjectsToProjects(localState.localProjects, localState);
        }

        const [{ data: docCounts }, { data: designCounts }] = await Promise.all([
          supabase
            .from('documents')
            .select('id, project_id')
            .eq('user_id', user.id)
            .not('project_id', 'is', null),
          supabase
            .from('system_designs')
            .select('id, project_id')
            .eq('user_id', user.id),
        ]);

        const docCountMap: Record<string, number> = {};
        const designCountMap: Record<string, number> = {};

        const mergedDocsByProject = new Map<string, Set<string>>();
        for (const [projId, ids] of localState.liveDocIdsByProject.entries()) {
          mergedDocsByProject.set(projId, new Set(ids));
        }
        docCounts?.forEach((doc: { id?: string; project_id: string | null }) => {
          if (!doc.project_id) return;
          if (doc.id && localState.deletedDocIds.has(doc.id)) return;
          let bucket = mergedDocsByProject.get(doc.project_id);
          if (!bucket) {
            bucket = new Set<string>();
            mergedDocsByProject.set(doc.project_id, bucket);
          }
          bucket.add(doc.id ?? `cloud-doc-${bucket.size}`);
        });

        const mergedDesignsByProject = new Map<string, Set<string>>();
        for (const [projId, ids] of localState.liveDesignIdsByProject.entries()) {
          mergedDesignsByProject.set(projId, new Set(ids));
        }
        designCounts?.forEach((design: { id?: string; project_id: string }) => {
          if (!design.project_id) return;
          if (design.id && localState.deletedDesignIds.has(design.id)) return;
          let bucket = mergedDesignsByProject.get(design.project_id);
          if (!bucket) {
            bucket = new Set<string>();
            mergedDesignsByProject.set(design.project_id, bucket);
          }
          bucket.add(design.id ?? `cloud-design-${bucket.size}`);
        });

        for (const project of projectsData) {
          docCountMap[project.id] = mergedDocsByProject.get(project.id)?.size ?? 0;
          designCountMap[project.id] = mergedDesignsByProject.get(project.id)?.size ?? 0;
        }

        const remoteIds = new Set(projectsData.map((p: any) => p.id));
        const localById = new Map(localState.localProjects.map((p) => [p.id, p]));

        // Reconcile remote projects safely without clobbering active outbox entries or tombstones
        for (const remoteProj of projectsData as any[]) {
          if (localState.activeOutboxProjectIds.has(remoteProj.id)) {
            continue;
          }
          const existingLocal = localById.get(remoteProj.id);
          const existingMeta = localState.metaByProjectId.get(remoteProj.id);
          if (existingLocal?.isDeleted) {
            const baselineVer = existingMeta?.serverVersion
              ? parseInt(existingMeta.serverVersion, 10)
              : 0;
            const remoteVer =
              remoteProj.version !== undefined && remoteProj.version !== null
                ? parseInt(String(remoteProj.version), 10)
                : 0;
            if (remoteVer <= baselineVer) {
              continue;
            }
          }

          await projectRepo.applyRemoteSnapshot({
            id: remoteProj.id,
            userId: remoteProj.user_id,
            name: remoteProj.name,
            serverVersion:
              remoteProj.version !== undefined && remoteProj.version !== null
                ? String(remoteProj.version)
                : undefined,
            createdAt: remoteProj.created_at,
            updatedAt: remoteProj.updated_at,
            cachedDocumentCount: docCountMap[remoteProj.id] ?? 0,
            cachedDesignCount: designCountMap[remoteProj.id] ?? 0,
          });
        }

        // Prune previously-synced projects that were deleted remotely (never prune unpushed local creates)
        for (const localProj of localState.localProjects) {
          if (localProj.isDeleted) continue;
          if (remoteIds.has(localProj.id)) continue;
          if (localState.activeOutboxProjectIds.has(localProj.id)) continue;

          const meta = localState.metaByProjectId.get(localProj.id);
          if (meta && meta.syncState !== 'synced') continue;

          await projectRepo.delete(localProj.id, { skipOutbox: true });
        }

        const refreshedState = await readLocalProjectState(userDb, user.id);
        return mapLocalProjectsToProjects(refreshedState.localProjects, refreshedState).map(
          (proj) => ({
            ...proj,
            document_count:
              docCountMap[proj.id] !== undefined ? docCountMap[proj.id] : proj.document_count,
            design_count:
              designCountMap[proj.id] !== undefined ? designCountMap[proj.id] : proj.design_count,
          }),
        );
      } catch {
        return mapLocalProjectsToProjects(localState.localProjects, localState);
      }
    },
    enabled: !!user && isRuntimeReady,
    networkMode: 'always',
  });

  const projects = projectsQuery.data ?? [];

  const triggerSyncBestEffort = () => {
    if (
      user?.id &&
      !isOfflineSession &&
      typeof navigator !== 'undefined' &&
      navigator.onLine !== false &&
      runtimeContext?.syncEngine
    ) {
      runtimeContext.syncEngine.triggerSync(user.id).catch(() => {});
    }
  };

  const createProjectMutation = useMutation({
    networkMode: 'always',
    mutationFn: async (name: string) => {
      if (!user) throw new Error('Not authenticated');

      const created = await projectRepo.create({
        userId: user.id,
        name,
      });

      return {
        id: created.id,
        user_id: created.userId,
        name: created.name,
        created_at: created.createdAt,
        updated_at: created.updatedAt,
        local_revision: created.localRevision,
        document_count: 0,
        design_count: 0,
      } satisfies Project;
    },
    onSuccess: (newProject) => {
      queryClient.setQueryData(['projects', user?.id], (old: Project[] = []) => [
        newProject,
        ...old.filter((p) => p.id !== newProject.id),
      ]);
      coordinator.broadcastChange({
        entityType: 'project',
        entityId: newProject.id,
        operation: 'create',
        localRevision: newProject.local_revision ?? 1,
      });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['usage-counts'] });
      triggerSyncBestEffort();
    },
  });

  const updateProjectMutation = useMutation({
    networkMode: 'always',
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const updated = await projectRepo.rename(id, name);
      return {
        id: updated.id,
        user_id: updated.userId,
        name: updated.name,
        created_at: updated.createdAt,
        updated_at: updated.updatedAt,
        local_revision: updated.localRevision,
      } satisfies Project;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['projects', user?.id], (old: Project[] = []) =>
        old.map((p) =>
          p.id === updated.id
            ? {
                ...p,
                name: updated.name,
                updated_at: updated.updated_at,
                local_revision: updated.local_revision,
              }
            : p,
        ),
      );
      coordinator.broadcastChange({
        entityType: 'project',
        entityId: updated.id,
        operation: 'update',
        localRevision: updated.local_revision ?? 1,
      });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      triggerSyncBestEffort();
    },
  });

  const deleteProjectMutation = useMutation({
    networkMode: 'always',
    mutationFn: async (id: string) => {
      return await projectRepo.delete(id);
    },
    onSuccess: (localRevision, id) => {
      queryClient.setQueryData(['projects', user?.id], (old: Project[] = []) =>
        old.filter((p) => p.id !== id),
      );
      coordinator.broadcastChange({
        entityType: 'project',
        entityId: id,
        operation: 'delete',
        localRevision: localRevision ?? Date.now(),
      });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['system_designs'] });
      queryClient.invalidateQueries({ queryKey: ['workspace_folders'] });
      queryClient.invalidateQueries({ queryKey: ['recent-activity'] });
      queryClient.invalidateQueries({ queryKey: ['usage-counts'] });
      triggerSyncBestEffort();
    },
  });

  return {
    projects,
    isLoading:
      projectsQuery.isLoading || (Boolean(user) && (!isRuntimeReady || projectsQuery.isPending)),
    createProject: createProjectMutation.mutateAsync,
    updateProject: updateProjectMutation.mutateAsync,
    deleteProject: deleteProjectMutation.mutateAsync,
    isCreating: createProjectMutation.isPending,
  };
}
