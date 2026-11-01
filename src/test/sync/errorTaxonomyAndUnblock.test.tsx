import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { classifySyncError, MAX_SYNC_BACKOFF_MS } from '@/lib/sync/errorTaxonomy';
import { ArtixDB, deleteArtixDB } from '@/lib/local/db';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { SyncEngine } from '@/lib/sync/syncEngine';
import { TabCoordinator } from '@/lib/sync/tabCoordinator';
import { UserSyncRuntimeContext } from '@/contexts/UserSyncRuntimeContext';
import { SyncStatusBanner } from '@/components/SyncStatusBanner';

const mockUser = { id: 'user-task-18', email: 'sync-ui@example.com' };

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser, loading: false, isOfflineSession: false }),
}));

describe('TASK-18 (OF-09, OF-13): Structured Error Taxonomy, 429 Retry-After, TIER_LIMIT_EXCEEDED & Unblock UI', () => {
  let db: ArtixDB;

  beforeEach(async () => {
    const dbName = `ArtixDB_task18_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    db = new ArtixDB(dbName);
  });

  afterEach(async () => {
    const name = db.name;
    db.close();
    await deleteArtixDB(name);
  });

  it('1. classifies HTTP 429 as retryable RATE_LIMITED and parses Retry-After seconds & HTTP-date capped at 5 minutes', () => {
    expect(MAX_SYNC_BACKOFF_MS).toBe(300_000);

    // Numeric Retry-After seconds
    const errSeconds = {
      status: 429,
      message: 'Too Many Requests - API request quota exceeded',
      headers: { 'Retry-After': '15' },
    };
    const c1 = classifySyncError(errSeconds);
    expect(c1.code).toBe('RATE_LIMITED');
    expect(c1.retryable).toBe(true);
    expect(c1.status).toBe(429);
    expect((c1 as any).retryAfterMs).toBe(15_000);

    // HTTP-date Retry-After header
    const futureDate = new Date(Date.now() + 45_000).toUTCString();
    const errHttpDate = {
      status: 429,
      message: 'Rate limit exceeded',
      headers: new Headers({ 'retry-after': futureDate }),
    };
    const c2 = classifySyncError(errHttpDate);
    expect(c2.code).toBe('RATE_LIMITED');
    expect(c2.retryable).toBe(true);
    expect((c2 as any).retryAfterMs).toBeGreaterThanOrEqual(40_000);
    expect((c2 as any).retryAfterMs).toBeLessThanOrEqual(46_000);

    // Rogue huge Retry-After (24h = 86400s) MUST be capped at MAX_SYNC_BACKOFF_MS (300_000ms = 5m)
    const errHuge = {
      status: 429,
      message: 'Too Many Requests',
      headers: { 'retry-after': '86400' },
    };
    const c3 = classifySyncError(errHuge);
    expect(c3.code).toBe('RATE_LIMITED');
    expect((c3 as any).retryAfterMs).toBe(300_000);
  });

  it('2. classifies PostgreSQL check_plan_tier_limit() errors as non-retryable TIER_LIMIT_EXCEEDED', () => {
    const pgTierErr = {
      code: 'P0001',
      status: 400,
      message: 'Free tier document limit (10) reached. Upgrade to Pro for unlimited documents.',
    };
    const classified = classifySyncError(pgTierErr);
    expect(classified.code).toBe('TIER_LIMIT_EXCEEDED');
    expect(classified.retryable).toBe(false);

    const proProjectCapErr = {
      code: 'P0001',
      message: 'Pro tier project limit (100) reached.',
    };
    expect(classifySyncError(proProjectCapErr).code).toBe('TIER_LIMIT_EXCEEDED');
  });

  it('3. OF-13: distinguishes local browser QuotaExceededError from server messages containing "quota"', () => {
    const localDomQuota = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    const cLocal = classifySyncError(localDomQuota);
    expect(cLocal.code).toBe('STORAGE_QUOTA');
    expect(cLocal.retryable).toBe(false);

    // Server 503 mentioning "quota" must be retryable SERVER_ERROR, NOT STORAGE_QUOTA!
    const server503Quota = {
      status: 503,
      message: 'Upstream database connection quota temporarily saturated',
    };
    const cServer = classifySyncError(server503Quota);
    expect(cServer.code).toBe('SERVER_ERROR');
    expect(cServer.retryable).toBe(true);
  });

  it('4. schedules nextRetryAt honoring 429 Retry-After and supports unblocking & retrying TIER_LIMIT_EXCEEDED via SyncStatusBanner', async () => {
    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);
    const docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);

    // Part A: 429 Retry-After schedules nextRetryAt >= now + 20_000ms
    const rateLimitedDoc = await docRepo.create({
      userId: mockUser.id,
      projectId: '11111111-1111-4111-8111-111111111111',
      title: 'Rate Limited Doc',
      content: 'body',
    });

    let rpcBehavior: () => Promise<any> = async () => {
      const err: any = new Error('Too Many Requests');
      err.status = 429;
      err.headers = { 'retry-after': '20' };
      throw err;
    };

    const mockSupabase = {
      from: () => ({}),
      rpc: vi.fn(() => rpcBehavior()),
    };

    const coordinator = new TabCoordinator({ channelName: `task18-${Date.now()}` });
    vi.spyOn(coordinator, 'isLeaderTab').mockReturnValue(true);

    const syncEngine = new SyncEngine({
      userId: mockUser.id,
      autoSyncOnEnqueue: false,
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
      pullEngine: { pullAll: async () => ({ totalPulled: 0, finalCursor: 0 }) } as any,
      tabCoordinator: coordinator,
    });

    const before429 = Date.now();
    await syncEngine.triggerSync(mockUser.id);

    const [rlEntry] = await outboxRepo.listByEntity(mockUser.id, 'document', rateLimitedDoc.id);
    expect(rlEntry.state).toBe('pending');
    expect(rlEntry.lastError?.code).toBe('RATE_LIMITED');
    expect(rlEntry.nextRetryAt).toBeGreaterThanOrEqual(before429 + 20_000);

    // Clear first entry and test Part B: TIER_LIMIT_EXCEEDED -> blocked -> UI Retry unblocks & syncs!
    await outboxRepo.clear(mockUser.id);

    const tierDoc = await docRepo.create({
      userId: mockUser.id,
      projectId: '11111111-1111-4111-8111-111111111111',
      title: '11th Offline Document',
      content: 'Preserved locally!',
    });

    rpcBehavior = async () => ({
      data: null,
      error: {
        code: 'P0001',
        status: 400,
        message: 'Free tier document limit (10) reached. Upgrade to Pro for unlimited documents.',
      },
    });

    await syncEngine.triggerSync(mockUser.id);

    // Local document MUST be preserved intact in Dexie, while outbox entry is 'blocked' with TIER_LIMIT_EXCEEDED
    const savedLocal = await docRepo.getById(tierDoc.id);
    expect(savedLocal?.content).toBe('Preserved locally!');

    const [blockedEntry] = await outboxRepo.listByEntity(mockUser.id, 'document', tierDoc.id);
    expect(blockedEntry.state).toBe('blocked');
    expect(blockedEntry.lastError?.code).toBe('TIER_LIMIT_EXCEEDED');

    // User upgrades to Pro on server -> clicks Retry in SyncStatusBanner
    rpcBehavior = async () => ({
      data: { status: 'applied', version: 1, updated_at: '2026-11-01T14:00:00.000Z' },
      error: null,
    });

    render(
      <MemoryRouter>
        <UserSyncRuntimeContext.Provider
          value={{
            runtime: null,
            db,
            projectRepo: null,
            documentRepo: docRepo,
            folderRepo: null,
            systemDesignRepo: null,
            outboxRepo,
            syncEngine,
            tabCoordinator: coordinator,
            realtimeSync: null,
            isReady: true,
            runtimeStatus: null,
            isDegraded: false,
            runtimeError: null,
          }}
        >
          <SyncStatusBanner />
        </UserSyncRuntimeContext.Provider>
      </MemoryRouter>,
    );

    const banner = await screen.findByTestId('sync-blocked-banner');
    expect(banner.textContent).toMatch(/limit/i);

    const retryBtn = screen.getByTestId('retry-blocked-sync-btn');
    fireEvent.click(retryBtn);

    await waitFor(async () => {
      expect(await outboxRepo.listByEntity(mockUser.id, 'document', tierDoc.id)).toHaveLength(0);
    });

    const syncedMeta = await syncMetadataRepo.get('document', tierDoc.id);
    expect(syncedMeta?.syncState).toBe('synced');
    expect(syncedMeta?.serverVersion).toBe('1');

    syncEngine.destroy();
    coordinator.destroy();
  });
});
