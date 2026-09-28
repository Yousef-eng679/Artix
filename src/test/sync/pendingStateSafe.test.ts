import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ArtixDB } from '@/lib/local/db';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { PullEngine } from '@/lib/sync/pullEngine';

describe('Phase C5: Pending-State-Safe Remote Application', () => {
  let db: ArtixDB;
  let docRepo: DocumentRepository;
  let outboxRepo: OutboxRepository;
  let syncMetadataRepo: SyncMetadataRepository;
  let conflictRepo: ConflictRepository;

  const userId = 'user-pending-safe';
  const projectId = 'proj-pending-safe';

  beforeEach(async () => {
    db = new ArtixDB(`TestDB_PendingSafe_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
    await db.open();

    outboxRepo = new OutboxRepository(db);
    syncMetadataRepo = new SyncMetadataRepository(db);
    conflictRepo = new ConflictRepository(db);
    docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('preserves local pending modification when newer remote edit arrives, records conflict, and blocks outbox', async () => {
    // 1. Initial document at version 1
    await docRepo.applyRemoteSnapshot({
      id: 'doc-concurrent-edit',
      userId,
      projectId,
      title: 'Original Cloud Title',
      content: 'Original Cloud Body',
      serverVersion: '1',
      updatedAt: '2026-09-28T10:00:00Z',
    });

    // 2. User edits locally (local pending intent)
    await docRepo.update('doc-concurrent-edit', {
      title: 'Local High-Priority Edit',
      content: 'Local Body Content',
    });

    // Verify local outbox has pending entry
    const pendingBefore = await outboxRepo.getPending(undefined, userId);
    expect(pendingBefore.length).toBe(1);
    expect(pendingBefore[0].state).toBe('pending');
    expect(pendingBefore[0].baseServerVersion).toBe('1');

    // 3. Mock remote feed returning version 2 from another device
    const mockSupabase = {
      from: (table: string) => {
        if (table === 'sync_changes') {
          return {
            select: () => ({
              eq: () => ({
                gt: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({
                        data: [
                          {
                            sequence: 101,
                            entity_type: 'document',
                            entity_id: 'doc-concurrent-edit',
                            entity_version: 2,
                            operation: 'update',
                            payload: {
                              project_id: projectId,
                              title: 'Remote Device Modification',
                              content: 'Remote Body Content',
                              updated_at: '2026-09-28T11:00:00Z',
                            },
                            changed_at: '2026-09-28T11:00:00Z',
                          },
                        ],
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
    };

    const pullEngine = new PullEngine({
      supabaseClient: mockSupabase,
      db,
      documentRepo: docRepo,
      conflictRepo,
      syncMetadataRepo,
    });

    // 4. Ingest remote changes
    const result = await pullEngine.pullAll(userId);
    expect(result.totalPulled).toBe(1);

    // 5. Invariant: Local document content is PRESERVED
    const localDoc = await docRepo.getById('doc-concurrent-edit');
    expect(localDoc?.title).toBe('Local High-Priority Edit');
    expect(localDoc?.content).toBe('Local Body Content');

    // 6. Invariant: Outbox entry is BLOCKED
    const allOutbox = await db.outbox.toArray();
    expect(allOutbox[0].state).toBe('blocked');

    // 7. Invariant: 3-way conflict is recorded
    const conflicts = await conflictRepo.listByEntity('document', 'doc-concurrent-edit', userId);
    expect(conflicts.length).toBe(1);
    expect((conflicts[0].localPayload as any).title).toBe('Local High-Priority Edit');
    expect((conflicts[0].remotePayload as any).title).toBe('Remote Device Modification');

    // 8. Invariant: sync_metadata state is conflict
    const meta = await syncMetadataRepo.get('document', 'doc-concurrent-edit');
    expect(meta?.syncState).toBe('conflict');
  });

  it('silently discards stale remote snapshot (version <= baseline) without creating false conflict', async () => {
    // 1. Initial document at version 5
    await docRepo.applyRemoteSnapshot({
      id: 'doc-stale-test',
      userId,
      projectId,
      title: 'Doc Version 5',
      content: 'Content v5',
      serverVersion: '5',
      updatedAt: '2026-09-28T12:00:00Z',
    });

    // 2. User edits locally
    await docRepo.update('doc-stale-test', {
      title: 'Doc Version 5 Edited Locally',
    });

    // 3. Stale remote event arrives with version 5 (or 4)
    const mockSupabase = {
      from: (table: string) => {
        if (table === 'sync_changes') {
          return {
            select: () => ({
              eq: () => ({
                gt: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({
                        data: [
                          {
                            sequence: 102,
                            entity_type: 'document',
                            entity_id: 'doc-stale-test',
                            entity_version: 5, // Stale! <= baselineVersion 5
                            operation: 'update',
                            payload: {
                              project_id: projectId,
                              title: 'Stale Cloud Replay',
                              content: 'Stale Cloud Body',
                              updated_at: '2026-09-28T12:00:00Z',
                            },
                            changed_at: '2026-09-28T12:00:00Z',
                          },
                        ],
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
    };

    const pullEngine = new PullEngine({
      supabaseClient: mockSupabase,
      db,
      documentRepo: docRepo,
      conflictRepo,
      syncMetadataRepo,
    });

    await pullEngine.pullAll(userId);

    // Invariant: Local document preserved
    const localDoc = await docRepo.getById('doc-stale-test');
    expect(localDoc?.title).toBe('Doc Version 5 Edited Locally');

    // Invariant: NO conflict created
    const conflicts = await conflictRepo.listByEntity('document', 'doc-stale-test', userId);
    expect(conflicts.length).toBe(0);

    // Invariant: Outbox entry remains 'pending' (ready to push)
    const pending = await outboxRepo.getPending(undefined, userId);
    expect(pending.length).toBe(1);
    expect(pending[0].state).toBe('pending');
  });

  it('preserves local pending modification when remote delete arrives, records conflict, and blocks outbox', async () => {
    // 1. Initial document at version 3
    await docRepo.applyRemoteSnapshot({
      id: 'doc-remote-del',
      userId,
      projectId,
      title: 'Doc to be Deleted Remotely',
      content: 'Content v3',
      serverVersion: '3',
      updatedAt: '2026-09-28T12:00:00Z',
    });

    // 2. User edits locally
    await docRepo.update('doc-remote-del', {
      title: 'Local Edits Kept Despite Remote Delete',
    });

    // 3. Remote delete arrives
    const mockSupabase = {
      from: (table: string) => {
        if (table === 'sync_changes') {
          return {
            select: () => ({
              eq: () => ({
                gt: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({
                        data: [
                          {
                            sequence: 103,
                            entity_type: 'document',
                            entity_id: 'doc-remote-del',
                            entity_version: 4,
                            operation: 'delete',
                            payload: {},
                            changed_at: '2026-09-28T13:00:00Z',
                          },
                        ],
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
    };

    const pullEngine = new PullEngine({
      supabaseClient: mockSupabase,
      db,
      documentRepo: docRepo,
      conflictRepo,
      syncMetadataRepo,
    });

    await pullEngine.pullAll(userId);

    // Invariant: Document is NOT deleted locally
    const localDoc = await docRepo.getById('doc-remote-del');
    expect(localDoc).not.toBeNull();
    expect(localDoc?.title).toBe('Local Edits Kept Despite Remote Delete');

    // Invariant: Outbox entry is BLOCKED
    const allOutbox = await db.outbox.toArray();
    expect(allOutbox[0].state).toBe('blocked');

    // Invariant: Conflict recorded with remotePayload deleted: true
    const conflicts = await conflictRepo.listByEntity('document', 'doc-remote-del', userId);
    expect(conflicts.length).toBe(1);
    expect((conflicts[0].remotePayload as any).deleted).toBe(true);
  });

  it('defense-in-depth: repository applyRemoteSnapshot rejects overwrite when active outbox exists unless forced', async () => {
    // 1. Create document with pending outbox
    const doc = await docRepo.create({
      userId,
      projectId,
      title: 'Local In-Progress Work',
      content: 'Draft 1',
    });

    // 2. Direct call to applyRemoteSnapshot without force
    const result = await docRepo.applyRemoteSnapshot({
      id: doc.id,
      userId,
      projectId,
      title: 'Rogue Remote Overwrite',
      content: 'Overwritten',
      serverVersion: '10',
    });

    // Invariant: returned document is local and IndexedDB not overwritten
    expect(result.title).toBe('Local In-Progress Work');
    const stored = await docRepo.getById(doc.id);
    expect(stored?.title).toBe('Local In-Progress Work');

    // 3. Direct call with force: true allows overwrite
    const forced = await docRepo.applyRemoteSnapshot(
      {
        id: doc.id,
        userId,
        projectId,
        title: 'Forced Cloud Overwrite',
        content: 'Forced Overwritten',
        serverVersion: '10',
      },
      { force: true }
    );

    expect(forced.title).toBe('Forced Cloud Overwrite');
    const storedForced = await docRepo.getById(doc.id);
    expect(storedForced?.title).toBe('Forced Cloud Overwrite');
  });
});
