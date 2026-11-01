import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { useUserSyncRuntime } from '@/contexts/UserSyncRuntimeContext';
import { getUserArtixDB } from '@/lib/local/db';
import { getTabCoordinator } from '@/lib/sync/tabCoordinator';

export interface RecentItem {
  id: string;
  title: string;
  kind: 'document' | 'design';
  project_id: string | null;
  updated_at: string;
}

export function useRecentActivity(limit = 4) {
  const auth = useAuth();
  const { user } = auth;
  const isOfflineSession = Boolean(auth.isOfflineSession || auth.reauthRequired);
  const queryClient = useQueryClient();
  const runtimeContext = useUserSyncRuntime();
  const isRuntimeReady = !runtimeContext || runtimeContext.isReady;

  const userDb = useMemo(
    () => runtimeContext?.db || getUserArtixDB(user?.id),
    [runtimeContext?.db, user?.id],
  );
  const coordinator = useMemo(
    () => runtimeContext?.tabCoordinator || getTabCoordinator(user?.id),
    [runtimeContext?.tabCoordinator, user?.id],
  );

  useEffect(() => {
    const unsub = coordinator.onCrossTabChange((event) => {
      if (event.entityType === 'document' || event.entityType === 'system_design') {
        queryClient.invalidateQueries({ queryKey: ['recent-activity', user?.id] });
      }
    });
    return unsub;
  }, [coordinator, queryClient, user?.id]);

  return useQuery({
    queryKey: ['recent-activity', user?.id, limit],
    queryFn: async (): Promise<RecentItem[]> => {
      if (!user) return [];

      const [localDocs, localDesigns, hydrationMeta] = await Promise.all([
        userDb.documents.where('userId').equals(user.id).toArray().catch(() => []),
        userDb.system_designs.where('userId').equals(user.id).toArray().catch(() => []),
        userDb.database_meta.get('hydration_complete').catch(() => undefined),
      ]);

      const isHydrated = Boolean(hydrationMeta?.value);
      const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;

      const buildFromLocalOnly = (): RecentItem[] => {
        const localItems: RecentItem[] = [
          ...localDocs
            .filter((d) => !d.isDeleted)
            .map((d) => ({
              id: d.id,
              title: d.title || 'Untitled Document',
              kind: 'document' as const,
              project_id: d.projectId,
              updated_at: d.updatedAt,
            })),
          ...localDesigns
            .filter((d) => !d.isDeleted)
            .map((d) => ({
              id: d.id,
              title: d.name || 'Untitled Canvas',
              kind: 'design' as const,
              project_id: d.projectId,
              updated_at: d.updatedAt,
            })),
        ];

        return localItems
          .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
          .slice(0, limit);
      };

      if (isHydrated || browserOffline || isOfflineSession) {
        return buildFromLocalOnly();
      }

      try {
        const [docsRes, designsRes] = await Promise.all([
          supabase
            .from('documents')
            .select('id, title, project_id, updated_at')
            .eq('user_id', user.id)
            .order('updated_at', { ascending: false })
            .limit(limit),
          supabase
            .from('system_designs')
            .select('id, name, project_id, updated_at')
            .eq('user_id', user.id)
            .order('updated_at', { ascending: false })
            .limit(limit),
        ]);

        if (docsRes.error && designsRes.error) {
          return buildFromLocalOnly();
        }

        const docById = new Map(localDocs.map((d) => [d.id, d]));
        const designById = new Map(localDesigns.map((d) => [d.id, d]));

        const mergedMap = new Map<string, RecentItem>();

        for (const d of localDocs) {
          if (!d.isDeleted) {
            mergedMap.set(`document:${d.id}`, {
              id: d.id,
              title: d.title || 'Untitled Document',
              kind: 'document',
              project_id: d.projectId,
              updated_at: d.updatedAt,
            });
          }
        }
        for (const d of docsRes.data ?? []) {
          const localRow = docById.get(d.id);
          if (localRow?.isDeleted) continue;
          if (!localRow) {
            mergedMap.set(`document:${d.id}`, {
              id: d.id,
              title: d.title || 'Untitled Document',
              kind: 'document',
              project_id: d.project_id,
              updated_at: d.updated_at,
            });
          }
        }

        for (const d of localDesigns) {
          if (!d.isDeleted) {
            mergedMap.set(`design:${d.id}`, {
              id: d.id,
              title: d.name || 'Untitled Canvas',
              kind: 'design',
              project_id: d.projectId,
              updated_at: d.updatedAt,
            });
          }
        }
        for (const d of designsRes.data ?? []) {
          const localRow = designById.get(d.id);
          if (localRow?.isDeleted) continue;
          if (!localRow) {
            mergedMap.set(`design:${d.id}`, {
              id: d.id,
              title: d.name || 'Untitled Canvas',
              kind: 'design',
              project_id: d.project_id,
              updated_at: d.updated_at,
            });
          }
        }

        return Array.from(mergedMap.values())
          .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
          .slice(0, limit);
      } catch {
        return buildFromLocalOnly();
      }
    },
    enabled: !!user && isRuntimeReady,
    networkMode: 'always',
  });
}
