import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { useUserSyncRuntime } from '@/contexts/UserSyncRuntimeContext';
import { ArtixDB, getUserArtixDB } from '@/lib/local/db';
import { LocalProject } from '@/lib/local/types';

export interface Project {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  document_count?: number;
  design_count?: number;
}

const OFFLINE_PROJECT_MUTATION_ERROR =
  'Connect to the internet to create, rename, or delete projects.';

async function readLocalProjectState(db: ArtixDB, userId: string) {
  const [localProjects, localDocs, localDesigns, hydrationMeta] = await Promise.all([
    db.projects.where('userId').equals(userId).toArray().catch(() => [] as LocalProject[]),
    db.documents.where('userId').equals(userId).toArray().catch(() => []),
    db.system_designs.where('userId').equals(userId).toArray().catch(() => []),
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

  return {
    localProjects,
    isHydrated,
    hasAnyLocalEntities,
    liveDocIdsByProject,
    deletedDocIds,
    liveDesignIdsByProject,
    deletedDesignIds,
  };
}

function mapLocalProjectsToProjects(
  localProjects: LocalProject[],
  state: Awaited<ReturnType<typeof readLocalProjectState>>,
): Project[] {
  const useLocalEntityCounts = state.isHydrated || state.hasAnyLocalEntities;

  return [...localProjects]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map((project) => ({
      id: project.id,
      user_id: project.userId,
      name: project.name,
      created_at: project.createdAt,
      updated_at: project.updatedAt,
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

  const projectsQuery = useQuery({
    queryKey: ['projects', user?.id],
    queryFn: async (): Promise<Project[]> => {
      if (!user) return [];

      const localState = await readLocalProjectState(userDb, user.id);
      const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;

      if (browserOffline || isOfflineSession) {
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

        const docCountMap: Record<string, number> = {};
        const designCountMap: Record<string, number> = {};

        if (localState.isHydrated) {
          for (const project of projectsData) {
            docCountMap[project.id] = localState.liveDocIdsByProject.get(project.id)?.size ?? 0;
            designCountMap[project.id] = localState.liveDesignIdsByProject.get(project.id)?.size ?? 0;
          }
        } else {
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
        }

        const remoteIds = new Set(projectsData.map((p) => p.id));
        const snapshotToCache: LocalProject[] = projectsData.map((p) => ({
          id: p.id,
          userId: p.user_id,
          name: p.name,
          createdAt: p.created_at,
          updatedAt: p.updated_at,
          cachedDocumentCount: docCountMap[p.id] ?? 0,
          cachedDesignCount: designCountMap[p.id] ?? 0,
        }));

        await userDb
          .transaction('rw', userDb.projects, async () => {
            const existing = await userDb.projects.where('userId').equals(user.id).toArray();
            const staleIds = existing.filter((p) => !remoteIds.has(p.id)).map((p) => p.id);
            if (staleIds.length > 0) {
              await userDb.projects.bulkDelete(staleIds);
            }
            if (snapshotToCache.length > 0) {
              await userDb.projects.bulkPut(snapshotToCache);
            }
          })
          .catch(() => {});

        return projectsData.map((project) => ({
          ...project,
          document_count: docCountMap[project.id] || 0,
          design_count: designCountMap[project.id] || 0,
        })) as Project[];
      } catch {
        return mapLocalProjectsToProjects(localState.localProjects, localState);
      }
    },
    enabled: !!user && isRuntimeReady,
    networkMode: 'always',
  });

  const projects = projectsQuery.data ?? [];

  const assertOnlineForProjectMutation = () => {
    if ((typeof navigator !== 'undefined' && !navigator.onLine) || isOfflineSession) {
      throw new Error(OFFLINE_PROJECT_MUTATION_ERROR);
    }
  };

  const createProjectMutation = useMutation({
    networkMode: 'always',
    mutationFn: async (name: string) => {
      if (!user) throw new Error('Not authenticated');
      assertOnlineForProjectMutation();

      const trimmedName = name.trim();
      const duplicate = projects.some(
        (p) => p.name.trim().toLowerCase() === trimmedName.toLowerCase(),
      );
      if (duplicate) {
        throw new Error(`A project named "${trimmedName}" already exists.`);
      }

      const { data, error } = await supabase
        .from('projects')
        .insert({ user_id: user.id, name: trimmedName })
        .select()
        .single();

      if (error) throw error;
      const created = data as Project;
      await userDb.projects
        .put({
          id: created.id,
          userId: created.user_id,
          name: created.name,
          createdAt: created.created_at,
          updatedAt: created.updated_at,
          cachedDocumentCount: 0,
          cachedDesignCount: 0,
        })
        .catch(() => {});
      return created;
    },
    onSuccess: (newProject) => {
      queryClient.setQueryData(['projects', user?.id], (old: Project[] = []) => [
        { ...newProject, document_count: 0, design_count: 0 },
        ...old.filter((p) => p.id !== newProject.id),
      ]);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const updateProjectMutation = useMutation({
    networkMode: 'always',
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      assertOnlineForProjectMutation();

      const trimmedName = name.trim();
      const duplicate = projects.some(
        (p) => p.id !== id && p.name.trim().toLowerCase() === trimmedName.toLowerCase(),
      );
      if (duplicate) {
        throw new Error(`A project named "${trimmedName}" already exists.`);
      }

      const { data, error } = await supabase
        .from('projects')
        .update({ name: trimmedName })
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      const updated = data as Project;
      await userDb.projects
        .put({
          id: updated.id,
          userId: updated.user_id,
          name: updated.name,
          createdAt: updated.created_at,
          updatedAt: updated.updated_at,
        })
        .catch(() => {});
      return updated;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const deleteProjectMutation = useMutation({
    networkMode: 'always',
    mutationFn: async (id: string) => {
      assertOnlineForProjectMutation();

      const { error } = await supabase.from('projects').delete().eq('id', id);

      if (error) throw error;
      await userDb.projects.delete(id).catch(() => {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
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
