import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { Document } from '@/components/Editor/Editor';
import { DocumentFormat } from '@/components/Editor/languageMap';

export function useDocuments(projectId?: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const documentsQuery = useQuery({
    queryKey: ['documents', user?.id, projectId],
    queryFn: async () => {
      if (!user) return [];
      
      let query = supabase
        .from('documents')
        .select('*')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false });
      
      if (projectId) {
        query = query.eq('project_id', projectId);
      } else {
        query = query.is('project_id', null);
      }

      const { data, error } = await query;

      if (error) throw error;
      
      return data.map((doc) => ({
        id: doc.id,
        title: doc.title,
        content: doc.content,
        format: doc.format as DocumentFormat,
        updated_at: doc.updated_at,
        project_id: doc.project_id,
      })) as Document[];
    },
    enabled: !!user,
  });

  const createDocumentMutation = useMutation({
    mutationFn: async (args?: string | { projectId?: string; title?: string }) => {
      if (!user) throw new Error('Not authenticated');
      
      const projectId = typeof args === 'string' ? args : args?.projectId;
      const title = typeof args === 'string' ? 'Untitled Document' : (args?.title || 'Untitled Document');
      
      const { data, error } = await supabase
        .from('documents')
        .insert({
          user_id: user.id,
          title,
          content: '',
          format: 'markdown',
          project_id: projectId || null,
        })
        .select()
        .single();

      if (error) throw error;
      return {
        id: data.id,
        title: data.title,
        content: data.content,
        format: data.format as DocumentFormat,
        updated_at: data.updated_at,
        project_id: data.project_id,
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
      
      let query = supabase
        .from('documents')
        .update(rest)
        .eq('id', id);

      if (expectedUpdatedAt) {
        query = query.eq('updated_at', expectedUpdatedAt);
      }

      const { data, error } = await query
        .select('updated_at')
        .single();

      if (error) throw error;
      return { updated_at: data.updated_at as string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents', user?.id] });
    },
  });

  const deleteDocumentMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('documents')
        .delete()
        .eq('id', id);

      if (error) throw error;
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
