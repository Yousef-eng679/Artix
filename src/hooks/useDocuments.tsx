import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { useUserSyncRuntime } from '@/contexts/UserSyncRuntimeContext';
import { Document } from '@/components/Editor/Editor';
import { DocumentFormat } from '@/components/Editor/languageMap';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { getTabCoordinator } from '@/lib/sync/tabCoordinator';
import { getUserArtixDB, migrateLegacyArtixDB } from '@/lib/local/db';
import { useMemo, useEffect } from 'react';

export function useDocuments(projectId?: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const runtimeContext = useUserSyncRuntime();
  const isRuntimeReady = !runtimeContext || runtimeContext.isReady;

  const userDb = useMemo(() => runtimeContext?.db || getUserArtixDB(user?.id), [runtimeContext?.db, user?.id]);
  const outboxRepo = useMemo(() => runtimeContext?.outboxRepo || new OutboxRepository(userDb), [runtimeContext?.outboxRepo, userDb]);
  const docRepo = useMemo(() => runtimeContext?.documentRepo || new DocumentRepository(userDb, outboxRepo), [runtimeContext?.documentRepo, userDb, outboxRepo]);
  const coordinator = useMemo(() => runtimeContext?.tabCoordinator || getTabCoordinator(user?.id), [runtimeContext?.tabCoordinator, user?.id]);

  useEffect(() => {
    // Only run fallback migration if not managed by runtime
    if (user?.id && !runtimeContext?.runtime) {
      migrateLegacyArtixDB(userDb, user.id).catch(() => {});
    }
  }, [userDb, user?.id, runtimeContext?.runtime]);

  useEffect(() => {
    const unsub = coordinator.onCrossTabChange((event) => {
      if (event.entityType === 'document') {
        queryClient.invalidateQueries({ queryKey: ['documents', user?.id] });
        queryClient.invalidateQueries({ queryKey: ['projects'] });
      }
    });
    return unsub;
  }, [coordinator, queryClient, user?.id]);

  const documentsQuery = useQuery({
    queryKey: ['documents', user?.id, projectId],
    queryFn: async () => {
      if (!user) return [];

      const localDocs = await docRepo.listByProject(user.id, projectId ?? null);

      return localDocs.map((doc) => ({
        id: doc.id,
        title: doc.title,
        content: doc.content,
        format: doc.format as DocumentFormat,
        updated_at: doc.updatedAt,
        project_id: doc.projectId,
        folder_id: doc.folderId,
        local_revision: doc.localRevision,
      })) as Document[];
    },
    enabled: !!user && isRuntimeReady,
    networkMode: 'always',
  });

  const createDocumentMutation = useMutation({
    networkMode: 'always',
    mutationFn: async (
      args?:
        | string
        | {
            projectId?: string;
            title?: string;
            content?: string;
            format?: DocumentFormat;
            folderId?: string | null;
          },
    ) => {
      if (!user) throw new Error('Not authenticated');

      const targetProjectId = (typeof args === 'string' ? args : args?.projectId) || projectId;
      const title = typeof args === 'string' ? 'Untitled Document' : (args?.title || 'Untitled Document');
      const content = typeof args === 'object' && args?.content !== undefined ? args.content : '';
      const format = typeof args === 'object' && args?.format ? args.format : 'markdown';
      const folderId = typeof args === 'object' ? args?.folderId : null;

      // 1. Create immediately in local IndexedDB (Local-First Authority)
      const localDoc = await docRepo.create({
        userId: user.id,
        projectId: targetProjectId || null,
        title,
        content,
        format,
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
        local_revision: localDoc.localRevision,
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
        localRevision: newDoc.local_revision ?? 1,
      });
      queryClient.invalidateQueries({ queryKey: ['documents', user?.id] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['usage-counts'] });
    },
  });

  const updateDocumentMutation = useMutation({
    networkMode: 'always',
    mutationFn: async (
      updates: Partial<Document> & {
        id: string;
        expectedUpdatedAt?: string;
        expectedLocalRevision?: number;
      },
    ) => {
      const { id, expectedUpdatedAt, expectedLocalRevision, ...rest } = updates;

      // 1. Update in local IndexedDB first (Local-First Authority)
      const existing = await docRepo.getById(id);
      let localDoc = existing;
      if (existing) {
        localDoc = await docRepo.update(
          id,
          {
            title: rest.title,
            content: rest.content,
            format: rest.format,
            folderId: rest.folder_id,
            projectId: rest.project_id,
          },
          expectedLocalRevision !== undefined ? { expectedLocalRevision } : undefined,
        );
      }

      return {
        id,
        updated_at: localDoc?.updatedAt || new Date().toISOString(),
        local_revision: localDoc?.localRevision,
        ...rest,
      };
    },
    onSuccess: (result, variables) => {
      const { expectedUpdatedAt: _eu, expectedLocalRevision: _er, ...docPatch } = variables;
      queryClient.setQueryData<Document[]>(
        ['documents', user?.id, projectId],
        (old = []) =>
          old.map((d) =>
            d.id === variables.id
              ? {
                  ...d,
                  ...docPatch,
                  updated_at: result.updated_at,
                  ...(result.local_revision !== undefined
                    ? { local_revision: result.local_revision }
                    : {}),
                }
              : d
          )
      );
      coordinator.broadcastChange({
        entityType: 'document',
        entityId: variables.id,
        operation: 'update',
        localRevision: result.local_revision ?? 2,
      });
      queryClient.invalidateQueries({ queryKey: ['documents', user?.id] });
    },
  });

  const deleteDocumentMutation = useMutation({
    networkMode: 'always',
    mutationFn: async (id: string) => {
      return await docRepo.delete(id);
    },
    onSuccess: (localRevision, id) => {
      queryClient.setQueryData<Document[]>(
        ['documents', user?.id, projectId],
        (old = []) => old.filter((d) => d.id !== id)
      );
      coordinator.broadcastChange({
        entityType: 'document',
        entityId: id,
        operation: 'delete',
        localRevision: localRevision ?? Date.now(),
      });
      queryClient.invalidateQueries({ queryKey: ['documents', user?.id] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['usage-counts'] });
    },
  });

  return {
    documents: documentsQuery.data ?? [],
    isLoading: documentsQuery.isLoading || (Boolean(user) && (!isRuntimeReady || documentsQuery.isPending)),
    isFetching: documentsQuery.isFetching,
    error: documentsQuery.error,
    createDocument: createDocumentMutation.mutateAsync,
    updateDocument: updateDocumentMutation.mutateAsync,
    deleteDocument: deleteDocumentMutation.mutateAsync,
    isCreating: createDocumentMutation.isPending,
  };
}
