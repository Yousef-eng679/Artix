import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ArtixDB } from '@/lib/local/db';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { SystemDesignRepository } from '@/lib/repositories/systemDesignRepository';
import { FolderRepository } from '@/lib/repositories/folderRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { SyncEngine } from '@/lib/sync/syncEngine';
import { DocumentPushAdapter } from '@/lib/sync/adapters/documentPushAdapter';

describe('Phase C2: Correct CAS Baseline Propagation & Delete Guard', () => {
  let db: ArtixDB;
  let docRepo: DocumentRepository;
  let designRepo: SystemDesignRepository;
  let folderRepo: FolderRepository;
  let outboxRepo: OutboxRepository;
  let syncMetadataRepo: SyncMetadataRepository;
  let conflictRepo: ConflictRepository;

  const userId = 'user-cas-baseline';
  const projectId = 'proj-cas-baseline';

  beforeEach(async () => {
    db = new ArtixDB(`TestDB_CASBaseline_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
    await db.open();

    outboxRepo = new OutboxRepository(db);
    syncMetadataRepo = new SyncMetadataRepository(db);
    conflictRepo = new ConflictRepository(db);

    docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);
    designRepo = new SystemDesignRepository(db, outboxRepo, syncMetadataRepo);
    folderRepo = new FolderRepository(db, outboxRepo, syncMetadataRepo);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('captures authoritative serverVersion into outbox baseServerVersion when editing a document', async () => {
    // 1. Ingest remote document with version 5
    await docRepo.applyRemoteSnapshot({
      id: 'doc-remote-5',
      userId,
      projectId,
      title: 'Remote Doc v5',
      content: 'Initial v5 content',
      serverVersion: '5',
      updatedAt: '2026-09-28T12:00:00Z',
    });

    const meta = await syncMetadataRepo.get('document', 'doc-remote-5');
    expect(meta?.serverVersion).toBe('5');

    // 2. User edits locally
    await docRepo.update('doc-remote-5', { title: 'Local Edit after v5' });

    // 3. Verify outbox entry carries baseServerVersion = '5'
    const pending = await outboxRepo.getPending(undefined, userId);
    expect(pending.length).toBe(1);
    expect(pending[0].entityId).toBe('doc-remote-5');
    expect(pending[0].operation).toBe('update');
    expect(pending[0].baseServerVersion).toBe('5');
  });

  it('preserves baseServerVersion across multiple local compactions and deletes', async () => {
    // 1. Ingest remote document with version 7
    await docRepo.applyRemoteSnapshot({
      id: 'doc-remote-7',
      userId,
      projectId,
      title: 'Remote Doc v7',
      content: 'Initial v7 content',
      serverVersion: '7',
      updatedAt: '2026-09-28T12:00:00Z',
    });

    // 2. First edit
    await docRepo.update('doc-remote-7', { title: 'Edit 1' });
    // 3. Second edit
    await docRepo.update('doc-remote-7', { content: 'Edit 2' });

    let pending = await outboxRepo.getPending(undefined, userId);
    expect(pending.length).toBe(1);
    expect(pending[0].baseServerVersion).toBe('7');

    // 4. Soft delete
    await docRepo.delete('doc-remote-7');

    pending = await outboxRepo.getPending(undefined, userId);
    expect(pending.length).toBe(1);
    expect(pending[0].operation).toBe('delete');
    expect(pending[0].baseServerVersion).toBe('7');
  });

  it('keeps baseServerVersion null for brand new offline created entities', async () => {
    // 1. Create document offline
    const doc = await docRepo.create({
      userId,
      projectId,
      title: 'Offline Doc',
      content: 'Offline body',
    });

    // 2. Verify initial outbox entry has null baseServerVersion
    let pending = await outboxRepo.getPending(undefined, userId);
    expect(pending.length).toBe(1);
    expect(pending[0].operation).toBe('create');
    expect(pending[0].baseServerVersion).toBeNull();

    // 3. Edit offline before any sync
    await docRepo.update(doc.id, { title: 'Offline Doc Edited' });

    pending = await outboxRepo.getPending(undefined, userId);
    expect(pending.length).toBe(1);
    expect(pending[0].operation).toBe('create');
    expect(pending[0].baseServerVersion).toBeNull();
  });

  it('propagates baseServerVersion in system design repository update and delete', async () => {
    // 1. Ingest remote system design at version 12
    await designRepo.applyRemoteSnapshot({
      id: 'design-remote-12',
      userId,
      projectId,
      name: 'Architecture v12',
      serverVersion: '12',
      updatedAt: '2026-09-28T12:00:00Z',
    });

    // 2. User edits
    await designRepo.update('design-remote-12', { name: 'Architecture v12 Modified' });

    let pending = await outboxRepo.getPending(undefined, userId);
    expect(pending.length).toBe(1);
    expect(pending[0].entityType).toBe('system_design');
    expect(pending[0].baseServerVersion).toBe('12');

    // 3. User deletes
    await designRepo.delete('design-remote-12');

    pending = await outboxRepo.getPending(undefined, userId);
    expect(pending.length).toBe(1);
    expect(pending[0].operation).toBe('delete');
    expect(pending[0].baseServerVersion).toBe('12');
  });

  it('propagates baseServerVersion in folder repository rename, update, and delete', async () => {
    // 1. Ingest remote folder at version 3
    await folderRepo.applyRemoteSnapshot({
      id: 'folder-remote-3',
      userId,
      projectId,
      name: 'Folder v3',
      serverVersion: '3',
      updatedAt: '2026-09-28T12:00:00Z',
    });

    // 2. Rename folder
    await folderRepo.rename('folder-remote-3', 'Folder v3 Renamed');

    let pending = await outboxRepo.getPending(undefined, userId);
    expect(pending.length).toBe(1);
    expect(pending[0].entityType).toBe('workspace_folder');
    expect(pending[0].baseServerVersion).toBe('3');

    // 3. Delete folder
    await folderRepo.delete('folder-remote-3');

    pending = await outboxRepo.getPending(undefined, userId);
    expect(pending.length).toBe(1);
    expect(pending[0].operation).toBe('delete');
    expect(pending[0].baseServerVersion).toBe('3');
  });

  it('DocumentPushAdapter delete detects stale deletion when remote version has moved forward', async () => {
    const adapter = new DocumentPushAdapter();

    // Mock Supabase: delete with version check returns 0 rows, and subsequent select confirms remote row moved to version 6
    const mockSupabase = {
      from: (table: string) => {
        if (table === 'processed_mutations') {
          return {
            select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
            upsert: () => Promise.resolve({ error: null }),
          };
        }
        return {
          delete: () => ({
            eq: (_col: string, val: any) => ({
              eq: (_col2: string, _val2: any) => ({
                select: () => Promise.resolve({ data: [], error: null }), // 0 rows deleted
              }),
            }),
          }),
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { id: 'doc-stale-del', version: 6 }, error: null }),
              single: () => Promise.resolve({ data: { id: 'doc-stale-del', version: 6 }, error: null }),
            }),
          }),
        };
      },
    };

    const outboxEntry = {
      id: 'entry-del-1',
      mutationId: 'mut-del-1',
      userId,
      projectId,
      entityType: 'document' as const,
      entityId: 'doc-stale-del',
      operation: 'delete' as const,
      baseServerVersion: '5', // client thought it was version 5
      localRevision: 2,
      payload: null,
      state: 'in_flight' as const,
      attemptCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await expect(adapter.push(outboxEntry, mockSupabase)).rejects.toThrow(/Conflict detected: document 'doc-stale-del' was modified remotely before delete/);
  });

  it('SyncEngine records 3-way conflict and blocks outbox entry when delete is rejected by CAS guard', async () => {
    // 1. Ingest document at version 5
    await docRepo.applyRemoteSnapshot({
      id: 'doc-conflict-del',
      userId,
      projectId,
      title: 'Doc to Delete',
      content: 'Original Content',
      serverVersion: '5',
      updatedAt: '2026-09-28T12:00:00Z',
    });

    // 2. User deletes locally
    await docRepo.delete('doc-conflict-del');

    // 3. Mock remote Supabase returning 409 conflict on delete because remote row is now at version 6
    const remoteServerRow = {
      id: 'doc-conflict-del',
      version: 6,
      title: 'Doc to Delete (Modified concurrently on another device)',
      content: 'New content from device B',
      updated_at: '2026-09-28T13:00:00Z',
    };

    const mockSupabase = {
      from: (table: string) => {
        if (table === 'processed_mutations') {
          return {
            select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
            upsert: () => Promise.resolve({ error: null }),
          };
        }
        return {
          delete: () => ({
            eq: () => ({
              eq: () => ({
                select: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          }),
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: remoteServerRow, error: null }),
              single: () => Promise.resolve({ data: remoteServerRow, error: null }),
            }),
          }),
        };
      },
    };

    const syncEngine = new SyncEngine({
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
    });

    // 4. Trigger drain
    await syncEngine.triggerSync(userId);

    // 5. Verify Conflict was recorded
    const conflicts = await conflictRepo.listByEntity('document', 'doc-conflict-del', userId);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].entityId).toBe('doc-conflict-del');
    expect(conflicts[0].remotePayload).toEqual(remoteServerRow);

    // 6. Verify sync_metadata is marked 'conflict'
    const meta = await syncMetadataRepo.get('document', 'doc-conflict-del');
    expect(meta?.syncState).toBe('conflict');

    // 7. Verify outbox entry is marked 'blocked'
    const pending = await outboxRepo.getPending(undefined, userId);
    expect(pending.length).toBe(0); // blocked entries are not pending
    const allEntries = await db.outbox.toArray();
    expect(allEntries[0].state).toBe('blocked');
  });
});
