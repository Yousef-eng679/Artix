import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ArtixDB } from '@/lib/local/db';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { SyncEngine } from '@/lib/sync/syncEngine';

describe('Phase C3: Revision-Safe Acknowledgements', () => {
  let db: ArtixDB;
  let docRepo: DocumentRepository;
  let outboxRepo: OutboxRepository;
  let syncMetadataRepo: SyncMetadataRepository;
  let conflictRepo: ConflictRepository;

  const userId = 'user-rev-safe';
  const projectId = 'proj-rev-safe';

  beforeEach(async () => {
    db = new ArtixDB(`TestDB_RevSafe_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
    await db.open();

    outboxRepo = new OutboxRepository(db);
    syncMetadataRepo = new SyncMetadataRepository(db);
    conflictRepo = new ConflictRepository(db);
    docRepo = new DocumentRepository(db, outboxRepo, syncMetadataRepo);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('marks entity synced when ack.localRevision === current.localRevision', async () => {
    await syncMetadataRepo.upsert({
      entityType: 'document',
      entityId: 'doc-1',
      userId,
      syncState: 'pending',
      localRevision: 1,
    });

    const { isFullySynced, metadata } = await syncMetadataRepo.acknowledgePush({
      entityType: 'document',
      entityId: 'doc-1',
      userId,
      ackLocalRevision: 1,
      serverVersion: '1',
      serverUpdatedAt: '2026-09-28T14:00:00Z',
    });

    expect(isFullySynced).toBe(true);
    expect(metadata.syncState).toBe('synced');
    expect(metadata.localRevision).toBe(1);
    expect(metadata.serverVersion).toBe('1');
  });

  it('keeps entity pending and preserves newest revision when newer edit occurs while push is in flight', async () => {
    // 1. Initial entity at revision 1
    await syncMetadataRepo.upsert({
      entityType: 'document',
      entityId: 'doc-concurrent',
      userId,
      syncState: 'pending',
      localRevision: 1,
    });

    // 2. While push of rev 1 is in-flight, a local edit occurs -> advances localRevision to 2
    await syncMetadataRepo.markPending('document', 'doc-concurrent', userId, 2);

    // 3. Server acknowledges revision 1
    const { isFullySynced, metadata } = await syncMetadataRepo.acknowledgePush({
      entityType: 'document',
      entityId: 'doc-concurrent',
      userId,
      ackLocalRevision: 1, // older revision
      serverVersion: '1',
      serverUpdatedAt: '2026-09-28T14:00:00Z',
    });

    // 4. Invariant checks
    expect(isFullySynced).toBe(false);
    expect(metadata.syncState).toBe('pending');
    expect(metadata.localRevision).toBe(2); // must NOT roll back to 1
    expect(metadata.serverVersion).toBe('1'); // must record server version
  });

  it('SyncEngine handles interleaved local edit during in-flight push, refreshes next baseline, and reaches synced state', async () => {
    let serverDocVersion = 0;
    let pushCount = 0;
    const pushedMutations: any[] = [];

    // Mock Supabase with sequential version increments
    const mockSupabase = {
      from: (table: string) => {
        if (table === 'processed_mutations') {
          return {
            select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
            upsert: () => Promise.resolve({ error: null }),
          };
        }
        if (table === 'documents') {
          return {
            upsert: (payload: any) => ({
              select: () => ({
                single: () => {
                  pushCount++;
                  serverDocVersion++;
                  pushedMutations.push({ payload, version: serverDocVersion });
                  return Promise.resolve({
                    data: { version: serverDocVersion, updated_at: new Date().toISOString() },
                    error: null,
                  });
                },
              }),
            }),
            update: (payload: any) => {
              const makeBuilder = (): any => ({
                eq: (_col: string, _val: any) => makeBuilder(),
                select: () => ({
                  maybeSingle: () => {
                    pushCount++;
                    serverDocVersion++;
                    pushedMutations.push({ payload, version: serverDocVersion });
                    return Promise.resolve({
                      data: { version: serverDocVersion, updated_at: new Date().toISOString() },
                      error: null,
                    });
                  },
                  single: () => {
                    pushCount++;
                    serverDocVersion++;
                    pushedMutations.push({ payload, version: serverDocVersion });
                    return Promise.resolve({
                      data: { version: serverDocVersion, updated_at: new Date().toISOString() },
                      error: null,
                    });
                  },
                }),
              });
              return makeBuilder();
            },
          };
        }
        return {};
      },
    };

    const syncEngine = new SyncEngine({
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
      conflictRepo,
    });

    // 1. Create document offline (localRevision 1, operation create)
    const doc = await docRepo.create({
      userId,
      projectId,
      title: 'Document Pipelined',
      content: 'Revision 1 Content',
    });

    expect(doc.localRevision).toBe(1);

    // 2. Simulate in-flight push for Revision 1
    const pendingBefore = await outboxRepo.getPending(undefined, userId);
    expect(pendingBefore.length).toBe(1);
    const rev1Entry = pendingBefore[0];
    await outboxRepo.markInFlight(rev1Entry.id, 'tab-test', 30000);

    // 3. User edits document while Rev 1 is in-flight -> creates Rev 2 entry in outbox
    const updatedDoc = await docRepo.update(doc.id, {
      title: 'Document Pipelined (Rev 2)',
    });
    expect(updatedDoc.localRevision).toBe(2);

    const pendingAfter = await outboxRepo.getPending(undefined, userId);
    expect(pendingAfter.length).toBe(1);
    const rev2Entry = pendingAfter[0];
    expect(rev2Entry.localRevision).toBe(2);
    expect(rev2Entry.operation).toBe('update');

    // 4. Reset rev1 back to pending to simulate push drain
    await db.outbox.update(rev1Entry.id, { state: 'pending', leaseOwner: null });

    // 5. Trigger sync drain:
    // Rev 1 will drain first.
    // When Rev 1 is acknowledged (serverVersion = '1'), acknowledgePush will see localRevision is 2.
    // It will keep syncState as 'pending', and refresh Rev 2's baseServerVersion to '1'!
    // Rev 2 will then drain using baseServerVersion '1'!
    await syncEngine.triggerSync(userId);

    // 6. Verify final state
    expect(pushCount).toBe(2);

    const finalMeta = await syncMetadataRepo.get('document', doc.id);
    expect(finalMeta?.syncState).toBe('synced');
    expect(finalMeta?.serverVersion).toBe('2');
    expect(finalMeta?.localRevision).toBe(2);

    const remainingOutbox = await outboxRepo.getPending(undefined, userId);
    expect(remainingOutbox.length).toBe(0);
  });
});
