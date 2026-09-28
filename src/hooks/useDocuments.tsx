import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { Document } from '@/components/Editor/Editor';
import { DocumentFormat } from '@/components/Editor/languageMap';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { getSyncEngine } from '@/lib/sync/syncEngine';
import { getTabCoordinator } from '@/lib/sync/tabCoordinator';
import { getUserArtixDB, migrateLegacyArtixDB } from '@/lib/local/db';
import { useMemo, useEffect } from 'react';

export function useDocuments(projectId?: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userDb = useMemo(() => getUserArtixDB(user?.id), [user?.id]);
  const outboxRepo = useMemo(() => new OutboxRepository(userDb), [userDb]);
  const docRepo = useMemo(() => new DocumentRepository(userDb, outboxRepo), [userDb, outboxRepo]);
  const coordinator = useMemo(() => getTabCoordinator(), []);

  useEffect(() => {
    if (user?.id) {
      migrateLegacyArtixDB(userDb, user.id).catch(() => {});
    }
  }, [userDb, user?.id]);

  useEffect(() => {
    const unsub = coordinator.onCrossTabChange((event) => {
      if (event.entityType === 'document') {
        queryClient.invalidateQueries({ queryKey: ['documents', user?.id] });
      }
    });
    return unsub;
  }, [coordinator, queryClient, user?.id]);

  const documentsQuery = useQuery({
    queryKey: ['documents', user?.id, projectId],
    queryFn: async () => {
      if (!user) return [];

      // 1. Read from local IndexedDB first
      let localDocs = await docRepo.listByProject(user.id, projectId ?? null);

      // 2. Try fetching from Supabase (if online) to reconcile remote updates
      try {
        let builder = supabase
          .from('documents')
          .select('*')
          .eq('user_id', user.id);

        if (projectId) {
          builder = builder.eq('project_id', projectId);
        } else {
          builder = builder.is('project_id', null);
        }

        const { data, error } = await builder.order('updated_at', { ascending: false });
        if (!error && data) {
          for (const remote of data) {
            const existing = await docRepo.getByIdIncludeDeleted(remote.id);
            if (!existing) {
              await docRepo.applyRemoteSnapshot({
                id: remote.id,
                userId: remote.user_id,
                projectId: remote.project_id,
                folderId: remote.folder_id,
                title: remote.title,
                content: remote.content,
                format: remote.format as DocumentFormat,
                updatedAt: remote.updated_at,
                createdAt: remote.created_at,
              });
            } else if (!existing.isDeleted && existing.localRevision <= 1) {
              if (new Date(remote.updated_at).getTime() > new Date(existing.updatedAt).getTime()) {
                await docRepo.applyRemoteSnapshot({
                  id: remote.id,
                  userId: remote.user_id,
                  projectId: remote.project_id,
                  folderId: remote.folder_id,
                  title: remote.title,
                  content: remote.content,
                  format: remote.format as DocumentFormat,
                  updatedAt: remote.updated_at,
                  createdAt: remote.created_at,
                });
              }
            }
          }
          // Re-query local IndexedDB after remote reconciliation
          localDocs = await docRepo.listByProject(user.id, projectId ?? null);
        }
      } catch {
        // Offline or network error: gracefully serve localDocs from IndexedDB!
      }

      return localDocs.map((doc) => ({
        id: doc.id,
        title: doc.title,
        content: doc.content,
        format: doc.format as DocumentFormat,
        updated_at: doc.updatedAt,
        project_id: doc.projectId,
        folder_id: doc.folderId,
      })) as Document[];
    },
    enabled: !!user,
  });

  const createDocumentMutation = useMutation({
    mutationFn: async (args?: string | { projectId?: string; title?: string; folderId?: string | null }) => {
      if (!user) throw new Error('Not authenticated');

      const targetProjectId = typeof args === 'string' ? args : args?.projectId;
      const title = typeof args === 'string' ? 'Untitled Document' : (args?.title || 'Untitled Document');
      const folderId = typeof args === 'object' ? args?.folderId : null;

      // 1. Create immediately in local IndexedDB (Local-First Authority)
      const localDoc = await docRepo.create({
        userId: user.id,
        projectId: targetProjectId || null,
        title,
        content: '',
        format: 'markdown',
        folderId: folderId ?? null,
      });

      return {
        id: localDoc.id,
        title: localDoc.title,
        content: localDoc.content,
        format: localDoc.format,
        updated_at: localDoc.updatedAt,
        project_id: localDoc.projectId,
        folder_id: localDoc.folderId,
      } as Document;
    },
    onSuccess: (newDoc) => {
      queryClient.setQueryData<Document[]>(
        ['documents', user?.id, projectId],
        (old = []) => [newDoc, ...old.filter((d) => d.id !== newDoc.id)]
      );
      coordinator.broadcastChange({
        entityType: 'document',
        entityId: newDoc.id,
        operation: 'create',
        localRevision: 1,
      });
      queryClient.invalidateQueries({ queryKey: ['documents', user?.id] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const updateDocumentMutation = useMutation({
    mutationFn: async (updates: Partial<Document> & { id: string; expectedUpdatedAt?: string }) => {
      const { id, expectedUpdatedAt, ...rest } = updates;

      // 1. Update in local IndexedDB first (Local-First Authority)
      const existing = await docRepo.getById(id);
      let localDoc = existing;
      if (existing) {
        localDoc = await docRepo.update(id, {
          title: rest.title,
          content: rest.content,
          format: rest.format,
          folderId: rest.folder_id,
          projectId: rest.project_id,
        });
      }

      return {
        id,
        updated_at: localDoc?.updatedAt || new Date().toISOString(),
        ...rest,
      };
    },
    onSuccess: (result, variables) => {
      queryClient.setQueryData<Document[]>(
        ['documents', user?.id, projectId],
        (old = []) =>
          old.map((d) =>
            d.id === variables.id
              ? {
                  ...d,
                  ...variables,
                  updated_at: result.updated_at,
                }
              : d
          )
      );
      coordinator.broadcastChange({
        entityType: 'document',
        entityId: variables.id,
        operation: 'update',
        localRevision: 2,
      });
      queryClient.invalidateQueries({ queryKey: ['documents', user?.id] });
    },
  });

  const deleteDocumentMutation = useMutation({
    mutationFn: async (id: string) => {
      await docRepo.delete(id);
    },
    onSuccess: (_, id) => {
      queryClient.setQueryData<Document[]>(
        ['documents', user?.id, projectId],
        (old = []) => old.filter((d) => d.id !== id)
      );
      coordinator.broadcastChange({
        entityType: 'document',
        entityId: id,
        operation: 'delete',
        localRevision: 2,
      });
      queryClient.invalidateQueries({ queryKey: ['documents', user?.id] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  return {
    documents: documentsQuery.data ?? [],
    isLoading: documentsQuery.isLoading,
    error: documentsQuery.error,
    createDocument: createDocumentMutation.mutateAsync,
    updateDocument: updateDocumentMutation.mutateAsync,
    deleteDocument: deleteDocumentMutation.mutateAsync,
    isCreating: createDocumentMutation.isPending,
  };
}
