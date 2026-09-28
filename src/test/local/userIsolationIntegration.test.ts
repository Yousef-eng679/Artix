import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getUserArtixDB, closeAllArtixDBs, deleteUserArtixDB } from '@/lib/local/db';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { SystemDesignRepository } from '@/lib/repositories/systemDesignRepository';
import { WorkspaceFolderRepository } from '@/lib/repositories/folderRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';

describe('Phase 2 Integration: Physical Cross-User IndexedDB Isolation', () => {
  const userAlice = 'user-alice-uuid-111';
  const userBob = 'user-bob-uuid-222';
  const projectId = 'proj-shared-name';

  beforeEach(async () => {
    await closeAllArtixDBs();
    await deleteUserArtixDB(userAlice);
    await deleteUserArtixDB(userBob);
  });

  afterEach(async () => {
    await closeAllArtixDBs();
    await deleteUserArtixDB(userAlice);
    await deleteUserArtixDB(userBob);
  });

  it('guarantees complete physical isolation across documents, designs, folders, and outbox', async () => {
    // 1. User Alice creates resources
    const dbAlice = getUserArtixDB(userAlice);
    const outboxAlice = new OutboxRepository(dbAlice);
    const docRepoAlice = new DocumentRepository(dbAlice, outboxAlice);
    const folderRepoAlice = new WorkspaceFolderRepository(dbAlice, outboxAlice);
    const designRepoAlice = new SystemDesignRepository(dbAlice, outboxAlice);

    const folderAlice = await folderRepoAlice.create({
      userId: userAlice,
      projectId,
      name: 'Alice Secret Vault',
    });

    const docAlice = await docRepoAlice.create({
      userId: userAlice,
      projectId,
      title: 'Alice Private Document',
      content: '# Financials\nStrictly confidential.',
      format: 'markdown',
      folderId: folderAlice.id,
    });

    const designAlice = await designRepoAlice.create({
      userId: userAlice,
      projectId,
      name: 'Alice Core Architecture',
      folderId: folderAlice.id,
    });

    // Verify Alice has 3 pending outbox entries
    const alicePending = await outboxAlice.getPending(10, userAlice);
    expect(alicePending).toHaveLength(3);

    // 2. User Bob accesses the system on the same device/browser
    const dbBob = getUserArtixDB(userBob);
    const outboxBob = new OutboxRepository(dbBob);
    const docRepoBob = new DocumentRepository(dbBob, outboxBob);
    const folderRepoBob = new WorkspaceFolderRepository(dbBob, outboxBob);
    const designRepoBob = new SystemDesignRepository(dbBob, outboxBob);

    // Bob tries to list all resources
    const bobFolders = await folderRepoBob.listByProject(userBob, projectId);
    const bobDocs = await docRepoBob.listByProject(userBob, projectId);
    const bobDesigns = await designRepoBob.listByProject(userBob, projectId);
    const bobPending = await outboxBob.getPending(10, userBob);

    // Assert: Bob sees NOTHING from Alice
    expect(bobFolders).toHaveLength(0);
    expect(bobDocs).toHaveLength(0);
    expect(bobDesigns).toHaveLength(0);
    expect(bobPending).toHaveLength(0);

    // Even if Bob attempts to get by Alice's direct ID in Bob's DB:
    expect(await docRepoBob.getById(docAlice.id)).toBeNull();
    expect(await folderRepoBob.getById(folderAlice.id)).toBeNull();
    expect(await designRepoBob.getById(designAlice.id)).toBeNull();

    // 3. Bob creates a document with the EXACT same ID or title
    const docBob = await docRepoBob.create({
      id: docAlice.id, // ID collision attempt in separate physical databases
      userId: userBob,
      projectId,
      title: 'Bob Independent Document',
      content: 'Bob content',
      format: 'markdown',
    });

    expect(docBob.id).toBe(docAlice.id);
    expect(docBob.title).toBe('Bob Independent Document');

    // 4. Alice returns and verifies her document was completely untouched
    const aliceDocReloaded = await docRepoAlice.getById(docAlice.id);
    expect(aliceDocReloaded?.title).toBe('Alice Private Document');
    expect(aliceDocReloaded?.content).toBe('# Financials\nStrictly confidential.');
    expect(aliceDocReloaded?.userId).toBe(userAlice);

    // Bob still sees his version
    const bobDocReloaded = await docRepoBob.getById(docAlice.id);
    expect(bobDocReloaded?.title).toBe('Bob Independent Document');
    expect(bobDocReloaded?.userId).toBe(userBob);
  });
});
