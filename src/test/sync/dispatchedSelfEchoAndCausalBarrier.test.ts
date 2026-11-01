import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ArtixDB, deleteArtixDB } from '@/lib/local/db';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { PullEngine } from '@/lib/sync/pullEngine';
import { SyncEngine } from '@/lib/sync/syncEngine';
import { TabCoordinator } from '@/lib/sync/tabCoordinator';

describe('TASK-07 (S-01 + Amendment C): Immutable dispatched Outbox Flag, Self-Echo Non-Overwrite Guard & Causal Barrier', () => {
  const userId = 'user-task-07';
  const projectId = '77777777-7777-4777-8777-777777777777';
  let db: ArtixDB;

  beforeEach(async () => {
    const dbName = `ArtixDB_task07_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    db = new ArtixDB(dbName);
  });

  afterEach(async () => {
    const name = db.name;
    db.close();
    await deleteArtixDB(name);
  });

  it('1. keeps dispatched=true immutable across markFailed/recoverStaleLeases and never compacts subsequent edits into a dispatched entry', async () => {
    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);

    await docRepo.applyRemoteSnapshot({
      id: 'doc-imm-1',
      userId,
      projectId,
      title: 'Initial',
      content: 'v1',
      serverVersion: '1',
      updatedAt: '2026-11-01T10:00:00.000Z',
    });

    // Edit P1 -> creates E1
    await docRepo.update('doc-imm-1', { content: 'P1' });
    const [e1Before] = await outboxRepo.listByEntity(userId, 'document', 'doc-imm-1');
    expect(e1Before.dispatched).toBeFalsy();
    const originalMutationId = e1Before.mutationId;

    // Dispatch E1 over the wire, then simulate ambiguous network timeout recovery
    await outboxRepo.markInFlight(e1Before.id, 'tab-1', 30_000);
    await outboxRepo.markFailed(
      e1Before.id,
      { code: 'TIMEOUT', message: 'Network timeout', retryable: true },
      5,
    );

    const e1AfterTimeout = await outboxRepo.getById(e1Before.id);
    expect(e1AfterTimeout?.state).toBe('pending');
    expect(e1AfterTimeout?.dispatched).toBe(true);
    expect(e1AfterTimeout?.mutationId).toBe(originalMutationId);

    // User types P2 and P3 while E1 is pending retry
    await docRepo.update('doc-imm-1', { content: 'P2' });
    await docRepo.update('doc-imm-1', { content: 'P3' });

    const entries = (await outboxRepo.listByEntity(userId, 'document', 'doc-imm-1')).sort(
      (a, b) => a.createdAt - b.createdAt,
    );

    // Must have exactly 2 entries: immutable E1 (P1, M1) + coalesced E2 (P3, M2 != M1)
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(e1Before.id);
    expect(entries[0].mutationId).toBe(originalMutationId);
    expect(entries[0].dispatched).toBe(true);
    expect((entries[0].payload as any).content).toBe('P1');

    expect(entries[1].mutationId).not.toBe(originalMutationId);
    expect(entries[1].dispatched).toBeFalsy();
    expect((entries[1].payload as any).content).toBe('P3');
  });

  it('2. PullEngine recognizes self-echoed mutation_id after lost HTTP ack and converges to synced with zero false conflicts', async () => {
    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);
    const docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);

    await docRepo.applyRemoteSnapshot({
      id: 'doc-echo-clean',
      userId,
      projectId,
      title: 'Spec',
      content: 'v1',
      serverVersion: '1',
      updatedAt: '2026-11-01T10:00:00.000Z',
    });

    await docRepo.update('doc-echo-clean', { content: 'P1 committed on server' });
    const [e1] = await outboxRepo.listByEntity(userId, 'document', 'doc-echo-clean');
    await outboxRepo.markInFlight(e1.id, 'tab-1', 30_000);
    await outboxRepo.recoverStaleLeases({ now: Date.now() + 60_000 });

    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            gt: () => ({
              order: () => ({
                limit: async () => ({
                  data: [
                    {
                      sequence: 11,
                      user_id: userId,
                      entity_type: 'document',
                      entity_id: 'doc-echo-clean',
                      operation: 'update',
                      entity_version: 2,
                      mutation_id: e1.mutationId,
                      payload: {
                        id: 'doc-echo-clean',
                        user_id: userId,
                        project_id: projectId,
                        title: 'Spec',
                        content: 'P1 committed on server',
                        format: 'markdown',
                        updated_at: '2026-11-01T10:01:00.000Z',
                      },
                      changed_at: '2026-11-01T10:01:00.000Z',
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }),
    };

    const pullEngine = new PullEngine({
      supabaseClient: mockSupabase,
      db,
      documentRepo: docRepo,
      conflictRepo,
      syncMetadataRepo,
    });

    await pullEngine.pullAll(userId);

    expect(await outboxRepo.listByEntity(userId, 'document', 'doc-echo-clean')).toHaveLength(0);
    expect(await conflictRepo.listUnresolved(userId)).toHaveLength(0);

    const meta = await syncMetadataRepo.get('document', 'doc-echo-clean');
    expect(meta?.syncState).toBe('synced');
    expect(meta?.serverVersion).toBe('2');
  });

  it('3. Amendment C Non-Overwrite Guard: self-echo of P1 acknowledges E1 and advances E2.baseServerVersion WITHOUT clobbering newer local P2, then pushes P2 cleanly', async () => {
    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);
    const docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);

    await docRepo.applyRemoteSnapshot({
      id: 'doc-amendment-c',
      userId,
      projectId,
      title: 'Design Doc',
      content: 'v1 base',
      serverVersion: '1',
      updatedAt: '2026-11-01T10:00:00.000Z',
    });

    // 1. User saves P1 -> dispatched -> server commits version 2, HTTP response is lost
    await docRepo.update('doc-amendment-c', { content: 'P1 older edit' });
    const [e1] = await outboxRepo.listByEntity(userId, 'document', 'doc-amendment-c');
    await outboxRepo.markInFlight(e1.id, 'tab-1', 30_000);
    await outboxRepo.recoverStaleLeases({ now: Date.now() + 60_000 });

    // 2. Before reconnect, user types P2 locally!
    await docRepo.update('doc-amendment-c', { content: 'P2 newest local edit' });

    const beforeSyncEntries = await outboxRepo.listByEntity(userId, 'document', 'doc-amendment-c');
    expect(beforeSyncEntries).toHaveLength(2);

    // 3. Reconnect: PullEngine sees P1 echo (version 2, mutation_id = e1.mutationId), then SyncEngine drains P2
    const pushedMutations: Array<{ mutationId: string; baseVersion: number | null; content: string }> = [];
    const mockSupabase = {
      from: (table: string) => {
        if (table === 'sync_changes') {
          return {
            select: () => ({
              eq: () => ({
                gt: (_col: string, cursor: number) => ({
                  order: () => ({
                    limit: async () => ({
                      data:
                        cursor < 20
                          ? [
                              {
                                sequence: 20,
                                user_id: userId,
                                entity_type: 'document',
                                entity_id: 'doc-amendment-c',
                                operation: 'update',
                                entity_version: 2,
                                mutation_id: e1.mutationId,
                                payload: {
                                  id: 'doc-amendment-c',
                                  user_id: userId,
                                  project_id: projectId,
                                  title: 'Design Doc',
                                  content: 'P1 older edit',
                                  format: 'markdown',
                                  updated_at: '2026-11-01T10:02:00.000Z',
                                },
                                changed_at: '2026-11-01T10:02:00.000Z',
                              },
                            ]
                          : [],
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      },
      rpc: vi.fn(async (_fn: string, params: Record<string, any>) => {
        pushedMutations.push({
          mutationId: params.p_mutation_id,
          baseVersion: params.p_base_version,
          content: params.p_payload?.content,
        });
        return {
          data: { status: 'applied', version: 3, updated_at: '2026-11-01T10:03:00.000Z' },
          error: null,
        };
      }),
    };

    const coordinator = new TabCoordinator({ channelName: `amend-c-${Date.now()}` });
    vi.spyOn(coordinator, 'isLeaderTab').mockReturnValue(true);

    const pullEngine = new PullEngine({
      supabaseClient: mockSupabase,
      db,
      documentRepo: docRepo,
      conflictRepo,
      syncMetadataRepo,
      tabCoordinator: coordinator,
    });
    const syncEngine = new SyncEngine({
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
      pullEngine,
      tabCoordinator: coordinator,
    });

    await syncEngine.triggerSync(userId);

    // Local document MUST retain P2 ("P2 newest local edit") and NEVER be overwritten by P1!
    const finalDoc = await docRepo.getById('doc-amendment-c');
    expect(finalDoc?.content).toBe('P2 newest local edit');

    // Only P2 needed to be pushed, with p_base_version = 2 (advanced by P1's self-echo!)
    expect(pushedMutations).toEqual([
      {
        mutationId: expect.any(String),
        baseVersion: 2,
        content: 'P2 newest local edit',
      },
    ]);
    expect(pushedMutations[0].mutationId).not.toBe(e1.mutationId);

    expect(await conflictRepo.listUnresolved(userId)).toHaveLength(0);
    expect(await outboxRepo.listByEntity(userId, 'document', 'doc-amendment-c')).toHaveLength(0);

    const finalMeta = await syncMetadataRepo.get('document', 'doc-amendment-c');
    expect(finalMeta?.syncState).toBe('synced');
    expect(finalMeta?.serverVersion).toBe('3');

    syncEngine.destroy();
    coordinator.destroy();
  });

  it('4. Per-Entity Causal Drain Barrier: E2 never leapfrogs E1 when E1 is in backoff or blocked, while independent entities still sync', async () => {
    const outboxRepo = new OutboxRepository(db);
    const syncMetadataRepo = new SyncMetadataRepository(db);
    const conflictRepo = new ConflictRepository(db);
    const docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);

    await docRepo.applyRemoteSnapshot({
      id: 'doc-barrier',
      userId,
      projectId,
      title: 'Barrier Doc',
      content: 'v1',
      serverVersion: '1',
    });
    await docRepo.applyRemoteSnapshot({
      id: 'doc-independent',
      userId,
      projectId,
      title: 'Independent Doc',
      content: 'v1',
      serverVersion: '1',
    });

    // E1 on doc-barrier is dispatched and enters retry backoff (nextRetryAt in future)
    await docRepo.update('doc-barrier', { content: 'P1 in backoff' });
    const [e1] = await outboxRepo.listByEntity(userId, 'document', 'doc-barrier');
    await outboxRepo.markInFlight(e1.id, 'tab-1', 30_000);
    await outboxRepo.markFailed(
      e1.id,
      { code: 'NETWORK_ERROR', message: 'Offline flake', retryable: true },
      5,
    );

    // User makes a second edit P2 on doc-barrier (nextRetryAt: null) AND edits doc-independent
    await new Promise((r) => setTimeout(r, 5));
    await docRepo.update('doc-barrier', { content: 'P2 must wait behind E1' });
    await docRepo.update('doc-independent', { content: 'Independent edit' });

    const readyEntries = await outboxRepo.getPending(50, userId, { readyOnly: true });
    expect(readyEntries.map((e) => e.entityId)).toEqual(['doc-independent']);

    const pushedIds: string[] = [];
    const mockSupabase = {
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
      rpc: vi.fn(async (_fn: string, params: Record<string, any>) => {
        pushedIds.push(params.p_entity_id);
        return {
          data: { status: 'applied', version: 2, updated_at: '2026-11-01T10:05:00.000Z' },
          error: null,
        };
      }),
    };

    const coordinator = new TabCoordinator({ channelName: `barrier-${Date.now()}` });
    vi.spyOn(coordinator, 'isLeaderTab').mockReturnValue(true);
    const pullEngine = new PullEngine({ supabaseClient: mockSupabase, db });
    const syncEngine = new SyncEngine({
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
      pullEngine,
      tabCoordinator: coordinator,
    });

    await syncEngine.triggerSync(userId);

    // Independent doc pushed, while BOTH E1 and E2 on doc-barrier waited safely in causal order!
    expect(pushedIds).toEqual(['doc-independent']);
    expect(await outboxRepo.listByEntity(userId, 'document', 'doc-barrier')).toHaveLength(2);

    syncEngine.destroy();
    coordinator.destroy();
  });
});
