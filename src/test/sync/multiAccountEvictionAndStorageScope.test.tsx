import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  openUserRuntime,
  closeUserRuntime,
} from '@/lib/sync/userSyncRuntime';
import {
  deleteArtixDB,
  getActiveUserScope,
  getUserScopeHash,
  setActiveUserScope,
} from '@/lib/local/db';
import { resetTabCoordinatorsForTesting } from '@/lib/sync/tabCoordinator';
import { getSyncEngine } from '@/lib/sync/syncEngine';
import { UserSyncRuntimeProvider } from '@/contexts/UserSyncRuntimeContext';
import { createDebouncedSaver } from '@/lib/cache/debouncedSave';
import { createTabCloseGuard } from '@/lib/cache/tabCloseGuard';
import { getDraft, getDraftKey, getRecoverableDraft } from '@/lib/cache/draftRecovery';
import {
  getTabStorageKey,
  loadWorkspaceTabs,
  saveWorkspaceTabs,
} from '@/lib/workspace/tabPersistence';
import { dirtyTracker } from '@/lib/workspace/dirtyTracker';

let currentMockAuthUser: { id: string; email: string } | null = null;

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: currentMockAuthUser,
    loading: false,
    isOfflineSession: false,
    reauthRequired: false,
  }),
}));

function createMockSupabase() {
  const rpcCalls: any[] = [];
  return {
    rpcCalls,
    client: {
      from: () => ({
        select: () => ({
          eq: () => ({
            gt: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        }),
      }),
      rpc: vi.fn(async (fn: string, args: any) => {
        rpcCalls.push({ fn, args });
        return {
          data: { status: 'applied', version: 1, updated_at: '2026-11-07T12:00:00.000Z' },
          error: null,
        };
      }),
      channel: () => {
        const ch: any = {
          on: () => ch,
          subscribe: () => ch,
          unsubscribe: () => {},
        };
        return ch;
      },
      removeChannel: vi.fn(),
    },
  };
}

describe('TASK-11 (S-06, OF-12, OF-14): Multi-Account A -> B -> A Eviction, QueryClient Purge & Scoped localStorage', () => {
  beforeEach(async () => {
    localStorage.clear();
    dirtyTracker.clear();
    currentMockAuthUser = null;
    await closeUserRuntime();
    resetTabCoordinatorsForTesting();
    setActiveUserScope(null);
  });

  afterEach(async () => {
    await closeUserRuntime();
    resetTabCoordinatorsForTesting();
    await deleteArtixDB();
    setActiveUserScope(null);
    localStorage.clear();
    dirtyTracker.clear();
  });

  it('1. S-06 / OF-12: A -> B -> A runtime switches evict dead TabCoordinator/SyncEngine/ArtixDB singletons and elect a live leader on return to A', async () => {
    const supA1 = createMockSupabase();
    const runtimeA1 = await openUserRuntime('user-A', { supabaseClient: supA1.client });
    const coordA1 = runtimeA1.tabCoordinator;

    // Wait briefly for initial microtask leader election (fallback when navigator.locks absent in jsdom)
    await waitFor(() => {
      expect(coordA1.isLeaderTab()).toBe(true);
    });

    const docA1 = await runtimeA1.documentRepo.create({
      userId: 'user-A',
      projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'Account A Secret Spec',
      content: 'Confidential A v1',
    });
    await runtimeA1.syncEngine.triggerSync('user-A');
    expect(await runtimeA1.outboxRepo.countPending('user-A')).toBe(0);

    // Switch to Account B
    const supB = createMockSupabase();
    const runtimeB = await openUserRuntime('user-B', { supabaseClient: supB.client });

    // Account A's first runtime & coordinator must be stopped and destroyed
    expect((coordA1 as any).isCoordinatorDestroyed?.()).toBe(true);
    expect(runtimeB.db.name).not.toBe(runtimeA1.db.name);
    expect(await runtimeB.documentRepo.listByProject('user-B', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toHaveLength(0);

    await waitFor(() => {
      expect(runtimeB.tabCoordinator.isLeaderTab()).toBe(true);
    });

    // Switch BACK to Account A (A -> B -> A)
    const supA2 = createMockSupabase();
    const runtimeA2 = await openUserRuntime('user-A', { supabaseClient: supA2.client });

    // CRITICAL: Must NOT reuse the dead destroyed TabCoordinator from session A1!
    expect(runtimeA2.tabCoordinator).not.toBe(coordA1);
    expect((runtimeA2.tabCoordinator as any).isCoordinatorDestroyed?.()).toBe(false);
    expect(runtimeA2.db.isOpen()).toBe(true);

    // Account A's singleton SyncEngine getter must also return a live (non-destroyed) engine
    const singletonEngineA = getSyncEngine('user-A');
    expect((singletonEngineA as any).isDestroyed).toBe(false);

    // Wait for fresh leader election on A2 and verify local edits actually push to cloud!
    await waitFor(() => {
      expect(runtimeA2.tabCoordinator.isLeaderTab()).toBe(true);
    });

    const existingDocsA = await runtimeA2.documentRepo.listByProject(
      'user-A',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    expect(existingDocsA.map((d) => d.id)).toContain(docA1.id);

    await runtimeA2.documentRepo.update(docA1.id, { content: 'Confidential A v2 after re-login' });
    await runtimeA2.syncEngine.triggerSync('user-A');

    expect(supA2.rpcCalls.length).toBeGreaterThanOrEqual(1);
    expect(await runtimeA2.outboxRepo.countPending('user-A')).toBe(0);
    singletonEngineA.destroy();
  });

  it('2. OF-12: clears TanStack QueryClient cache immediately on user switch (A -> B) and sign-out (B -> null)', async () => {
    const queryClient = new QueryClient();
    currentMockAuthUser = { id: 'user-query-A', email: 'a@example.com' };

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <UserSyncRuntimeProvider>
          <div data-testid="child" />
        </UserSyncRuntimeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(getActiveUserScope()).toBe('user-query-A');
    });

    queryClient.setQueryData(['projects'], [{ id: 'proj-A-only', name: 'Private Project A' }]);
    expect(queryClient.getQueryData(['projects'])).toBeDefined();

    // Switch directly to User B
    currentMockAuthUser = { id: 'user-query-B', email: 'b@example.com' };
    rerender(
      <QueryClientProvider client={queryClient}>
        <UserSyncRuntimeProvider>
          <div data-testid="child" />
        </UserSyncRuntimeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(queryClient.getQueryData(['projects'])).toBeUndefined();
      expect(getActiveUserScope()).toBe('user-query-B');
    });

    // Populate User B cache, then sign out (null)
    queryClient.setQueryData(['projects'], [{ id: 'proj-B-only', name: 'Private Project B' }]);
    currentMockAuthUser = null;
    rerender(
      <QueryClientProvider client={queryClient}>
        <UserSyncRuntimeProvider>
          <div data-testid="child" />
        </UserSyncRuntimeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(queryClient.getQueryData(['projects'])).toBeUndefined();
      expect(getActiveUserScope()).toBeNull();
    });
  });

  it('3. OF-12 & OF-14: scopes localStorage crash drafts and workspace tabs by userId hash so Account B never reads Account A state', () => {
    const hashA = getUserScopeHash('user-scope-A');
    const hashB = getUserScopeHash('user-scope-B');

    // Account A writes crash drafts and open tabs
    setActiveUserScope('user-scope-A');
    expect(getDraftKey('doc-shared')).toBe(`artix.draft.${hashA}.doc-shared`);
    expect(getTabStorageKey('proj-shared')).toBe(`artix.workspace.tabs.${hashA}.proj-shared`);

    const saverA = createDebouncedSaver(async () => {}, 60_000, 'doc-shared');
    saverA.save('Account A unsaved secret draft');
    saverA.cancel();

    const guardA = createTabCloseGuard();
    guardA.markDirty('doc-unload', 'Account A unload draft');
    guardA.handleBeforeUnload();

    saveWorkspaceTabs('proj-shared', [
      { id: 'document:doc-shared', resourceKind: 'document', resourceId: 'doc-shared' },
    ]);

    // Unscoped keys must NOT have been written while user-scope-A was active
    expect(localStorage.getItem('artix.draft.doc-shared')).toBeNull();
    expect(localStorage.getItem('artix.workspace.tabs.proj-shared')).toBeNull();

    // Switch to Account B -> zero visibility into Account A's drafts, dirty flags, or open tabs!
    setActiveUserScope('user-scope-B');
    expect(getDraftKey('doc-shared')).toBe(`artix.draft.${hashB}.doc-shared`);
    expect(getDraft('doc-shared')).toBeNull();
    expect(getRecoverableDraft('doc-shared', '')).toBeNull();
    expect(getDraft('doc-unload')).toBeNull();
    expect(dirtyTracker.isDirty('doc-shared', 'document')).toBe(false);
    expect(loadWorkspaceTabs('proj-shared')).toBeNull();

    // Switch back to Account A -> Account A's crash drafts and workspace tabs are preserved!
    setActiveUserScope('user-scope-A');
    expect(getDraft('doc-shared')).toBe('Account A unsaved secret draft');
    expect(getDraft('doc-unload')).toBe('Account A unload draft');
    expect(dirtyTracker.isDirty('doc-shared', 'document')).toBe(true);
    expect(loadWorkspaceTabs('proj-shared')).toEqual([
      { id: 'document:doc-shared', resourceKind: 'document', resourceId: 'doc-shared' },
    ]);
  });
});
