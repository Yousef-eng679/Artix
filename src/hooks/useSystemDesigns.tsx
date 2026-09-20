import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';

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
}

export function useSystemDesigns(projectId: string | undefined) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: designs = [], isLoading } = useQuery({
    queryKey: ['system_designs', projectId],
    queryFn: async () => {
      if (!user || !projectId) return [];
      
      const { data, error } = await supabase
        .from('system_designs')
        .select('*')
        .eq('project_id', projectId)
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false });
      
      if (error) throw error;
      return data.map((d) => ({
        ...d,
        board_state: d.board_state as unknown as BoardState,
      })) as SystemDesign[];
    },
    enabled: !!user && !!projectId,
  });

  const createDesignMutation = useMutation({
    mutationFn: async ({ name, projectId }: { name: string; projectId: string }) => {
      if (!user) throw new Error('Not authenticated');
      
      const { data, error } = await supabase
        .from('system_designs')
        .insert({
          user_id: user.id,
          project_id: projectId,
          name,
          board_state: JSON.parse(JSON.stringify({ nodes: [], edges: [] })),
        })
        .select()
        .single();
      
      if (error) throw error;
      return {
        ...data,
        board_state: data.board_state as unknown as BoardState,
      } as SystemDesign;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system_designs', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const updateDesignMutation = useMutation({
    mutationFn: async ({ id, board_state, expectedUpdatedAt, ...updates }: Partial<SystemDesign> & { id: string; expectedUpdatedAt?: string }) => {
      const updatePayload: Record<string, unknown> = { ...updates };
      if (board_state) {
        updatePayload.board_state = JSON.parse(JSON.stringify(board_state));
      }
      
      let query = supabase
        .from('system_designs')
        .update(updatePayload)
        .eq('id', id);

      if (expectedUpdatedAt) {
        query = query.eq('updated_at', expectedUpdatedAt);
      }

      const { data, error } = await query
        .select()
        .single();
      
      if (error) throw error;
      return {
        ...data,
        board_state: data.board_state as unknown as BoardState,
      } as SystemDesign;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system_designs', projectId] });
    },
  });

  const deleteDesignMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('system_designs')
        .delete()
        .eq('id', id);
      
      if (error) throw error;
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
