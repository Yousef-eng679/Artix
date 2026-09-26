import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { WorkspaceFolder } from '@/types/workspace';
import { WorkspaceFolderRepository } from '@/lib/repositories/folderRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { getTabCoordinator } from '@/lib/sync/tabCoordinator';
import { useMemo, useEffect } from 'react';

export function useWorkspaceFolders(projectId?: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const outboxRepo = useMemo(() => new OutboxRepository(), []);
  const folderRepo = useMemo(() => new WorkspaceFolderRepository(undefined, outboxRepo), [outboxRepo]);
  const coordinator = useMemo(() => getTabCoordinator(), []);

  useEffect(() => {
    const unsub = coordinator.onCrossTabChange((event) => {
      if (event.entityType === 'workspace_folder') {
        queryClient.invalidateQueries({ queryKey: ['workspace_folders', projectId] });
      }
    });
    return unsub;
  }, [coordinator, queryClient, projectId]);

  const foldersQuery = useQuery({
    queryKey: ['workspace_folders', projectId],
    queryFn: async () => {
      if (!user || !projectId) return [];

      let remoteFolders: any[] | null = null;

      // 1. Attempt network fetch if online
      try {
        const { data, error } = await supabase
          .from('workspace_folders')
          .select('*')
          .eq('project_id', projectId)
          .eq('user_id', user.id)
          .order('name', { ascending: true });

        if (!error && data) {
          remoteFolders = data;
          // Hydrate local repository
          for (const f of data) {
            const existing = await folderRepo.getByIdIncludeDeleted(f.id);
            if (!existing) {
              await folderRepo.create({
                id: f.id,
                userId: f.user_id,
                projectId: f.project_id,
                name: f.name,
                parentFolderId: f.parent_folder_id,
              }, { skipOutbox: true });
            } else if (!existing.isDeleted && existing.name !== f.name) {
              await folderRepo.update(f.id, {
                name: f.name,
                parentFolderId: f.parent_folder_id,
              }, { skipOutbox: true });
            }
          }
        }
      } catch {
        // Offline / network failure: fall back to local IndexedDB
      }

      if (remoteFolders) {
        return remoteFolders.map((f: any) => ({
          id: f.id,
          projectId: f.project_id,
          name: f.name,
          createdAt: f.created_at,
          updatedAt: f.updated_at,
        })) as WorkspaceFolder[];
      }

      // 2. Offline fallback from local IndexedDB
      const localFolders = await folderRepo.listByProject(user.id, projectId);
      return localFolders.map((f) => ({
        id: f.id,
        projectId: f.projectId,
        name: f.name,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      })) as WorkspaceFolder[];
    },
    enabled: !!user && !!projectId,
  });

  const createFolderMutation = useMutation({
    mutationFn: async ({ name, projectId }: { name: string; projectId: string }) => {
      if (!user) throw new Error('Not authenticated');
      const trimmedName = name.trim();

      let remoteFolder: any = null;
      let remoteError: any = null;

      try {
        const { data, error } = await supabase
          .from('workspace_folders')
          .insert({ user_id: user.id, project_id: projectId, name: trimmedName })
          .select()
          .single();

        if (error) {
          remoteError = error;
        } else {
          remoteFolder = data;
        }
      } catch (err: any) {
        remoteError = err;
      }

      if (remoteError) {
        if (remoteError.code === '23505' || remoteError.message?.includes('already exists')) {
          throw new Error(`A folder named "${trimmedName}" already exists in this project`);
        }
        // If not a uniqueness error, could be offline; fall back to local persistence
      }

      if (remoteFolder) {
        // Save remote record into local repository
        const existing = await folderRepo.getByIdIncludeDeleted(remoteFolder.id);
        if (!existing) {
          await folderRepo.create({
            id: remoteFolder.id,
            userId: remoteFolder.user_id,
            projectId: remoteFolder.project_id,
            name: remoteFolder.name,
          }, { skipOutbox: true });
        }
        return {
          id: remoteFolder.id,
          projectId: remoteFolder.project_id,
          name: remoteFolder.name,
          createdAt: remoteFolder.created_at,
          updatedAt: remoteFolder.updated_at,
        } as WorkspaceFolder;
      }

      // Offline path: persist to local IndexedDB
      const localFolder = await folderRepo.create({
        userId: user.id,
        projectId,
        name: trimmedName,
      });

      return {
        id: localFolder.id,
        projectId: localFolder.projectId,
        name: localFolder.name,
        createdAt: localFolder.createdAt,
        updatedAt: localFolder.updatedAt,
      } as WorkspaceFolder;
    },
    onSuccess: (data) => {
      coordinator.broadcastChange({
        entityType: 'workspace_folder',
        entityId: data.id,
        operation: 'create',
        localRevision: 1,
      });
      queryClient.invalidateQueries({ queryKey: ['workspace_folders', projectId] });
    },
  });

  const renameFolderMutation = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const trimmedName = name.trim();

      let remoteError: any = null;
      try {
        const { error } = await supabase
          .from('workspace_folders')
          .update({ name: trimmedName })
          .eq('id', id);

        if (error) remoteError = error;
      } catch (err: any) {
        remoteError = err;
      }

      if (remoteError) {
        if (remoteError.code === '23505' || remoteError.message?.includes('already exists')) {
          throw new Error(`A folder named "${trimmedName}" already exists in this project`);
        }
      }

      // Update local IndexedDB
      const existing = await folderRepo.getById(id);
      if (existing) {
        await folderRepo.rename(id, trimmedName);
      } else if (!remoteError) {
        await folderRepo.create({
          id,
          userId: user?.id || '',
          projectId: projectId || '',
          name: trimmedName,
        });
      }
    },
    onSuccess: (_, variables) => {
      coordinator.broadcastChange({
        entityType: 'workspace_folder',
        entityId: variables.id,
        operation: 'update',
        localRevision: 2,
      });
      queryClient.invalidateQueries({ queryKey: ['workspace_folders', projectId] });
    },
  });

  const deleteFolderMutation = useMutation({
    mutationFn: async (id: string) => {
      try {
        await supabase
          .from('workspace_folders')
          .delete()
          .eq('id', id);
      } catch {
        // Offline safe
      }

      await folderRepo.delete(id);
    },
    onSuccess: (_, id) => {
      coordinator.broadcastChange({
        entityType: 'workspace_folder',
        entityId: id,
        operation: 'delete',
        localRevision: 2,
      });
      queryClient.invalidateQueries({ queryKey: ['workspace_folders', projectId] });
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
