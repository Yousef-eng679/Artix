import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useUsageLimits } from '@/hooks/useUsageLimits';
import { supabase } from '@/integrations/supabase/client';
import { PlanTier } from '@/lib/plans';

// Mock dependencies
const mockUser = { id: 'test-user-id', email: 'user@artix.dev' };
let currentPlan: PlanTier = 'free';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}));

vi.mock('@/hooks/useSubscription', () => ({
  useSubscription: () => ({
    subscription: { plan: currentPlan, status: 'active' },
    isPro: currentPlan === 'pro',
    isLoading: false,
  }),
}));

describe('useUsageLimits Hook', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    currentPlan = 'free';
    vi.restoreAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('should allow creation when usage is strictly below Free tier limits', async () => {
    currentPlan = 'free';

    vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
      const counts: Record<string, number> = {
        projects: 2, // limit is 3
        documents: 9, // limit is 10
        system_designs: 1, // limit is 3
        prd_generations: 1,
        vibe_generations: 1,
        agentic_workflows: 1, // AI total: 3 (limit is 5)
      };

      return {
        select: () => ({
          eq: () => ({
            gte: async () => ({ count: counts[table] ?? 0, error: null }),
            then: (resolve: any) => resolve({ count: counts[table] ?? 0, error: null }),
            count: counts[table] ?? 0,
            error: null,
          }),
        }),
      } as any;
    });

    const { result } = renderHook(() => useUsageLimits(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.projects.canCreate).toBe(true);
    expect(result.current.documents.canCreate).toBe(true);
    expect(result.current.systemDesigns.canCreate).toBe(true);
    expect(result.current.aiGenerations.canCreate).toBe(true);

    expect(result.current.documents.used).toBe(9);
    expect(result.current.documents.limit).toBe(10);
  });

  it('should block creation when user hits Free tier limits', async () => {
    currentPlan = 'free';

    vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
      const counts: Record<string, number> = {
        projects: 3, // at limit 3
        documents: 10, // at limit 10
        system_designs: 3, // at limit 3
        prd_generations: 2,
        vibe_generations: 2,
        agentic_workflows: 1, // AI total: 5 (limit is 5)
      };

      return {
        select: () => ({
          eq: () => ({
            gte: async () => ({ count: counts[table] ?? 0, error: null }),
            then: (resolve: any) => resolve({ count: counts[table] ?? 0, error: null }),
            count: counts[table] ?? 0,
            error: null,
          }),
        }),
      } as any;
    });

    const { result } = renderHook(() => useUsageLimits(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // All should be blocked
    expect(result.current.projects.canCreate).toBe(false);
    expect(result.current.documents.canCreate).toBe(false);
    expect(result.current.systemDesigns.canCreate).toBe(false);
    expect(result.current.aiGenerations.canCreate).toBe(false);
  });

  it('should allow creation for Pro tier users even with high usage counts', async () => {
    currentPlan = 'pro';

    vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
      const counts: Record<string, number> = {
        projects: 15,
        documents: 50,
        system_designs: 25,
        prd_generations: 30,
        vibe_generations: 30,
        agentic_workflows: 30, // Total 90 AI generations
      };

      return {
        select: () => ({
          eq: () => ({
            gte: async () => ({ count: counts[table] ?? 0, error: null }),
            then: (resolve: any) => resolve({ count: counts[table] ?? 0, error: null }),
            count: counts[table] ?? 0,
            error: null,
          }),
        }),
      } as any;
    });

    const { result } = renderHook(() => useUsageLimits(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Pro tier has null (unlimited) limits for docs, designs, AI
    expect(result.current.documents.limit).toBeNull();
    expect(result.current.documents.canCreate).toBe(true);

    expect(result.current.systemDesigns.limit).toBeNull();
    expect(result.current.systemDesigns.canCreate).toBe(true);

    expect(result.current.aiGenerations.limit).toBeNull();
    expect(result.current.aiGenerations.canCreate).toBe(true);

    // Projects has abuse limit of 100 on Pro
    expect(result.current.projects.limit).toBe(100);
    expect(result.current.projects.canCreate).toBe(true);
  });
});
