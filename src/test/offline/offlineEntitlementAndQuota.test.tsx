import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { ArtixDB } from '@/lib/local/db';
import { supabase } from '@/integrations/supabase/client';
import { useSubscription } from '@/hooks/useSubscription';
import { useUsageLimits } from '@/hooks/useUsageLimits';

const PRO_USER = { id: 'user-pro-of15', email: 'pro@example.test' };
const FREE_USER = { id: 'user-free-of15', email: 'free@example.test' };

let currentUser = PRO_USER;
const TestRuntimeContext = React.createContext<any>(null);

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: currentUser,
    session: { user: currentUser },
    loading: false,
  }),
}));

vi.mock('@/contexts/UserSyncRuntimeContext', () => ({
  useUserSyncRuntime: () => React.useContext(TestRuntimeContext),
}));

describe('OF-15 / TASK-29: Offline Subscription Continuity & Local Dexie Quota Counting', () => {
  const originalOnLine = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
  let db: ArtixDB;

  function setOnlineState(online: boolean) {
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => online,
    });
    onlineManager.setOnline(online);
  }

  beforeEach(async () => {
    setOnlineState(true);
    db = new ArtixDB(`artix_task29_${crypto.randomUUID()}`);
    await db.open();
  });

  afterEach(async () => {
    cleanup();
    setOnlineState(true);
    if (originalOnLine) {
      Object.defineProperty(window.navigator, 'onLine', originalOnLine);
    }
    vi.restoreAllMocks();
    db.close();
    await db.delete();
  });

  function makeWrapper(queryClient: QueryClient) {
    const runtimeBundle = { isReady: true, db };
    return ({ children }: { children: React.ReactNode }) => (
      <TestRuntimeContext.Provider value={runtimeBundle}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </TestRuntimeContext.Provider>
    );
  }

  it('1. preserves Pro entitlement on offline cold start after online cache warm-up, allowing >10 local docs', async () => {
    currentUser = PRO_USER;

    // Seed 12 non-deleted local documents in user-scoped Dexie
    const now = '2026-03-01T00:00:00.000Z';
    await db.documents.bulkPut(
      Array.from({ length: 12 }, (_, idx) => ({
        id: `pro-doc-${idx + 1}`,
        projectId: 'proj-pro',
        userId: PRO_USER.id,
        folderId: null,
        title: `Pro Spec ${idx + 1}`,
        content: '# Spec',
        format: 'markdown' as const,
        createdAt: now,
        updatedAt: now,
        localRevision: 1,
        isDeleted: false,
      })),
    );

    // Phase 1: Online session caches active Pro subscription
    vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  plan_tier: 'pro',
                  status: 'active',
                  billing_cycle: 'annual',
                  current_period_end: '2027-01-01T00:00:00Z',
                  stripe_customer_id: 'cus_pro_29',
                },
                error: null,
              }),
            }),
          }),
        } as any;
      }
      return {
        select: () => ({
          eq: () => ({
            gte: async () => ({ count: 2, error: null }),
            then: (resolve: any) => resolve({ count: 12, error: null }),
            count: 12,
            error: null,
          }),
        }),
      } as any;
    });

    const onlineQc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const onlineRender = renderHook(
      () => ({
        sub: useSubscription(),
        limits: useUsageLimits(),
      }),
      { wrapper: makeWrapper(onlineQc) },
    );

    await waitFor(() => {
      expect(onlineRender.result.current.sub.isPro).toBe(true);
      expect(onlineRender.result.current.limits.isLoading).toBe(false);
    });
    expect(onlineRender.result.current.limits.documents.used).toBe(12);
    expect(onlineRender.result.current.limits.documents.canCreate).toBe(true);

    onlineRender.unmount();

    // Phase 2: Cold start completely OFFLINE with brand-new QueryClient and network failure
    setOnlineState(false);
    vi.spyOn(supabase, 'from').mockImplementation(() => {
      throw new TypeError('Failed to fetch');
    });

    const coldOfflineQc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const offlineRender = renderHook(
      () => ({
        sub: useSubscription(),
        limits: useUsageLimits(),
      }),
      { wrapper: makeWrapper(coldOfflineQc) },
    );

    await waitFor(() => {
      expect(offlineRender.result.current.sub.isLoading).toBe(false);
      expect(offlineRender.result.current.limits.isLoading).toBe(false);
    });

    expect(offlineRender.result.current.sub.planTier).toBe('pro');
    expect(offlineRender.result.current.sub.isPro).toBe(true);
    expect(offlineRender.result.current.limits.documents.used).toBe(12);
    expect(offlineRender.result.current.limits.documents.limit).toBeNull();
    expect(offlineRender.result.current.limits.documents.canCreate).toBe(true);
  });

  it('2. counts local non-deleted Dexie projects, documents, and system_designs when cold-started offline on Free tier', async () => {
    currentUser = FREE_USER;
    const now = '2026-03-01T00:00:00.000Z';

    // Seed 3 projects (at Free limit 3)
    await db.projects.bulkPut(
      Array.from({ length: 3 }, (_, idx) => ({
        id: `free-proj-${idx + 1}`,
        userId: FREE_USER.id,
        name: `Project ${idx + 1}`,
        createdAt: now,
        updatedAt: now,
      })),
    );

    // Seed 10 active documents (at Free limit 10) + 2 soft-deleted documents (must NOT count)
    await db.documents.bulkPut([
      ...Array.from({ length: 10 }, (_, idx) => ({
        id: `free-doc-${idx + 1}`,
        projectId: 'free-proj-1',
        userId: FREE_USER.id,
        folderId: null,
        title: `Doc ${idx + 1}`,
        content: '',
        format: 'markdown' as const,
        createdAt: now,
        updatedAt: now,
        localRevision: 1,
        isDeleted: false,
      })),
      {
        id: 'free-doc-deleted-1',
        projectId: 'free-proj-1',
        userId: FREE_USER.id,
        folderId: null,
        title: 'Deleted 1',
        content: '',
        format: 'markdown' as const,
        createdAt: now,
        updatedAt: now,
        localRevision: 2,
        isDeleted: true,
        deletedAt: now,
      },
      {
        id: 'free-doc-deleted-2',
        projectId: 'free-proj-1',
        userId: FREE_USER.id,
        folderId: null,
        title: 'Deleted 2',
        content: '',
        format: 'markdown' as const,
        createdAt: now,
        updatedAt: now,
        localRevision: 2,
        isDeleted: true,
        deletedAt: now,
      },
    ]);

    // Seed 2 active system_designs (below Free limit 3)
    await db.system_designs.bulkPut(
      Array.from({ length: 2 }, (_, idx) => ({
        id: `free-sd-${idx + 1}`,
        projectId: 'free-proj-1',
        userId: FREE_USER.id,
        folderId: null,
        name: `Design ${idx + 1}`,
        boardState: { nodes: [], edges: [] },
        createdAt: now,
        updatedAt: now,
        localRevision: 1,
        isDeleted: false,
      })),
    );

    setOnlineState(false);
    vi.spyOn(supabase, 'from').mockImplementation(() => {
      throw new TypeError('Failed to fetch');
    });

    const coldOfflineQc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(() => useUsageLimits(), {
      wrapper: makeWrapper(coldOfflineQc),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.projects).toEqual({
      used: 3,
      limit: 3,
      canCreate: false,
    });
    expect(result.current.documents).toEqual({
      used: 10,
      limit: 10,
      canCreate: false,
    });
    expect(result.current.systemDesigns).toEqual({
      used: 2,
      limit: 3,
      canCreate: true,
    });
  });
});
