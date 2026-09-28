import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ArtixDB, getUserArtixDB, deleteUserArtixDB } from '@/lib/local/db';
import { WorkspaceFolderRepository } from '@/lib/repositories/folderRepository';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { SystemDesignRepository } from '@/lib/repositories/systemDesignRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';

describe('Phase 3: Atomic Mutation Architecture & Remote Reconciliation', () => {
  const testUserId = 'test-user-atomic-phase3';
  let db: ArtixDB;
  let outboxRepo: OutboxRepository;
  let syncMetadataRepo: SyncMetadataRepository;
  let folderRepo: WorkspaceFolderRepository;
  let docRepo: DocumentRepository;
  let designRepo: SystemDesignRepository;

  beforeEach(() => {
    db = getUserArtixDB(testUserId);
    outboxRepo = new OutboxRepository(db);
    syncMetadataRepo = new SyncMetadataRepository(db);
    folderRepo = new WorkspaceFolderRepository(db, outboxRepo, syncMetadataRepo);
    docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);
    designRepo = new SystemDesignRepository(db, outboxRepo, syncMetadataRepo);
  });

  afterEach(async () => {
    await deleteUserArtixDB(testUserId);
  });

  it('atomically commits folder, outbox entry, and sync metadata on folder creation', async () => {
    const folder = await folderRepo.create({
      userId: testUserId,
      projectId: 'proj-1',
      name: 'Design Assets',
    });

    expect(folder.id).toBeDefined();
    expect(folder.localRevision).toBe(1);

    // 1. Verify entity row exists
    const storedFolder = await folderRepo.getById(folder.id);
    expect(storedFolder).not.toBeNull();
    expect(storedFolder?.name).toBe('Design Assets');

    // 2. Verify outbox entry exists and is pending
    const pendingOutbox = await outboxRepo.getPending(undefined, testUserId);
    expect(pendingOutbox.length).toBe(1);
    expect(pendingOutbox[0].entityType).toBe('workspace_folder');
    expect(pendingOutbox[0].entityId).toBe(folder.id);
    expect(pendingOutbox[0].operation).toBe('create');
    expect(pendingOutbox[0].localRevision).toBe(1);

    // 3. Verify sync metadata exists and is pending
    const metadata = await syncMetadataRepo.get('workspace_folder', folder.id);
    expect(metadata).toBeDefined();
    expect(metadata?.syncState).toBe('pending');
    expect(metadata?.localRevision).toBe(1);
  });

  it('atomically commits document, outbox entry, and sync metadata on document creation', async () => {
    const doc = await docRepo.create({
      userId: testUserId,
      projectId: 'proj-1',
      title: 'Architecture Spec',
      content: '# Spec Content',
    });

    // 1. Entity
    const storedDoc = await docRepo.getById(doc.id);
    expect(storedDoc?.title).toBe('Architecture Spec');
    expect(storedDoc?.localRevision).toBe(1);

    // 2. Outbox
    const pendingOutbox = await outboxRepo.getPending(undefined, testUserId);
    expect(pendingOutbox.length).toBe(1);
    expect(pendingOutbox[0].entityType).toBe('document');
    expect(pendingOutbox[0].operation).toBe('create');
    expect(pendingOutbox[0].localRevision).toBe(1);

    // 3. Metadata
    const metadata = await syncMetadataRepo.get('document', doc.id);
    expect(metadata?.syncState).toBe('pending');
    expect(metadata?.localRevision).toBe(1);
  });

  it('atomically commits system design, outbox entry, and sync metadata on design creation', async () => {
    const design = await designRepo.create({
      userId: testUserId,
      projectId: 'proj-1',
      name: 'Network Topology',
      boardState: { nodes: [{ id: 'n1', type: 'service', position: { x: 0, y: 0 }, data: { label: 'Auth' } }], edges: [] },
    });

    // 1. Entity
    const storedDesign = await designRepo.getById(design.id);
    expect(storedDesign?.name).toBe('Network Topology');

    // 2. Outbox
    const pendingOutbox = await outboxRepo.getPending(undefined, testUserId);
    expect(pendingOutbox.length).toBe(1);
    expect(pendingOutbox[0].entityType).toBe('system_design');
    expect(pendingOutbox[0].operation).toBe('create');

    // 3. Metadata
    const metadata = await syncMetadataRepo.get('system_design', design.id);
    expect(metadata?.syncState).toBe('pending');
  });

  it('atomically rolls back all 3 tables if a transaction aborts or fails duplicate constraints', async () => {
    // Create initial folder
    await folderRepo.create({
      userId: testUserId,
      projectId: 'proj-1',
      name: 'Existing Folder',
    });

    const initialPendingCount = (await outboxRepo.getPending(undefined, testUserId)).length;
    expect(initialPendingCount).toBe(1);

    // Attempting to create duplicate folder within the same project must throw DuplicateNameError
    await expect(
      folderRepo.create({
        userId: testUserId,
        projectId: 'proj-1',
        name: 'Existing Folder',
      })
    ).rejects.toThrow(/already exists/);

    // Verify outbox was NOT modified
    const outboxAfter = await outboxRepo.getPending(undefined, testUserId);
    expect(outboxAfter.length).toBe(1);

    // Verify only 1 folder exists in the project
    const folders = await folderRepo.listByProject(testUserId, 'proj-1');
    expect(folders.length).toBe(1);
  });

  it('applyRemoteSnapshot updates local entity and marks sync metadata as synced with ZERO outbox mutations', async () => {
    const remoteId = 'remote-folder-uuid-999';

    // Apply remote snapshot from Supabase reconciliation
    const folder = await folderRepo.applyRemoteSnapshot({
      id: remoteId,
      userId: testUserId,
      projectId: 'proj-cloud',
      name: 'Cloud Ingested Folder',
      serverVersion: 'v123',
      updatedAt: '2026-09-28T12:00:00.000Z',
      createdAt: '2026-09-28T10:00:00.000Z',
    });

    expect(folder.id).toBe(remoteId);
    expect(folder.name).toBe('Cloud Ingested Folder');

    // 1. Verify entity exists in local IndexedDB
    const stored = await folderRepo.getById(remoteId);
    expect(stored).not.toBeNull();
    expect(stored?.name).toBe('Cloud Ingested Folder');

    // 2. CRITICAL: Verify outbox has 0 items (never push remote snapshots back to cloud)
    const outboxEntries = await outboxRepo.getPending(undefined, testUserId);
    expect(outboxEntries.length).toBe(0);

    // 3. Verify sync metadata is recorded as synced and stores baseSnapshot
    const metadata = await syncMetadataRepo.get('workspace_folder', remoteId);
    expect(metadata).toBeDefined();
    expect(metadata?.syncState).toBe('synced');
    expect(metadata?.serverVersion).toBe('v123');
    expect(metadata?.baseSnapshot).toBeDefined();
    expect((metadata?.baseSnapshot as any).name).toBe('Cloud Ingested Folder');
  });

  it('atomically tracks updates and bumps localRevision across entity, outbox, and sync metadata', async () => {
    const doc = await docRepo.create({
      userId: testUserId,
      projectId: 'proj-1',
      title: 'Revision 1 Title',
      content: 'Initial text',
    });

    // Clear outbox to isolate the update mutation
    await outboxRepo.clear(testUserId);

    const updatedDoc = await docRepo.update(doc.id, {
      title: 'Revision 2 Title',
      content: 'Updated text content',
    });

    expect(updatedDoc.localRevision).toBe(2);

    // 1. Entity
    const storedDoc = await docRepo.getById(doc.id);
    expect(storedDoc?.localRevision).toBe(2);
    expect(storedDoc?.title).toBe('Revision 2 Title');

    // 2. Outbox
    const pending = await outboxRepo.getPending(undefined, testUserId);
    expect(pending.length).toBe(1);
    expect(pending[0].operation).toBe('update');
    expect(pending[0].localRevision).toBe(2);

    // 3. Metadata
    const metadata = await syncMetadataRepo.get('document', doc.id);
    expect(metadata?.syncState).toBe('pending');
    expect(metadata?.localRevision).toBe(2);
  });

  it('atomically marks soft-delete in entity, records delete outbox mutation, and updates sync metadata', async () => {
    const doc = await docRepo.create({
      userId: testUserId,
      projectId: 'proj-1',
      title: 'Doc to Delete',
      content: 'To be deleted',
    });

    await outboxRepo.clear(testUserId);

    await docRepo.delete(doc.id);

    // 1. Entity soft deleted
    const activeDoc = await docRepo.getById(doc.id);
    expect(activeDoc).toBeNull();

    const rawDoc = await docRepo.getByIdIncludeDeleted(doc.id);
    expect(rawDoc?.isDeleted).toBe(true);
    expect(rawDoc?.localRevision).toBe(2);

    // 2. Outbox has delete mutation
    const pending = await outboxRepo.getPending(undefined, testUserId);
    expect(pending.length).toBe(1);
    expect(pending[0].operation).toBe('delete');
    expect(pending[0].localRevision).toBe(2);

    // 3. Metadata updated
    const metadata = await syncMetadataRepo.get('document', doc.id);
    expect(metadata?.syncState).toBe('pending');
    expect(metadata?.localRevision).toBe(2);
  });
});
