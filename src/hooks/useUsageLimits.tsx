/**
 * useUsageLimits.tsx
 * ──────────────────
 * React hook that counts the user's current usage and compares it
 * against their plan's limits.
 *
 * Returns per-resource usage objects with `used`, `limit`, and `canCreate`.
 * Online: queries Supabase counts and reconciles with local uncommitted Dexie entities.
 * Offline / network failure: counts non-deleted entities directly from user-scoped Dexie.
 */

import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { useSubscription } from './useSubscription';
import { useUserSyncRuntime } from '@/contexts/UserSyncRuntimeContext';
import { getUserArtixDB } from '@/lib/local/db';
import { getTabCoordinator } from '@/lib/sync/tabCoordinator';
import { PLAN_LIMITS, isWithinLimit } from '@/lib/plans';

interface UsageInfo {
  used: number;
  limit: number | null;
  canCreate: boolean;
}

export interface UsageLimits {
  projects: UsageInfo;
  documents: UsageInfo;
  systemDesigns: UsageInfo;
  aiGenerations: UsageInfo;
  isLoading: boolean;
}

const CACHED_AI_USAGE_KEY = 'cached_ai_generations';

interface CachedAiUsage {
  monthStart: string;
  count: number;
}

export function useUsageLimits(): UsageLimits {
  const { user } = useAuth();
  const { subscription } = useSubscription();
  const queryClient = useQueryClient();
  const runtimeContext = useUserSyncRuntime();
  const isRuntimeReady = !runtimeContext || runtimeContext.isReady;

  const userDb = useMemo(
    () => (user?.id ? runtimeContext?.db || getUserArtixDB(user.id) : null),
    [runtimeContext?.db, user?.id],
  );
  const coordinator = useMemo(
    () => runtimeContext?.tabCoordinator || getTabCoordinator(user?.id),
    [runtimeContext?.tabCoordinator, user?.id],
  );

  useEffect(() => {
    const unsub = coordinator.onCrossTabChange(() => {
      queryClient.invalidateQueries({ queryKey: ['usage-counts', user?.id] });
    });
    return unsub;
  }, [coordinator, queryClient, user?.id]);

  const plan = subscription?.plan && (subscription.plan in PLAN_LIMITS) ? subscription.plan : 'free';
  const limits = PLAN_LIMITS[plan];

  const query = useQuery({
    queryKey: ['usage-counts', user?.id, subscription.plan],
    queryFn: async () => {
      if (!user) return { projects: 0, documents: 0, systemDesigns: 0, aiGenerations: 0 };

      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      const monthStart = startOfMonth.toISOString();

      const readLocalCounts = async () => {
        if (!userDb) {
          return { projects: 0, documents: 0, systemDesigns: 0, aiGenerations: 0 };
        }
        try {
          const [projects, documents, systemDesigns, aiMeta] = await Promise.all([
            userDb.projects
              .where('userId')
              .equals(user.id)
              .filter((p) => !p.isDeleted)
              .count(),
            userDb.documents
              .where('userId')
              .equals(user.id)
              .filter((d) => !d.isDeleted)
              .count(),
            userDb.system_designs
              .where('userId')
              .equals(user.id)
              .filter((d) => !d.isDeleted)
              .count(),
            userDb.database_meta.get(CACHED_AI_USAGE_KEY),
          ]);

          const cachedAi = aiMeta?.value as CachedAiUsage | undefined;
          const aiGenerations =
            cachedAi && cachedAi.monthStart === monthStart && typeof cachedAi.count === 'number'
              ? cachedAi.count
              : 0;

          return { projects, documents, systemDesigns, aiGenerations };
        } catch {
          return { projects: 0, documents: 0, systemDesigns: 0, aiGenerations: 0 };
        }
      };

      const localCounts = await readLocalCounts();

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return localCounts;
      }

      try {
        // Count projects
        const projectRes = await supabase
          .from('projects')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id);

        // Count documents (across all projects)
        const docRes = await supabase
          .from('documents')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id);

        // Count system designs (across all projects)
        const designRes = await supabase
          .from('system_designs')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id);

        if (projectRes.error || docRes.error || designRes.error) {
          return localCounts;
        }

        const [prdResult, vibeResult, agenticResult] = await Promise.all([
          supabase
            .from('prd_generations')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', user.id)
            .gte('created_at', monthStart),
          supabase
            .from('vibe_generations')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', user.id)
            .gte('created_at', monthStart),
          supabase
            .from('agentic_workflows')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', user.id)
            .gte('created_at', monthStart),
        ]);

        const aiTotal =
          (prdResult.count ?? 0) +
          (vibeResult.count ?? 0) +
          (agenticResult.count ?? 0);

        if (userDb) {
          try {
            await userDb.database_meta.put({
              key: CACHED_AI_USAGE_KEY,
              value: { monthStart, count: aiTotal } satisfies CachedAiUsage,
              updatedAt: Date.now(),
            });
          } catch {
            // Ignore local cache write errors
          }
        }

        return {
          projects: Math.max(projectRes.count ?? 0, localCounts.projects),
          documents: Math.max(docRes.count ?? 0, localCounts.documents),
          systemDesigns: Math.max(designRes.count ?? 0, localCounts.systemDesigns),
          aiGenerations: aiTotal,
        };
      } catch {
        return localCounts;
      }
    },
    enabled: !!user && isRuntimeReady,
    networkMode: 'always',
    staleTime: 30_000, // Refresh every 30 seconds
  });

  const counts = query.data ?? { projects: 0, documents: 0, systemDesigns: 0, aiGenerations: 0 };

  return {
    projects: {
      used: counts.projects,
      limit: limits.projects,
      canCreate: isWithinLimit(counts.projects, limits.projects),
    },
    documents: {
      used: counts.documents,
      limit: limits.documents,
      canCreate: isWithinLimit(counts.documents, limits.documents),
    },
    systemDesigns: {
      used: counts.systemDesigns,
      limit: limits.systemDesigns,
      canCreate: isWithinLimit(counts.systemDesigns, limits.systemDesigns),
    },
    aiGenerations: {
      used: counts.aiGenerations,
      limit: limits.aiGenerationsPerMonth,
      canCreate: isWithinLimit(counts.aiGenerations, limits.aiGenerationsPerMonth),
    },
    isLoading: query.isLoading || (Boolean(user) && (!isRuntimeReady || query.isPending)),
  };
}
