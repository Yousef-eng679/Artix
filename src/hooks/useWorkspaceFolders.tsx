import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { useUserSyncRuntime } from '@/contexts/UserSyncRuntimeContext';
import { WorkspaceFolder } from '@/types/workspace';
import { WorkspaceFolderRepository } from '@/lib/repositories/folderRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { getTabCoordinator } from '@/lib/sync/tabCoordinator';
import { getUserArtixDB, migrateLegacyArtixDB } from '@/lib/local/db';
import { useMemo, useEffect } from 'react';

export function useWorkspaceFolders(projectId?: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const runtimeContext = useUserSyncRuntime();

  const userDb = useMemo(() => runtimeContext?.db || getUserArtixDB(user?.id), [runtimeContext?.db, user?.id]);
  const outboxRepo = useMemo(() => runtimeContext?.outboxRepo || new OutboxRepository(userDb), [runtimeContext?.outboxRepo, userDb]);
  const folderRepo = useMemo(() => runtimeContext?.folderRepo || new WorkspaceFolderRepository(userDb, outboxRepo), [runtimeContext?.folderRepo, userDb, outboxRepo]);
  const coordinator = useMemo(() => runtimeContext?.tabCoordinator || getTabCoordinator(user?.id), [runtimeContext?.tabCoordinator, user?.id]);

  useEffect(() => {
    // Only run fallback migration if not managed by runtime
    if (user?.id && !runtimeContext?.runtime) {
      migrateLegacyArtixDB(userDb, user.id).catch(() => {});
    }
  }, [userDb, user?.id, runtimeContext?.runtime]);

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

      // Check for duplicate folder name locally
      const existingFolders = await folderRepo.listByProject(user.id, projectId);
      const isDuplicate = existingFolders.some(
        (f) => f.name.toLowerCase() === trimmedName.toLowerCase()
      );
      if (isDuplicate) {
        throw new Error(`A folder named "${trimmedName}" already exists in this project`);
      }

      // 1. Create immediately in local IndexedDB (Local-First Authority)
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
    onSuccess: (newFolder) => {
      queryClient.setQueryData<WorkspaceFolder[]>(
        ['workspace_folders', projectId],
        (old = []) => [...old.filter((f) => f.id !== newFolder.id), newFolder].sort((a, b) =>
          a.name.localeCompare(b.name)
        )
      );
      coordinator.broadcastChange({
        entityType: 'workspace_folder',
        entityId: newFolder.id,
        operation: 'create',
        localRevision: 1,
      });
      queryClient.invalidateQueries({ queryKey: ['workspace_folders', projectId] });
    },
  });

  const renameFolderMutation = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const trimmedName = name.trim();

      // Check for duplicate folder name locally
      if (projectId && user) {
        const existingFolders = await folderRepo.listByProject(user.id, projectId);
        const isDuplicate = existingFolders.some(
          (f) => f.id !== id && f.name.toLowerCase() === trimmedName.toLowerCase()
        );
        if (isDuplicate) {
          throw new Error(`A folder named "${trimmedName}" already exists in this project`);
        }
      }

      // Update local IndexedDB
      await folderRepo.rename(id, trimmedName);
      return { id, name: trimmedName };
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<WorkspaceFolder[]>(
        ['workspace_folders', projectId],
        (old = []) =>
          old.map((f) => (f.id === updated.id ? { ...f, name: updated.name } : f)).sort((a, b) =>
            a.name.localeCompare(b.name)
          )
      );
      coordinator.broadcastChange({
        entityType: 'workspace_folder',
        entityId: updated.id,
        operation: 'update',
        localRevision: 2,
      });
      queryClient.invalidateQueries({ queryKey: ['workspace_folders', projectId] });
    },
  });

  const deleteFolderMutation = useMutation({
    mutationFn: async (id: string) => {
      await folderRepo.delete(id);
    },
    onSuccess: (_, id) => {
      queryClient.setQueryData<WorkspaceFolder[]>(
        ['workspace_folders', projectId],
        (old = []) => old.filter((f) => f.id !== id)
      );
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
