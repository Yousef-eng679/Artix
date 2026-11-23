import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { createClient } from '@supabase/supabase-js';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { ThemeProvider } from '@/hooks/useTheme';
import { TooltipProvider } from '@/components/ui/tooltip';
import { UserSyncRuntimeProvider, useUserSyncRuntime } from '@/contexts/UserSyncRuntimeContext';
import { closeUserRuntime, getActiveUserRuntime } from '@/lib/sync/userSyncRuntime';
import { resetTabCoordinatorsForTesting } from '@/lib/sync/tabCoordinator';
import { deleteArtixDB, getUserDbName } from '@/lib/local/db';
import Dashboard from '@/pages/Dashboard';

const SUPABASE_TEST_URL = 'https://offlineboot.supabase.co';
const SUPABASE_TEST_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.sig';
const STORAGE_KEY = 'sb-offlineboot-auth-token';

const networkControl = vi.hoisted(() => ({
  mode: 'offline' as 'offline' | 'online_valid' | 'online_revoked',
  tokenRefreshCalls: 0,
  syncFeedCalls: 0,
}));

const testSupabaseHolder = vi.hoisted(() => ({
  client: null as ReturnType<typeof createClient> | null,
}));

function makeFakeJwt(expSeconds: number, sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ sub, exp: expSeconds, role: 'authenticated', aud: 'authenticated' }));
  return `${header}.${payload}.fakesig`;
}

function createControllableSupabaseClient() {
  return createClient(SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY, {
    auth: {
      storage: window.localStorage,
      storageKey: STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    global: {
      fetch: async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

        if (networkControl.mode === 'offline') {
          throw new TypeError('Failed to fetch');
        }

        if (url.includes('/auth/v1/token')) {
          networkControl.tokenRefreshCalls += 1;
          if (networkControl.mode === 'online_revoked') {
            return new Response(
              JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid Refresh Token: Already Used' }),
              { status: 400, headers: { 'Content-Type': 'application/json' } },
            );
          }

          const futureExp = Math.floor(Date.now() / 1000) + 3600;
          const userId = '11111111-1111-4111-8111-111111111111';
          return new Response(
            JSON.stringify({
              access_token: makeFakeJwt(futureExp, userId),
              token_type: 'bearer',
              expires_in: 3600,
              expires_at: futureExp,
              refresh_token: `refreshed-token-${networkControl.tokenRefreshCalls}`,
              user: {
                id: userId,
                aud: 'authenticated',
                role: 'authenticated',
                email: 'architect@artix.test',
                app_metadata: { provider: 'email' },
                user_metadata: {},
                created_at: '2026-09-01T00:00:00Z',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (url.includes('/auth/v1/logout')) {
          return new Response(null, { status: 204 });
        }

        if (url.includes('/rest/v1/sync_changes')) {
          networkControl.syncFeedCalls += 1;
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  });
}

vi.mock('@/integrations/supabase/client', () => ({
  get supabase() {
    if (!testSupabaseHolder.client) {
      testSupabaseHolder.client = createControllableSupabaseClient();
    }
    return testSupabaseHolder.client;
  },
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    projects: [],
    isLoading: false,
    createProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    isCreating: false,
  }),
}));

vi.mock('@/hooks/useRecentActivity', () => ({
  useRecentActivity: () => ({
    data: [],
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useUsageLimits', () => ({
  useUsageLimits: () => ({
    projects: { used: 0, limit: 3, canCreate: true },
    documents: { used: 0, limit: 10, canCreate: true },
    systemDesigns: { used: 0, limit: 3, canCreate: true },
    aiGenerations: { used: 0, limit: 5, canCreate: true },
    isLoading: false,
  }),
}));

function Probe() {
  const auth = useAuth() as ReturnType<typeof useAuth> & {
    isOfflineSession?: boolean;
    reauthRequired?: boolean;
  };
  const runtimeCtx = useUserSyncRuntime();
  const location = useLocation();
  return (
    <div>
      <div data-testid="pathname">{location.pathname}</div>
      <div data-testid="auth-loading">{String(auth.loading)}</div>
      <div data-testid="auth-user-id">{auth.user?.id ?? 'null'}</div>
      <div data-testid="is-offline-session">{String(Boolean(auth.isOfflineSession))}</div>
      <div data-testid="reauth-required">{String(Boolean(auth.reauthRequired))}</div>
      <div data-testid="runtime-ready">{String(Boolean(runtimeCtx?.isReady))}</div>
      <div data-testid="runtime-db-name">{runtimeCtx?.db?.name ?? 'null'}</div>
      <button data-testid="trigger-signout" onClick={() => void auth.signOut()}>
        Sign Out
      </button>
    </div>
  );
}

describe('OF-02 & OF-03 / TASK-25: Offline Session Continuity for Expired JWT Cold Starts', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  let originalOnLineDescriptor: PropertyDescriptor | undefined;

  function seedExpiredStoredSession() {
    const expiredAt = Math.floor(Date.now() / 1000) - 7200; // 2 hours expired
    const storedSession = {
      access_token: makeFakeJwt(expiredAt, userId),
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: expiredAt,
      refresh_token: 'valid-stored-refresh-token',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'architect@artix.test',
        app_metadata: { provider: 'email' },
        user_metadata: {},
        created_at: '2026-09-01T00:00:00Z',
      },
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(storedSession));
  }

  function setBrowserOnline(online: boolean) {
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => online,
    });
    onlineManager.setOnline(online);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    await closeUserRuntime();
    resetTabCoordinatorsForTesting();
    await deleteArtixDB();
    window.localStorage.clear();

    networkControl.mode = 'offline';
    networkControl.tokenRefreshCalls = 0;
    networkControl.syncFeedCalls = 0;

    originalOnLineDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
    setBrowserOnline(false);

    seedExpiredStoredSession();
    testSupabaseHolder.client = createControllableSupabaseClient();
  });

  afterEach(async () => {
    await closeUserRuntime();
    resetTabCoordinatorsForTesting();
    if (testSupabaseHolder.client) {
      await testSupabaseHolder.client.removeAllChannels();
      testSupabaseHolder.client = null;
    }
    setBrowserOnline(true);
    if (originalOnLineDescriptor) {
      Object.defineProperty(window.navigator, 'onLine', originalOnLineDescriptor);
    }
    window.localStorage.clear();
    await deleteArtixDB();
  });

  it('preserves user identity, opens scoped ArtixDB, avoids /auth redirect offline, and refreshes + syncs on reconnect', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <AuthProvider>
            <UserSyncRuntimeProvider>
              <ThemeProvider>
                <TooltipProvider>
                  <Probe />
                  <Routes>
                    <Route path="/dashboard" element={<Dashboard />} />
                    <Route path="/auth" element={<div data-testid="auth-route">Auth Page</div>} />
                  </Routes>
                </TooltipProvider>
              </ThemeProvider>
            </UserSyncRuntimeProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('auth-loading').textContent).toBe('false');
      expect(screen.getByTestId('runtime-ready').textContent).toBe('true');
    });

    // 1. Offline boot with 2h-expired JWT MUST preserve user, enter isOfflineSession, stay on /dashboard, and open ArtixDB_v2_<hash>
    expect(screen.getByTestId('auth-user-id').textContent).toBe(userId);
    expect(screen.getByTestId('is-offline-session').textContent).toBe('true');
    expect(screen.getByTestId('pathname').textContent).toBe('/dashboard');
    expect(screen.queryByTestId('auth-route')).not.toBeInTheDocument();
    expect(screen.getByTestId('runtime-db-name').textContent).toBe(getUserDbName(userId));

    const activeRuntime = getActiveUserRuntime();
    expect(activeRuntime?.db.isOpen()).toBe(true);
    // Cloud sync calls must be held while session JWT is expired offline
    expect(networkControl.syncFeedCalls).toBe(0);

    // Local Dexie writes must succeed while in offline session
    const createdDoc = await activeRuntime!.documentRepo.create({
      userId,
      projectId: null,
      title: 'Written During Expired JWT Offline Session',
      content: '# Offline durability',
    });
    expect(createdDoc.id).toBeTruthy();

    // 2. Restore network connectivity: session refreshes, isOfflineSession -> false, and SyncEngine wakes up
    await act(async () => {
      networkControl.mode = 'online_valid';
      setBrowserOnline(true);
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('is-offline-session').textContent).toBe('false');
      expect(networkControl.tokenRefreshCalls).toBeGreaterThanOrEqual(1);
      expect(networkControl.syncFeedCalls).toBeGreaterThanOrEqual(1);
    });

    expect(screen.getByTestId('auth-user-id').textContent).toBe(userId);
    expect(screen.getByTestId('pathname').textContent).toBe('/dashboard');
  });

  it('clears stored session and offline identity completely when signOut() is invoked while offline', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <AuthProvider>
            <UserSyncRuntimeProvider>
              <ThemeProvider>
                <TooltipProvider>
                  <Probe />
                  <Routes>
                    <Route path="/dashboard" element={<Dashboard />} />
                    <Route path="/auth" element={<div data-testid="auth-route">Auth Page</div>} />
                  </Routes>
                </TooltipProvider>
              </ThemeProvider>
            </UserSyncRuntimeProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('auth-user-id').textContent).toBe(userId);
      expect(screen.getByTestId('is-offline-session').textContent).toBe('true');
    });

    await act(async () => {
      screen.getByTestId('trigger-signout').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('auth-user-id').textContent).toBe('null');
      expect(screen.getByTestId('is-offline-session').textContent).toBe('false');
      expect(screen.getByTestId('pathname').textContent).toBe('/auth');
    });

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(getActiveUserRuntime()).toBeUndefined();
  });

  it('surfaces non-destructive reauthRequired state without kicking user out of offline workspace if refresh token was revoked server-side', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <AuthProvider>
            <UserSyncRuntimeProvider>
              <ThemeProvider>
                <TooltipProvider>
                  <Probe />
                  <Routes>
                    <Route path="/dashboard" element={<Dashboard />} />
                    <Route path="/auth" element={<div data-testid="auth-route">Auth Page</div>} />
                  </Routes>
                </TooltipProvider>
              </ThemeProvider>
            </UserSyncRuntimeProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('auth-user-id').textContent).toBe(userId);
      expect(screen.getByTestId('is-offline-session').textContent).toBe('true');
    });

    await act(async () => {
      networkControl.mode = 'online_revoked';
      setBrowserOnline(true);
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('reauth-required').textContent).toBe('true');
      expect(screen.getByTestId('reauth-sync-banner')).toBeInTheDocument();
    });

    // User is NOT abruptly kicked out of local workspace; Dexie remains accessible
    expect(screen.getByTestId('auth-user-id').textContent).toBe(userId);
    expect(screen.getByTestId('pathname').textContent).toBe('/dashboard');
  });
});
