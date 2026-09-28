import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  UserSyncRuntime,
  openUserRuntime,
  closeUserRuntime,
  getActiveUserRuntime,
} from '@/lib/sync/userSyncRuntime';
import { UserSyncRuntimeProvider, useUserSyncRuntime } from '@/contexts/UserSyncRuntimeContext';
import { useDocuments } from '@/hooks/useDocuments';
import { useSyncStatus } from '@/hooks/useSyncStatus';
import { ArtixDB, getUserArtixDB } from '@/lib/local/db';

// Mock useAuth
const mockAuthState = {
  user: null as { id: string; email: string } | null,
  loading: false,
};

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: mockAuthState.user,
    session: null,
    loading: mockAuthState.loading,
    sessionError: null,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signInWithGoogle: vi.fn(),
    signOut: vi.fn(),
    updatePassword: vi.fn(),
    refreshSession: vi.fn(),
  }),
}));

describe('Phase C6: UserSyncRuntime Lifecycle & Provider', () => {
  beforeEach(async () => {
    mockAuthState.user = null;
    mockAuthState.loading = false;
    await closeUserRuntime();
  });

  afterEach(async () => {
    await closeUserRuntime();
  });

  it('initializes runtime on sign-in: opens DB, recovers crash leases, and registers active runtime', async () => {
    const userId = `user_signin_${Date.now()}`;
    const testDb = new ArtixDB(`ArtixDB_test_${userId}`);
    await testDb.open();

    // Seed a crashed in-flight lease
    await testDb.outbox.add({
      id: 'lease-crash-doc',
      mutationId: 'mut-crash-1',
      userId,
      projectId: 'p1',
      entityType: 'document',
      entityId: 'doc-crash-1',
      operation: 'update',
      payload: { title: 'Crashed Title' },
      localRevision: 1,
      state: 'in_flight',
      leaseOwner: 'crashed-tab-99',
      leaseExpiresAt: Date.now() - 5000, // Expired lease
      attemptCount: 1,
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 5000,
    });

    // Start runtime
    const runtime = await openUserRuntime(userId, { db: testDb });

    expect(runtime.isActive()).toBe(true);
    expect(testDb.isOpen()).toBe(true);
    expect(getActiveUserRuntime()).toBe(runtime);

    // Verify crashed lease was reclaimed into 'pending'
    const recovered = await testDb.outbox.get('lease-crash-doc');
    expect(recovered?.state).toBe('pending');
    expect(recovered?.leaseOwner).toBeNull();
    expect(recovered?.leaseExpiresAt).toBeNull();

    // Clean teardown
    await closeUserRuntime(userId);
    expect(runtime.isActive()).toBe(false);
    expect(testDb.isOpen()).toBe(false);
    expect(getActiveUserRuntime()).toBeUndefined();
  });

  it('shuts down cleanly on sign-out and releases DB connection', async () => {
    const userId = `user_signout_${Date.now()}`;
    const testDb = new ArtixDB(`ArtixDB_test_${userId}`);
    await testDb.open();

    const runtime = await openUserRuntime(userId, { db: testDb });
    expect(testDb.isOpen()).toBe(true);
    expect(getActiveUserRuntime()).toBe(runtime);

    await closeUserRuntime(userId);

    expect(runtime.isActive()).toBe(false);
    expect(testDb.isOpen()).toBe(false);
    expect(getActiveUserRuntime()).toBeUndefined();
  });

  it('cleanly transitions on account switch (User A -> User B) without state leakage', async () => {
    const userA = `user_switch_a_${Date.now()}`;
    const userB = `user_switch_b_${Date.now()}`;

    const dbA = new ArtixDB(`ArtixDB_test_${userA}`);
    const dbB = new ArtixDB(`ArtixDB_test_${userB}`);

    const runtimeA = await openUserRuntime(userA, { db: dbA });
    expect(runtimeA.userId).toBe(userA);
    expect(dbA.isOpen()).toBe(true);
    expect(getActiveUserRuntime()?.userId).toBe(userA);

    // Switch to User B
    const runtimeB = await openUserRuntime(userB, { db: dbB });
    expect(runtimeB.userId).toBe(userB);

    // Invariant: User A's runtime was stopped and its DB closed
    expect(runtimeA.isActive()).toBe(false);
    expect(dbA.isOpen()).toBe(false);

    // Invariant: User B's runtime is active and current
    expect(runtimeB.isActive()).toBe(true);
    expect(dbB.isOpen()).toBe(true);
    expect(getActiveUserRuntime()?.userId).toBe(userB);

    await closeUserRuntime(userB);
    expect(dbB.isOpen()).toBe(false);
  });

  it('UserSyncRuntimeProvider binds runtime to React tree and hooks consume repositories', async () => {
    const userId = `user_react_ctx_${Date.now()}`;
    const testDb = new ArtixDB(`ArtixDB_test_${userId}`);
    await testDb.open();

    mockAuthState.user = { id: userId, email: 'test@artix.dev' };
    mockAuthState.loading = false;

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <UserSyncRuntimeProvider>{children}</UserSyncRuntimeProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({
        runtimeCtx: useUserSyncRuntime(),
        docs: useDocuments('proj-react-ctx'),
        syncStatus: useSyncStatus(),
      }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.runtimeCtx?.isReady).toBe(true);
      expect(result.current.runtimeCtx?.runtime).not.toBeNull();
      expect(result.current.runtimeCtx?.runtime?.userId).toBe(userId);
    });

    // Invariant: Repositories and engines are unified
    expect(result.current.runtimeCtx?.documentRepo).toBe(
      result.current.runtimeCtx?.runtime?.documentRepo
    );
    expect(result.current.runtimeCtx?.syncEngine).toBe(
      result.current.runtimeCtx?.runtime?.syncEngine
    );
    expect(result.current.syncStatus.isOnline).toBe(true);

    // User creates document via hook
    await act(async () => {
      await result.current.docs.createDocument({
        title: 'Unified Runtime Doc',
        content: 'Created via UserSyncRuntimeProvider',
        format: 'markdown',
      });
    });

    // Verify document exists in runtime's DB
    const activeRuntime = getActiveUserRuntime();
    expect(activeRuntime).toBeDefined();
    const createdDocs = await activeRuntime!.documentRepo.listByProject(userId, 'proj-react-ctx');
    expect(createdDocs.some((d) => d.title === 'Unified Runtime Doc')).toBe(true);
  });
});
