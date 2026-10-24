import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import fs from 'fs';
import path from 'path';
import { PullEngine } from '@/lib/sync/pullEngine';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { ArtixDB } from '@/lib/local/db';

/**
 * Audit F-001 / F-007 regression suite.
 *
 * F-007: rows handled by an early `continue` branch (delete convergence,
 *        stale update against a confirmed tombstone) must still advance the
 *        durable cursor, otherwise the same row is re-fetched on every pull.
 * F-001: the client cursor is only correct if, per user, the server never
 *        makes a lower sequence visible after a higher one. The server
 *        guarantees this with a per-user advisory lock taken in
 *        record_sync_change() before the identity value is allocated.
 */

type FeedRow = {
  sequence: number;
  user_id: string;
  entity_type: string;
  entity_id: string;
  operation: 'create' | 'update' | 'delete';
  entity_version: number;
  payload: Record<string, unknown> | null;
  changed_at: string;
};

/**
 * Stateful sync_changes mock that honours the exact query shape used by
 * PullEngine: .select().eq('user_id').gt('sequence', cursor).order().limit().
 * Only rows in `visible` are returned, which lets tests model commit visibility.
 */
function createFeed() {
  const visible: FeedRow[] = [];
  const queries: number[] = [];
  const client = {
    from: (table: string) => {
      if (table !== 'sync_changes') return {};
      return {
        select: () => ({
          eq: (_col: string, userId: string) => ({
            gt: (_seqCol: string, cursor: number) => ({
              order: () => ({
                limit: (n: number) => {
                  queries.push(cursor);
                  const rows = visible
                    .filter((r) => r.user_id === userId && r.sequence > cursor)
                    .sort((a, b) => a.sequence - b.sequence)
                    .slice(0, n);
                  return Promise.resolve({ data: rows, error: null });
                },
              }),
            }),
          }),
        }),
      };
    },
  };
  return { visible, queries, client };
}

const userId = 'user-f001';
const projectId = 'proj-f001';

describe('Audit F-007: cursor advances on every handled pull branch', () => {
  let db: ArtixDB;
  let outboxRepo: OutboxRepository;
  let syncMetadataRepo: SyncMetadataRepository;
  let conflictRepo: ConflictRepository;
  let documentRepo: DocumentRepository;

  beforeEach(async () => {
    db = new ArtixDB(`TestDB_F007_${Date.now()}_${Math.random()}`);
    await db.open();
    outboxRepo = new OutboxRepository(db);
    syncMetadataRepo = new SyncMetadataRepository(db);
    conflictRepo = new ConflictRepository(db);
    documentRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);
  });

  afterEach(async () => {
    await db.delete();
  });

  function engine(client: unknown) {
    return new PullEngine({ db, supabaseClient: client, documentRepo, conflictRepo, syncMetadataRepo });
  }

  it('advances past a concurrent delete-convergence row and does not re-fetch it', async () => {
    await documentRepo.applyRemoteSnapshot({
      id: 'doc-converge', userId, projectId, title: 'T', content: 'C', serverVersion: '3',
    });
    await documentRepo.delete('doc-converge'); // local pending delete in outbox
    expect(await outboxRepo.countPending(userId)).toBe(1);

    const feed = createFeed();
    feed.visible.push({
      sequence: 41, user_id: userId, entity_type: 'document', entity_id: 'doc-converge',
      operation: 'delete', entity_version: 3, payload: null, changed_at: '2026-10-20T10:00:00Z',
    });

    const pull = engine(feed.client);
    const first = await pull.pullBatch(userId);

    expect(first.pulledCount).toBe(1);
    expect(first.newCursor).toBe(41);
    expect(await pull.getCursor()).toBe(41);
    expect(await outboxRepo.countPending(userId)).toBe(0);
    expect((await syncMetadataRepo.get('document', 'doc-converge'))?.syncState).toBe('deleted_synced');

    const second = await pull.pullBatch(userId);
    expect(second.pulledCount).toBe(0);
    expect(feed.queries).toEqual([0, 41]);
  });

  it('advances past a stale update against a confirmed tombstone without resurrecting it', async () => {
    await documentRepo.applyRemoteSnapshot({
      id: 'doc-tomb', userId, projectId, title: 'Deleted', content: 'Gone', serverVersion: '5',
    });
    await documentRepo.delete('doc-tomb', { skipOutbox: true });
    await syncMetadataRepo.upsertInTx({
      entityType: 'document', entityId: 'doc-tomb', userId,
      syncState: 'deleted_synced', serverVersion: '5', serverUpdatedAt: '2026-10-20T10:00:00Z',
    });

    const feed = createFeed();
    feed.visible.push({
      sequence: 77, user_id: userId, entity_type: 'document', entity_id: 'doc-tomb',
      operation: 'update', entity_version: 4,
      payload: { project_id: projectId, title: 'Zombie', content: 'Zombie' },
      changed_at: '2026-10-20T09:00:00Z',
    });

    const pull = engine(feed.client);
    const first = await pull.pullBatch(userId);
    expect(first.newCursor).toBe(77);

    const stored = await db.documents.get('doc-tomb');
    expect(stored?.isDeleted).toBe(true);
    expect(stored?.title).toBe('Deleted');

    const second = await pull.pullBatch(userId);
    expect(second.pulledCount).toBe(0);
    expect(feed.queries).toEqual([0, 77]);
  });

  it('advances past a stale remote observation that preserves pending local intent', async () => {
    await documentRepo.applyRemoteSnapshot({
      id: 'doc-stale', userId, projectId, title: 'Base', content: 'Base', serverVersion: '6',
    });
    await documentRepo.update('doc-stale', { content: 'Local edit' });

    const feed = createFeed();
    feed.visible.push({
      sequence: 90, user_id: userId, entity_type: 'document', entity_id: 'doc-stale',
      operation: 'update', entity_version: 6,
      payload: { project_id: projectId, title: 'Base', content: 'Base' },
      changed_at: '2026-10-20T09:00:00Z',
    });

    const pull = engine(feed.client);
    expect((await pull.pullBatch(userId)).newCursor).toBe(90);
    expect((await documentRepo.getById('doc-stale'))?.content).toBe('Local edit');
    expect((await pull.pullBatch(userId)).pulledCount).toBe(0);
  });
});

describe('Audit F-001: commit-order safety of the change-feed cursor', () => {
  let db: ArtixDB;
  let documentRepo: DocumentRepository;
  let syncMetadataRepo: SyncMetadataRepository;

  beforeEach(async () => {
    db = new ArtixDB(`TestDB_F001_${Date.now()}_${Math.random()}`);
    await db.open();
    syncMetadataRepo = new SyncMetadataRepository(db);
    documentRepo = new DocumentRepository(db, new OutboxRepository(db), syncMetadataRepo);
  });

  afterEach(async () => {
    await db.delete();
  });

  const row = (sequence: number, entityId: string): FeedRow => ({
    sequence, user_id: userId, entity_type: 'document', entity_id: entityId,
    operation: 'create', entity_version: 1,
    payload: { project_id: projectId, title: entityId, content: '' },
    changed_at: '2026-10-20T10:00:00Z',
  });

  /**
   * Minimal model of record_sync_change() with the F-001 lock: a transaction
   * must hold the per-user lock to allocate a sequence, and holds it until it
   * commits. Allocation is therefore impossible while another same-user
   * transaction is open.
   */
  function createSerializedServer(feed: ReturnType<typeof createFeed>) {
    let nextSeq = 1;
    let lockHolder: symbol | null = null;
    const waiters: Array<() => void> = [];

    async function acquire(tx: symbol) {
      while (lockHolder && lockHolder !== tx) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      lockHolder = tx;
    }

    function begin() {
      const tx = Symbol('tx');
      let pending: FeedRow | null = null;
      return {
        async insert(entityId: string) {
          await acquire(tx);
          pending = row(nextSeq++, entityId);
        },
        commit() {
          if (pending) feed.visible.push(pending);
          pending = null;
          if (lockHolder === tx) {
            lockHolder = null;
            waiters.splice(0).forEach((w) => w());
          }
        },
      };
    }
    return { begin };
  }

  it('documents the hazard: without per-user serialization the cursor skips a late-committing lower sequence', async () => {
    const feed = createFeed();
    const pull = new PullEngine({ db, supabaseClient: feed.client, documentRepo, syncMetadataRepo });

    // T_A allocated 1 but has not committed; T_B allocated 2 and committed.
    const lateRow = row(1, 'doc-late');
    feed.visible.push(row(2, 'doc-early'));

    expect((await pull.pullBatch(userId)).newCursor).toBe(2);

    feed.visible.push(lateRow); // T_A commits after the client advanced
    expect((await pull.pullBatch(userId)).pulledCount).toBe(0);
    expect(await documentRepo.getById('doc-late')).toBeNull(); // permanently skipped
  });

  it('with the per-user lock, a later transaction cannot allocate until the earlier one commits, so nothing is skipped', async () => {
    const feed = createFeed();
    const server = createSerializedServer(feed);
    const pull = new PullEngine({ db, supabaseClient: feed.client, documentRepo, syncMetadataRepo });

    const txA = server.begin();
    const txB = server.begin();

    await txA.insert('doc-a'); // A holds the lock with sequence 1
    let bAllocated = false;
    const bInsert = txB.insert('doc-b').then(() => { bAllocated = true; });

    await Promise.resolve();
    expect(bAllocated).toBe(false); // B is blocked behind A's lock

    // A client pull while A is still open sees nothing and does not advance.
    expect((await pull.pullBatch(userId)).newCursor).toBe(0);

    txA.commit();
    await bInsert;
    expect(bAllocated).toBe(true);

    // B committed first would be the dangerous order; here B's sequence (2)
    // was allocated only after A (1) became visible.
    expect((await pull.pullBatch(userId)).newCursor).toBe(1);
    txB.commit();
    expect((await pull.pullBatch(userId)).newCursor).toBe(2);

    expect(await documentRepo.getById('doc-a')).not.toBeNull();
    expect(await documentRepo.getById('doc-b')).not.toBeNull();
  });

  it('migration takes the per-user advisory lock before the sync_changes INSERT that allocates the sequence', () => {
    const sql = fs.readFileSync(
      path.resolve(process.cwd(), 'supabase/migrations/20261020100000_commit_ordered_sync_changes.sql'),
      'utf-8'
    );
    const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.record_sync_change()'));
    const lockIdx = body.indexOf('pg_advisory_xact_lock(');
    const insertIdx = body.indexOf('INSERT INTO public.sync_changes');

    expect(lockIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(insertIdx);
    expect(body).toMatch(/hashtextextended\(\s*'artix\.sync_changes:'\s*\|\|\s*v_user_id::TEXT/);
    // Transaction-scoped (released at commit/rollback), never session-scoped.
    expect(body).not.toMatch(/pg_advisory_lock\(/);
    expect(body).toMatch(/SET search_path = public/);
  });
});
