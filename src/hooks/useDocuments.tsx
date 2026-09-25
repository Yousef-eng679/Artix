import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { Document } from '@/components/Editor/Editor';
import { DocumentFormat } from '@/components/Editor/languageMap';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { useMemo } from 'react';

export function useDocuments(projectId?: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const docRepo = useMemo(() => new DocumentRepository(), []);

  const documentsQuery = useQuery({
    queryKey: ['documents', user?.id, projectId],
    queryFn: async () => {
      if (!user) return [];

      let remoteDocs: any[] | null = null;
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
          remoteDocs = data;
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
              });
            } else if (!existing.isDeleted && existing.localRevision <= 1) {
              if (new Date(remote.updated_at).getTime() > new Date(existing.updatedAt).getTime()) {
                await docRepo.update(remote.id, {
                  title: remote.title,
                  content: remote.content,
                  format: remote.format as DocumentFormat,
                  folderId: remote.folder_id,
                });
              }
            }
          }
        }
      } catch {
        // Offline / network failure
      }

      if (remoteDocs) {
        return remoteDocs.map((doc) => ({
          id: doc.id,
          title: doc.title,
          content: doc.content,
          format: doc.format as DocumentFormat,
          updated_at: doc.updated_at,
          project_id: doc.project_id,
          folder_id: doc.folder_id,
        })) as Document[];
      }

      const localDocs = await docRepo.listByProject(user.id, projectId ?? null);
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

      let remoteDoc: any = null;
      let remoteError: any = null;
      try {
        const { data, error } = await supabase
          .from('documents')
          .insert({
            user_id: user.id,
            title,
            content: '',
            format: 'markdown',
            project_id: targetProjectId || null,
            folder_id: folderId ?? null,
          })
          .select()
          .single();

        if (error) {
          remoteError = error;
        } else {
          remoteDoc = data;
        }
      } catch (err) {
        remoteError = err;
      }

      if (remoteDoc) {
        const existing = await docRepo.getByIdIncludeDeleted(remoteDoc.id);
        if (!existing) {
          await docRepo.create({
            id: remoteDoc.id,
            userId: remoteDoc.user_id,
            projectId: remoteDoc.project_id,
            folderId: remoteDoc.folder_id,
            title: remoteDoc.title,
            content: remoteDoc.content,
            format: remoteDoc.format as DocumentFormat,
          });
        }
        return {
          id: remoteDoc.id,
          title: remoteDoc.title,
          content: remoteDoc.content,
          format: remoteDoc.format as DocumentFormat,
          updated_at: remoteDoc.updated_at,
          project_id: remoteDoc.project_id,
          folder_id: remoteDoc.folder_id,
        } as Document;
      }

      // Offline path: persist to local IndexedDB
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

      return { updated_at: remoteUpdatedAt || localDoc?.updatedAt || new Date().toISOString() };
    },
    onSuccess: () => {
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
    onSuccess: () => {
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
