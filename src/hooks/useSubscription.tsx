/**
 * useSubscription.tsx
 * ───────────────────
 * React hook that reads the current user's subscription from Supabase,
 * with user-scoped Dexie (`database_meta.cached_subscription`) read-through
 * continuity so Pro users are never downgraded to Free during offline cold starts.
 *
 * The `subscriptions` table is written ONLY by Edge Functions (webhook).
 * This hook only reads — no user can write to their own subscription row.
 *
 * If no subscription row exists (legacy users created before billing),
 * the hook returns a safe fallback: plan = 'free', status = 'active'.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { useUserSyncRuntime } from '@/contexts/UserSyncRuntimeContext';
import { getUserArtixDB } from '@/lib/local/db';
import { PlanTier } from '@/lib/plans';

export interface Subscription {
  plan: PlanTier;
  status: 'active' | 'past_due' | 'canceled' | 'incomplete';
  billingCycle: 'monthly' | 'annual' | null;
  currentPeriodEnd: string | null;
  stripeCustomerId: string | null;
}

const CACHED_SUBSCRIPTION_KEY = 'cached_subscription';

const FREE_FALLBACK: Subscription = {
  plan: 'free',
  status: 'active',
  billingCycle: null,
  currentPeriodEnd: null,
  stripeCustomerId: null,
};

function isValidCachedSubscription(val: unknown): val is Subscription {
  if (!val || typeof val !== 'object') return false;
  const candidate = val as Record<string, unknown>;
  return typeof candidate.plan === 'string' && typeof candidate.status === 'string';
}

function isOfflineOrTransportFailure(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return true;
  }
  if (err instanceof TypeError) {
    return true;
  }
  const code = String((err as any)?.code || '');
  const msg = String((err as any)?.message || err || '').toLowerCase();
  return (
    code === 'OFFLINE_SESSION_PAUSED' ||
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('fetch failed') ||
    msg.includes('load failed')
  );
}

export function useSubscription() {
  const { user } = useAuth();
  const runtimeContext = useUserSyncRuntime();
  const isRuntimeReady = !runtimeContext || runtimeContext.isReady;

  const userDb = useMemo(
    () => (user?.id ? runtimeContext?.db || getUserArtixDB(user.id) : null),
    [runtimeContext?.db, user?.id],
  );

  const query = useQuery({
    queryKey: ['subscription', user?.id],
    queryFn: async (): Promise<Subscription> => {
      if (!user) return FREE_FALLBACK;

      const readCached = async (): Promise<Subscription | null> => {
        if (!userDb) return null;
        try {
          const entry = await userDb.database_meta.get(CACHED_SUBSCRIPTION_KEY);
          if (entry && isValidCachedSubscription(entry.value)) {
            return entry.value;
          }
        } catch {
          // Ignore local cache read errors
        }
        return null;
      };

      const writeCached = async (sub: Subscription): Promise<void> => {
        if (!userDb) return;
        try {
          await userDb.database_meta.put({
            key: CACHED_SUBSCRIPTION_KEY,
            value: sub,
            updatedAt: Date.now(),
          });
        } catch {
          // Ignore local cache write errors
        }
      };

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return (await readCached()) ?? FREE_FALLBACK;
      }

      try {
        const { data, error } = await supabase
          .from('subscriptions')
          .select('plan_tier, status, billing_cycle, current_period_end, stripe_customer_id')
          .eq('user_id', user.id)
          .maybeSingle();

        if (error) {
          console.error('Failed to load subscription:', error);
          if (isOfflineOrTransportFailure(error)) {
            return (await readCached()) ?? FREE_FALLBACK;
          }
          return FREE_FALLBACK;
        }

        // No row = legacy user → free plan
        if (!data) {
          await writeCached(FREE_FALLBACK);
          return FREE_FALLBACK;
        }

        const resolved: Subscription = {
          plan: data.plan_tier as PlanTier,
          status: data.status as Subscription['status'],
          billingCycle: data.billing_cycle as Subscription['billingCycle'],
          currentPeriodEnd: data.current_period_end,
          stripeCustomerId: data.stripe_customer_id,
        };

        await writeCached(resolved);
        return resolved;
      } catch (err) {
        console.error('Failed to load subscription:', err);
        if (isOfflineOrTransportFailure(err)) {
          return (await readCached()) ?? FREE_FALLBACK;
        }
        return FREE_FALLBACK;
      }
    },
    enabled: !!user && isRuntimeReady,
    networkMode: 'always',
    staleTime: 60_000, // Cache for 60 seconds
  });

  const subscription = query.data ?? FREE_FALLBACK;
  const isPro = subscription.plan === 'pro' && subscription.status === 'active';
  const isPastDue = subscription.status === 'past_due';

  return {
    subscription,
    planTier: subscription.plan,
    isPro,
    isPastDue,
    isLoading: query.isLoading || (Boolean(user) && (!isRuntimeReady || query.isPending)),
    refetch: query.refetch,
  };
}
