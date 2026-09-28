import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ArtixDB, getUserArtixDB, deleteUserArtixDB } from '@/lib/local/db';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { SyncEngine } from '@/lib/sync/syncEngine';

describe('Phase 3: In-Flight Outbox Lease Lifecycle & Crash Recovery', () => {
  const testUserId = 'test-user-lease-recovery';
  let db: ArtixDB;
  let outboxRepo: OutboxRepository;
  let syncMetadataRepo: SyncMetadataRepository;

  beforeEach(() => {
    db = getUserArtixDB(testUserId);
    outboxRepo = new OutboxRepository(db);
    syncMetadataRepo = new SyncMetadataRepository(db);
  });

  afterEach(async () => {
    await deleteUserArtixDB(testUserId);
  });

  it('marks outbox entry as in_flight with lease owner and expiration', async () => {
    const entry = await outboxRepo.enqueue({
      userId: testUserId,
      projectId: 'p1',
      entityType: 'document',
      entityId: 'doc-1',
      operation: 'create',
      payload: { title: 'Test Document' },
      localRevision: 1,
    });
    expect(entry).not.toBeNull();

    const beforeMark = Date.now();
    await outboxRepo.markInFlight(entry!.id, 'tab-leader-1', 10000);

    const updated = await outboxRepo.getById(entry!.id);
    expect(updated?.state).toBe('in_flight');
    expect(updated?.leaseOwner).toBe('tab-leader-1');
    expect(updated?.leaseExpiresAt).toBeGreaterThanOrEqual(beforeMark + 10000);
  });

  it('reclaims expired in_flight leases back to pending state', async () => {
    const entry1 = await outboxRepo.enqueue({
      userId: testUserId,
      projectId: 'p1',
      entityType: 'workspace_folder',
      entityId: 'f-1',
      operation: 'create',
      payload: { name: 'Folder 1' },
      localRevision: 1,
    });

    const entry2 = await outboxRepo.enqueue({
      userId: testUserId,
      projectId: 'p1',
      entityType: 'workspace_folder',
      entityId: 'f-2',
      operation: 'create',
      payload: { name: 'Folder 2' },
      localRevision: 1,
    });

    const now = Date.now();
    // Entry 1 has expired lease (expired 5 seconds ago)
    await db.outbox.update(entry1!.id, {
      state: 'in_flight',
      leaseOwner: 'crashed-tab',
      leaseExpiresAt: now - 5000,
      updatedAt: now - 5000,
    });

    // Entry 2 has an active, non-expired lease (expires in 60 seconds)
    await db.outbox.update(entry2!.id, {
      state: 'in_flight',
      leaseOwner: 'active-worker',
      leaseExpiresAt: now + 60000,
      updatedAt: now,
    });

    const recoveredCount = await outboxRepo.recoverStaleLeases(now);
    expect(recoveredCount).toBe(1);

    // Entry 1 should be restored to pending with cleared lease
    const recoveredEntry1 = await outboxRepo.getById(entry1!.id);
    expect(recoveredEntry1?.state).toBe('pending');
    expect(recoveredEntry1?.leaseOwner).toBeNull();
    expect(recoveredEntry1?.leaseExpiresAt).toBeNull();

    // Entry 2 should remain in_flight
    const activeEntry2 = await outboxRepo.getById(entry2!.id);
    expect(activeEntry2?.state).toBe('in_flight');
    expect(activeEntry2?.leaseOwner).toBe('active-worker');
  });

  it('reclaims in_flight leases where leaseExpiresAt is undefined (legacy crash recovery)', async () => {
    const entry = await outboxRepo.enqueue({
      userId: testUserId,
      projectId: 'p1',
      entityType: 'document',
      entityId: 'doc-legacy',
      operation: 'update',
      payload: { content: 'hello' },
      localRevision: 2,
    });

    // Simulate entry marked in_flight by older code without leaseExpiresAt
    await db.outbox.update(entry!.id, {
      state: 'in_flight',
      leaseExpiresAt: undefined,
    });

    const recovered = await outboxRepo.recoverStaleLeases();
    expect(recovered).toBe(1);

    const rechecked = await outboxRepo.getById(entry!.id);
    expect(rechecked?.state).toBe('pending');
  });

  it('SyncEngine recovers stale in-flight leases on startup', async () => {
    // Insert a crashed in-flight mutation into outbox
    const entry = await outboxRepo.enqueue({
      userId: testUserId,
      projectId: 'p1',
      entityType: 'system_design',
      entityId: 'design-crashed',
      operation: 'create',
      payload: { name: 'Crashed Design' },
      localRevision: 1,
    });

    const expiredTimestamp = Date.now() - 10000;
    await db.outbox.update(entry!.id, {
      state: 'in_flight',
      leaseOwner: 'dead-process',
      leaseExpiresAt: expiredTimestamp,
    });

    // Verify it is currently in_flight
    const beforeEngine = await outboxRepo.getById(entry!.id);
    expect(beforeEngine?.state).toBe('in_flight');

    // Instantiate SyncEngine (should trigger recovery on startup)
    const mockSupabase = {
      from: () => ({
        select: () => Promise.resolve({ data: [], error: null }),
        insert: () => Promise.resolve({ data: null, error: null }),
      }),
    };

    const engine = new SyncEngine({
      supabaseClient: mockSupabase,
      outboxRepo,
      syncMetadataRepo,
    });

    // Wait microtask tick for async startup recovery promise
    await new Promise((resolve) => setTimeout(resolve, 50));

    const afterEngine = await outboxRepo.getById(entry!.id);
    expect(afterEngine?.state).toBe('pending');

    engine.destroy();
  });
});
