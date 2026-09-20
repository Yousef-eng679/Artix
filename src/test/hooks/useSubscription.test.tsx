import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSubscription } from '@/hooks/useSubscription';
import { supabase } from '@/integrations/supabase/client';

// Mock useAuth
const mockUser = { id: 'test-user-uuid', email: 'test@artix.app' };
let currentUser: typeof mockUser | null = mockUser;

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: currentUser, loading: false }),
}));

describe('useSubscription Hook', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 0,
        },
      },
    });
    currentUser = mockUser;
    vi.restoreAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('should return FREE_FALLBACK when user is unauthenticated', async () => {
    currentUser = null;

    const { result } = renderHook(() => useSubscription(), { wrapper });

    expect(result.current.planTier).toBe('free');
    expect(result.current.isPro).toBe(false);
    expect(result.current.isPastDue).toBe(false);
    expect(result.current.subscription.status).toBe('active');
  });

  it('should return active Pro status when subscription table has active pro tier', async () => {
    vi.spyOn(supabase, 'from').mockImplementation(() => {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                plan_tier: 'pro',
                status: 'active',
                billing_cycle: 'monthly',
                current_period_end: '2026-10-20T00:00:00Z',
                stripe_customer_id: 'cus_12345',
              },
              error: null,
            }),
          }),
        }),
      } as any;
    });

    const { result } = renderHook(() => useSubscription(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.planTier).toBe('pro');
    expect(result.current.isPro).toBe(true);
    expect(result.current.isPastDue).toBe(false);
    expect(result.current.subscription.stripeCustomerId).toBe('cus_12345');
  });

  it('should report isPastDue = true and isPro = false when status is past_due', async () => {
    vi.spyOn(supabase, 'from').mockImplementation(() => {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                plan_tier: 'pro',
                status: 'past_due',
                billing_cycle: 'monthly',
                current_period_end: '2026-09-15T00:00:00Z',
                stripe_customer_id: 'cus_pastdue',
              },
              error: null,
            }),
          }),
        }),
      } as any;
    });

    const { result } = renderHook(() => useSubscription(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.planTier).toBe('pro');
    expect(result.current.isPro).toBe(false); // Past due should not be treated as active pro
    expect(result.current.isPastDue).toBe(true);
  });

  it('should fall back safely to free tier if Supabase returns an error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(supabase, 'from').mockImplementation(() => {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: null,
              error: { message: 'Database connection failed' },
            }),
          }),
        }),
      } as any;
    });

    const { result } = renderHook(() => useSubscription(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.planTier).toBe('free');
    expect(result.current.isPro).toBe(false);

    consoleSpy.mockRestore();
  });
});
