import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { useUserSyncRuntime } from '@/contexts/UserSyncRuntimeContext';
import { SystemDesignRepository } from '@/lib/repositories/systemDesignRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { getTabCoordinator } from '@/lib/sync/tabCoordinator';
import { getUserArtixDB, migrateLegacyArtixDB } from '@/lib/local/db';
import { useMemo, useEffect } from 'react';

export interface BoardState {
  nodes: Array<{
    id: string;
    type: string;
    position: { x: number; y: number };
    data: { label: string; description?: string; color?: string };
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    label?: string;
  }>;
  strokes?: Array<{
    points: { x: number; y: number }[];
    color: string;
    width: number;
  }>;
}

export interface SystemDesign {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  board_state: BoardState;
  created_at: string;
  updated_at: string;
  folder_id?: string | null;
  local_revision?: number;
}

export function useSystemDesigns(projectId: string | undefined) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const runtimeContext = useUserSyncRuntime();
  const isRuntimeReady = !runtimeContext || runtimeContext.isReady;

  const userDb = useMemo(() => runtimeContext?.db || getUserArtixDB(user?.id), [runtimeContext?.db, user?.id]);
  const outboxRepo = useMemo(() => runtimeContext?.outboxRepo || new OutboxRepository(userDb), [runtimeContext?.outboxRepo, userDb]);
  const designRepo = useMemo(() => runtimeContext?.systemDesignRepo || new SystemDesignRepository(userDb, outboxRepo), [runtimeContext?.systemDesignRepo, userDb, outboxRepo]);
  const coordinator = useMemo(() => runtimeContext?.tabCoordinator || getTabCoordinator(user?.id), [runtimeContext?.tabCoordinator, user?.id]);

  useEffect(() => {
    // Only run fallback migration if not managed by runtime
    if (user?.id && !runtimeContext?.runtime) {
      migrateLegacyArtixDB(userDb, user.id).catch(() => {});
    }
  }, [userDb, user?.id, runtimeContext?.runtime]);

  useEffect(() => {
    const unsub = coordinator.onCrossTabChange((event) => {
      if (event.entityType === 'system_design') {
        queryClient.invalidateQueries({ queryKey: ['system_designs'] });
        queryClient.invalidateQueries({ queryKey: ['projects'] });
      }
    });
    return unsub;
  }, [coordinator, queryClient]);

  const designsQuery = useQuery({
    queryKey: ['system_designs', projectId],
    queryFn: async () => {
      if (!user || !projectId) return [];

      const localDesigns = await designRepo.listByProject(user.id, projectId);

      return localDesigns.map((d) => ({
        id: d.id,
        project_id: d.projectId,
        user_id: d.userId,
        name: d.name,
        board_state: d.boardState,
        created_at: d.createdAt,
        updated_at: d.updatedAt,
        folder_id: d.folderId,
        local_revision: d.localRevision,
      })) as SystemDesign[];
    },
    enabled: !!user && !!projectId && isRuntimeReady,
    networkMode: 'always',
  });

  const createDesignMutation = useMutation({
    networkMode: 'always',
    mutationFn: async ({
      name,
      projectId,
      folderId,
      boardState,
    }: {
      name: string;
      projectId: string;
      folderId?: string | null;
      boardState?: BoardState;
    }) => {
      if (!user) throw new Error('Not authenticated');

      // 1. Create immediately in local IndexedDB + Outbox (Local-First Authority)
      const localDesign = await designRepo.create({
        userId: user.id,
        projectId,
        name,
        boardState: boardState || { nodes: [], edges: [] },
        folderId: folderId ?? null,
      });

      return {
        id: localDesign.id,
        project_id: localDesign.projectId,
        user_id: localDesign.userId,
        name: localDesign.name,
        board_state: localDesign.boardState,
        created_at: localDesign.createdAt,
        updated_at: localDesign.updatedAt,
        folder_id: localDesign.folderId,
        local_revision: localDesign.localRevision,
      } as SystemDesign;
    },
    onSuccess: (newDesign) => {
      queryClient.setQueryData<SystemDesign[]>(
        ['system_designs', projectId],
        (old = []) => [newDesign, ...old.filter((d) => d.id !== newDesign.id)]
      );
      coordinator.broadcastChange({
        entityType: 'system_design',
        entityId: newDesign.id,
        operation: 'create',
        localRevision: newDesign.local_revision ?? 1,
      });
      queryClient.invalidateQueries({ queryKey: ['system_designs', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['usage-counts'] });
    },
  });

  const updateDesignMutation = useMutation({
    networkMode: 'always',
    mutationFn: async ({
      id,
      board_state,
      expectedUpdatedAt,
      expectedLocalRevision,
      ...updates
    }: Partial<SystemDesign> & {
      id: string;
      expectedUpdatedAt?: string;
      expectedLocalRevision?: number;
    }) => {
      // 1. Update immediately in local IndexedDB + Outbox (Local-First Authority)
      const localDesign = await designRepo.getById(id);
      let updatedLocal = localDesign;
      if (localDesign) {
        updatedLocal = await designRepo.update(
          id,
          {
            name: updates.name,
            boardState: board_state,
            folderId: updates.folder_id,
          },
          expectedLocalRevision !== undefined ? { expectedLocalRevision } : undefined,
        );
      }

      return {
        id,
        project_id: updatedLocal?.projectId || projectId || '',
        user_id: updatedLocal?.userId || user?.id || '',
        name: updatedLocal?.name || updates.name || '',
        board_state: updatedLocal?.boardState || board_state || { nodes: [], edges: [] },
        created_at: updatedLocal?.createdAt || new Date().toISOString(),
        updated_at: updatedLocal?.updatedAt || new Date().toISOString(),
        folder_id: updatedLocal?.folderId ?? updates.folder_id ?? null,
        local_revision: updatedLocal?.localRevision,
      } as SystemDesign;
    },
    onSuccess: (updatedDesign, variables) => {
      queryClient.setQueryData<SystemDesign[]>(
        ['system_designs', projectId],
        (old = []) =>
          old.map((d) =>
            d.id === variables.id
              ? {
                  ...d,
                  ...updatedDesign,
                }
              : d
          )
      );
      coordinator.broadcastChange({
        entityType: 'system_design',
        entityId: variables.id,
        operation: 'update',
        localRevision: updatedDesign.local_revision ?? 2,
      });
      queryClient.invalidateQueries({ queryKey: ['system_designs', projectId] });
    },
  });

  const deleteDesignMutation = useMutation({
    networkMode: 'always',
    mutationFn: async (id: string) => {
      // 1. Soft-delete immediately in local IndexedDB + Outbox (Local-First Authority)
      return await designRepo.delete(id);
    },
    onSuccess: (localRevision, id) => {
      queryClient.setQueryData<SystemDesign[]>(
        ['system_designs', projectId],
        (old = []) => old.filter((d) => d.id !== id)
      );
      coordinator.broadcastChange({
        entityType: 'system_design',
        entityId: id,
        operation: 'delete',
        localRevision: localRevision ?? Date.now(),
      });
      queryClient.invalidateQueries({ queryKey: ['system_designs', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['usage-counts'] });
    },
  });

  return {
    designs: designsQuery.data ?? [],
    isLoading: designsQuery.isLoading || (Boolean(user) && Boolean(projectId) && (!isRuntimeReady || designsQuery.isPending)),
    createDesign: createDesignMutation.mutateAsync,
    updateDesign: updateDesignMutation.mutateAsync,
    deleteDesign: deleteDesignMutation.mutateAsync,
    isCreating: createDesignMutation.isPending,
  };
}
