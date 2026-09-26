import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { SystemDesignRepository } from '@/lib/repositories/systemDesignRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { useMemo } from 'react';

export interface BoardState {
  nodes: Array<{
    id: string;
    type: string;
    position: { x: number; y: number };
    data: { label: string; description?: string };
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
}

export function useSystemDesigns(projectId: string | undefined) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const outboxRepo = useMemo(() => new OutboxRepository(), []);
  const designRepo = useMemo(() => new SystemDesignRepository(undefined, outboxRepo), [outboxRepo]);

  const { data: designs = [], isLoading } = useQuery({
    queryKey: ['system_designs', projectId],
    queryFn: async () => {
      if (!user || !projectId) return [];

      // 1. Read from local IndexedDB first
      let localDesigns = await designRepo.listByProject(user.id, projectId);

      // 2. Try fetching from Supabase (if online) to hydrate / sync
      try {
        const { data, error } = await supabase
          .from('system_designs')
          .select('*')
          .eq('project_id', projectId)
          .eq('user_id', user.id)
          .order('updated_at', { ascending: false });

        if (!error && data) {
          for (const remote of data) {
            const existing = await designRepo.getByIdIncludeDeleted(remote.id);
            if (!existing) {
              await designRepo.create({
                id: remote.id,
                userId: remote.user_id,
                projectId: remote.project_id,
                folderId: remote.folder_id,
                name: remote.name,
                boardState: remote.board_state as unknown as BoardState,
              }, { skipOutbox: true });
            } else if (!existing.isDeleted && existing.localRevision <= 1) {
              if (new Date(remote.updated_at).getTime() > new Date(existing.updatedAt).getTime()) {
                await designRepo.update(remote.id, {
                  name: remote.name,
                  boardState: remote.board_state as unknown as BoardState,
                  folderId: remote.folder_id,
                }, { skipOutbox: true });
              }
            }
          }
          localDesigns = await designRepo.listByProject(user.id, projectId);
        }
      } catch {
        // Offline or network error: gracefully serve localDesigns from IndexedDB!
      }

      return localDesigns.map((d) => ({
        id: d.id,
        project_id: d.projectId,
        user_id: d.userId,
        name: d.name,
        board_state: d.boardState,
        created_at: d.createdAt,
        updated_at: d.updatedAt,
        folder_id: d.folderId,
      })) as SystemDesign[];
    },
    enabled: !!user && !!projectId,
  });

  const createDesignMutation = useMutation({
    mutationFn: async ({ name, projectId, folderId }: { name: string; projectId: string; folderId?: string | null }) => {
      if (!user) throw new Error('Not authenticated');

      // 1. Create immediately in local IndexedDB
      const localDesign = await designRepo.create({
        userId: user.id,
        projectId,
        name,
        boardState: { nodes: [], edges: [] },
        folderId: folderId ?? null,
      });

      // 2. Try remote Supabase insert (background / optimistic)
      try {
        await supabase
          .from('system_designs')
          .insert({
            id: localDesign.id,
            user_id: user.id,
            project_id: projectId,
            name: localDesign.name,
            board_state: localDesign.boardState,
            folder_id: localDesign.folderId,
          });
      } catch {
        // Safe to ignore network error — design is already saved locally!
      }

      return {
        id: localDesign.id,
        project_id: localDesign.projectId,
        user_id: localDesign.userId,
        name: localDesign.name,
        board_state: localDesign.boardState,
        created_at: localDesign.createdAt,
        updated_at: localDesign.updatedAt,
        folder_id: localDesign.folderId,
      } as SystemDesign;
    },
    onSuccess: (newDesign) => {
      queryClient.setQueryData<SystemDesign[]>(
        ['system_designs', projectId],
        (old = []) => [newDesign, ...old.filter((d) => d.id !== newDesign.id)]
      );
      queryClient.invalidateQueries({ queryKey: ['system_designs', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const updateDesignMutation = useMutation({
    mutationFn: async ({ id, board_state, expectedUpdatedAt, ...updates }: Partial<SystemDesign> & { id: string; expectedUpdatedAt?: string }) => {
      // 1. Update immediately in local IndexedDB
      const localDesign = await designRepo.getById(id);
      let updatedLocal = localDesign;
      if (localDesign) {
        updatedLocal = await designRepo.update(id, {
          name: updates.name,
          boardState: board_state,
          folderId: updates.folder_id,
        });
      }

      // 2. Try remote Supabase update (background / optimistic)
      const updatePayload: Record<string, unknown> = { ...updates };
      if (board_state) {
        updatePayload.board_state = JSON.parse(JSON.stringify(board_state));
      }

      if (typeof navigator === 'undefined' || navigator.onLine) {
        try {
          let query = supabase.from('system_designs').update(updatePayload).eq('id', id);
          if (expectedUpdatedAt) {
            query = query.eq('updated_at', expectedUpdatedAt);
          }
          await query.select().single();
        } catch {
          // Safe to ignore network error — design is already saved locally!
        }
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
      } as SystemDesign;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system_designs', projectId] });
    },
  });

  const deleteDesignMutation = useMutation({
    mutationFn: async (id: string) => {
      // 1. Soft-delete immediately in local IndexedDB
      await designRepo.delete(id);

      // 2. Try remote Supabase delete
      try {
        await supabase.from('system_designs').delete().eq('id', id);
      } catch {
        // Safe to ignore network error
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system_designs', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  return {
    designs,
    isLoading,
    createDesign: createDesignMutation.mutateAsync,
    updateDesign: updateDesignMutation.mutateAsync,
    deleteDesign: deleteDesignMutation.mutateAsync,
    isCreating: createDesignMutation.isPending,
  };
}
