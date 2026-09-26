import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { Document } from '@/components/Editor/Editor';
import { DocumentFormat } from '@/components/Editor/languageMap';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { getSyncEngine } from '@/lib/sync/syncEngine';
import { getTabCoordinator } from '@/lib/sync/tabCoordinator';
import { useMemo, useEffect } from 'react';

export function useDocuments(projectId?: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const outboxRepo = useMemo(() => new OutboxRepository(), []);
  const docRepo = useMemo(() => new DocumentRepository(undefined, outboxRepo), [outboxRepo]);
  const coordinator = useMemo(() => getTabCoordinator(), []);

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

      // 1. Read from local IndexedDB first (Local-First Authority)
      let localDocs = await docRepo.listByProject(user.id, projectId ?? null);

      // Self-healing: restore any orphaned documents for this user whose projectId was set to null/undefined
      if (projectId) {
        const allUserDocs = await docRepo.listAllByUser(user.id);
        const orphaned = allUserDocs.filter((d) => !d.projectId);
        if (orphaned.length > 0) {
          for (const orphan of orphaned) {
            await docRepo.update(orphan.id, { projectId });
          }
          localDocs = await docRepo.listByProject(user.id, projectId);
        }
      }

      // 2. Try fetching from Supabase (if online) to hydrate / sync
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
              await docRepo.create({
                id: remote.id,
                userId: remote.user_id,
                projectId: remote.project_id,
                folderId: remote.folder_id,
                title: remote.title,
                content: remote.content,
                format: remote.format as DocumentFormat,
              }, { skipOutbox: true });
            } else if (!existing.isDeleted && existing.localRevision <= 1) {
              if (new Date(remote.updated_at).getTime() > new Date(existing.updatedAt).getTime()) {
                await docRepo.update(remote.id, {
                  title: remote.title,
                  content: remote.content,
                  format: remote.format as DocumentFormat,
                  folderId: remote.folder_id,
                }, { skipOutbox: true });
              }
            }
          }
          localDocs = await docRepo.listByProject(user.id, projectId ?? null);
        }
      } catch {
        // Offline / network failure: gracefully serve localDocs from IndexedDB!
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
        projectId: targetProjectId ?? projectId ?? null,
        title,
        content: '',
        format: 'markdown',
        folderId: folderId ?? null,
      });

      // 2. Try remote Supabase insert (background / optimistic)
      if (typeof navigator === 'undefined' || navigator.onLine) {
        try {
          await supabase
            .from('documents')
            .insert({
              id: localDoc.id,
              user_id: user.id,
              title: localDoc.title,
              content: localDoc.content,
              format: localDoc.format,
              project_id: localDoc.projectId,
              folder_id: localDoc.folderId,
            });
        } catch {
          // Safe to ignore network error — document is already saved locally and queued in Outbox!
        }
      }

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
        const dto: {
          title?: string;
          content?: string;
          format?: DocumentFormat;
          folderId?: string | null;
          projectId?: string | null;
        } = {};
        if (rest.title !== undefined) dto.title = rest.title;
        if (rest.content !== undefined) dto.content = rest.content;
        if (rest.format !== undefined) dto.format = rest.format;
        if (rest.folder_id !== undefined) dto.folderId = rest.folder_id;
        if (rest.project_id !== undefined) dto.projectId = rest.project_id;

        localDoc = await docRepo.update(id, dto);
      }

      // 2. Sync to Supabase in the background if online
      let remoteUpdatedAt: string | undefined;
      if (typeof navigator === 'undefined' || navigator.onLine) {
        try {
          let query = supabase.from('documents').update(rest).eq('id', id);
          if (expectedUpdatedAt) {
            query = query.eq('updated_at', expectedUpdatedAt);
          }
          const { data, error } = await query.select('updated_at').single();
          if (!error && data) {
            remoteUpdatedAt = data.updated_at as string;
          }
        } catch {
          // Offline safe
        }
      }

      return {
        id,
        updated_at: remoteUpdatedAt || localDoc?.updatedAt || new Date().toISOString(),
        ...rest,
      };
    },
    onSuccess: (result, variables) => {
      const definedVariables = Object.fromEntries(
        Object.entries(variables).filter(([_, v]) => v !== undefined)
      );
      queryClient.setQueryData<Document[]>(
        ['documents', user?.id, projectId],
        (old = []) =>
          old.map((d) =>
            d.id === variables.id
              ? {
                  ...d,
                  ...definedVariables,
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
      try {
        await supabase.from('documents').delete().eq('id', id);
      } catch {
        // Offline safe
      }
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
