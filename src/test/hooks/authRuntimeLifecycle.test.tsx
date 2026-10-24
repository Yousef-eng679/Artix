import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

type AuthCallback = (event: AuthChangeEvent, session: Session | null) => void;

const authMocks = vi.hoisted(() => {
  let listener: AuthCallback | null = null;
  return {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn((cb: AuthCallback) => {
      listener = cb;
      return {
        data: {
          subscription: {
            unsubscribe: vi.fn(() => {
              if (listener === cb) listener = null;
            }),
          },
        },
      };
    }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
    emit(event: AuthChangeEvent, session: Session | null) {
      listener?.(event, session);
    },
  };
});

const runtimeMocks = vi.hoisted(() => ({
  openUserRuntime: vi.fn(),
  closeUserRuntime: vi.fn().mockResolvedValue(undefined),
  getActiveUserRuntime: vi.fn().mockReturnValue(undefined),
  clearSensitiveBrowserCaches: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: authMocks.getSession,
      onAuthStateChange: authMocks.onAuthStateChange,
      signOut: authMocks.signOut,
      refreshSession: vi.fn(),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      signInWithOAuth: vi.fn(),
      updateUser: vi.fn(),
    },
  },
}));

vi.mock('@/lib/sync/userSyncRuntime', () => ({
  openUserRuntime: runtimeMocks.openUserRuntime,
  closeUserRuntime: runtimeMocks.closeUserRuntime,
  getActiveUserRuntime: runtimeMocks.getActiveUserRuntime,
  clearSensitiveBrowserCaches: runtimeMocks.clearSensitiveBrowserCaches,
}));

import { AuthProvider, useAuth } from '@/hooks/useAuth';
import {
  UserSyncRuntimeProvider,
  useUserSyncRuntime,
} from '@/contexts/UserSyncRuntimeContext';

function makeSession(userId: string): Session {
  return {
    access_token: `tok-${userId}`,
    refresh_token: `ref-${userId}`,
    expires_in: 3600,
    token_type: 'bearer',
    user: {
      id: userId,
      aud: 'authenticated',
      role: 'authenticated',
      email: `${userId}@artix.dev`,
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-10-20T00:00:00Z',
    },
  };
}

describe('Audit SS-01: Auth Initialization Race & Runtime Open Failure Surfacing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.closeUserRuntime.mockResolvedValue(undefined);
    runtimeMocks.getActiveUserRuntime.mockReturnValue(undefined);
    runtimeMocks.clearSensitiveBrowserCaches.mockResolvedValue([]);
  });

  it('prevents a slow initial getSession() from resurrecting a session after SIGNED_OUT fires', async () => {
    let resolveInitialSession!: (value: { data: { session: Session | null }; error: null }) => void;
    authMocks.getSession.mockReturnValue(
      new Promise((res) => {
        resolveInitialSession = res;
      })
    );

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.loading).toBe(true);

    // User signs out while initial getSession() is still in flight
    act(() => {
      authMocks.emit('SIGNED_OUT', null);
    });
    expect(result.current.user).toBeNull();
    expect(result.current.session).toBeNull();

    // Late getSession() resolves with the stale pre-logout session
    await act(async () => {
      resolveInitialSession({ data: { session: makeSession('stale-user') }, error: null });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.user).toBeNull();
    expect(result.current.session).toBeNull();
  });

  it('prevents a slow initial getSession() from overwriting a newer SIGNED_IN session', async () => {
    let resolveInitialSession!: (value: { data: { session: Session | null }; error: null }) => void;
    authMocks.getSession.mockReturnValue(
      new Promise((res) => {
        resolveInitialSession = res;
      })
    );

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    const freshSession = makeSession('fresh-user');
    act(() => {
      authMocks.emit('SIGNED_IN', freshSession);
    });
    expect(result.current.user?.id).toBe('fresh-user');

    // Late getSession() resolves with null from before sign-in completed
    await act(async () => {
      resolveInitialSession({ data: { session: null }, error: null });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.user?.id).toBe('fresh-user');
    expect(result.current.session?.access_token).toBe('tok-fresh-user');
  });

  it('surfaces isDegraded and runtimeError when openUserRuntime rejects, and resets on sign-out', async () => {
    authMocks.getSession.mockResolvedValue({
      data: { session: makeSession('user-open-fail') },
      error: null,
    });
    runtimeMocks.openUserRuntime.mockRejectedValue(
      new Error('IndexedDB factory crashed unexpectedly')
    );

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>
        <UserSyncRuntimeProvider>{children}</UserSyncRuntimeProvider>
      </AuthProvider>
    );

    const { result } = renderHook(() => useUserSyncRuntime(), { wrapper });

    await waitFor(() => {
      expect(result.current?.isReady).toBe(true);
    });

    expect(result.current?.runtime).toBeNull();
    expect(result.current?.isDegraded).toBe(true);
    expect(result.current?.runtimeError).toMatchObject({
      code: 'UNKNOWN',
      message: 'IndexedDB factory crashed unexpectedly',
      fatal: true,
    });

    // Sign out clears degraded error state cleanly
    await act(async () => {
      authMocks.emit('SIGNED_OUT', null);
    });

    await waitFor(() => {
      expect(result.current?.isDegraded).toBe(false);
      expect(result.current?.runtimeError).toBeNull();
    });
  });

  it('marks context isDegraded when runtime starts in fatal errored state (e.g. STORAGE_UNAVAILABLE)', async () => {
    authMocks.getSession.mockResolvedValue({
      data: { session: makeSession('user-errored-db') },
      error: null,
    });

    const erroredStatus = {
      state: 'errored' as const,
      userId: 'user-errored-db',
      isStarted: false,
      isDegraded: false,
      error: {
        code: 'STORAGE_UNAVAILABLE' as const,
        message: 'Access denied in private browsing',
        fatal: true,
      },
      migration: null,
    };

    const fakeRuntime = {
      userId: 'user-errored-db',
      db: null,
      documentRepo: null,
      folderRepo: null,
      systemDesignRepo: null,
      outboxRepo: null,
      syncEngine: null,
      tabCoordinator: null,
      realtimeSync: null,
      getStatus: () => erroredStatus,
      subscribeStatus: (listener: (s: typeof erroredStatus) => void) => {
        listener(erroredStatus);
        return () => {};
      },
    };
    runtimeMocks.openUserRuntime.mockResolvedValue(fakeRuntime);

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>
        <UserSyncRuntimeProvider>{children}</UserSyncRuntimeProvider>
      </AuthProvider>
    );

    const { result } = renderHook(() => useUserSyncRuntime(), { wrapper });

    await waitFor(() => {
      expect(result.current?.isReady).toBe(true);
    });

    expect(result.current?.isDegraded).toBe(true);
    expect(result.current?.runtimeError?.code).toBe('STORAGE_UNAVAILABLE');
  });
});
