import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { WorkspaceFolder } from '@/types/workspace';

export function useWorkspaceFolders(projectId?: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const foldersQuery = useQuery({
    queryKey: ['workspace_folders', projectId],
    queryFn: async () => {
      if (!user || !projectId) return [];
      const { data, error } = await supabase
        .from('workspace_folders')
        .select('*')
        .eq('project_id', projectId)
        .eq('user_id', user.id)
        .order('name', { ascending: true });
      if (error) throw error;
      return (data || []).map((f) => ({
        id: f.id,
        projectId: f.project_id,
        name: f.name,
        createdAt: f.created_at,
        updatedAt: f.updated_at,
      })) as WorkspaceFolder[];
    },
    enabled: !!user && !!projectId,
  });

  const createFolderMutation = useMutation({
    mutationFn: async ({ name, projectId }: { name: string; projectId: string }) => {
      if (!user) throw new Error('Not authenticated');
      const trimmedName = name.trim();
      const { data, error } = await supabase
        .from('workspace_folders')
        .insert({ user_id: user.id, project_id: projectId, name: trimmedName })
        .select()
        .single();
      if (error) {
        if (error.code === '23505') {
          throw new Error(`A folder named "${trimmedName}" already exists in this project`);
        }
        throw error;
      }
      return {
        id: data.id,
        projectId: data.project_id,
        name: data.name,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      } as WorkspaceFolder;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace_folders', projectId] });
    },
  });

  const renameFolderMutation = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const trimmedName = name.trim();
      const { error } = await supabase
        .from('workspace_folders')
        .update({ name: trimmedName })
        .eq('id', id);
      if (error) {
        if (error.code === '23505') {
          throw new Error(`A folder named "${trimmedName}" already exists in this project`);
        }
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace_folders', projectId] });
    },
  });

  const deleteFolderMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('workspace_folders')
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace_folders', projectId] });
      // Contained resources fall to root via DB composite FK ON DELETE SET NULL
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['system_designs', projectId] });
    },
  });

  return {
    folders: foldersQuery.data ?? [],
    isLoading: foldersQuery.isLoading,
    createFolder: createFolderMutation.mutateAsync,
    renameFolder: renameFolderMutation.mutateAsync,
    deleteFolder: deleteFolderMutation.mutateAsync,
    isCreatingFolder: createFolderMutation.isPending,
  };
}
