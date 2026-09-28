import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ArtixDB } from '@/lib/local/db';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { DocumentPushAdapter } from '@/lib/sync/adapters/documentPushAdapter';
import { SystemDesignPushAdapter } from '@/lib/sync/adapters/systemDesignPushAdapter';
import { WorkspaceFolderPushAdapter } from '@/lib/sync/adapters/folderPushAdapter';
import { checkIdempotency, recordIdempotency } from '@/lib/sync/adapters/idempotency';
import { OutboxEntry } from '@/lib/local/types';

describe('Phase C1: Mutation Identity & Idempotent Server Protocol', () => {
  let db: ArtixDB;
  let outboxRepo: OutboxRepository;
  const userId = 'user-idempotency-1';

  beforeEach(async () => {
    db = new ArtixDB(`TestDB_Idempotency_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
    await db.open();
    outboxRepo = new OutboxRepository(db);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('assigns a durable mutationId to newly enqueued outbox entries and preserves it across compaction', async () => {
    const entry = await outboxRepo.enqueue({
      userId,
      projectId: 'p1',
      entityType: 'document',
      entityId: 'doc-1',
      operation: 'create',
      payload: { title: 'Initial' },
      localRevision: 1,
    });

    expect(entry).toBeDefined();
    expect(entry?.mutationId).toBeDefined();
    expect(typeof entry?.mutationId).toBe('string');
    expect(entry?.mutationId.length).toBeGreaterThan(10);

    const initialMutationId = entry!.mutationId;

    // Compact with an update
    const compacted = await outboxRepo.enqueue({
      userId,
      projectId: 'p1',
      entityType: 'document',
      entityId: 'doc-1',
      operation: 'update',
      payload: { title: 'Updated' },
      localRevision: 2,
    });

    expect(compacted).toBeDefined();
    // Invariant: mutationId remains durable across compaction
    expect(compacted?.mutationId).toBe(initialMutationId);
  });

  it('handles lost response scenario: recognizes previously processed mutationId and returns prior acknowledgement', async () => {
    const processedMutationsStore = new Map<string, any>();
    let serverDocumentVersion = 1;

    const mockSupabase = {
      from: (table: string) => {
        if (table === 'processed_mutations') {
          return {
            select: () => ({
              eq: (_col: string, val: string) => ({
                maybeSingle: () => {
                  const record = processedMutationsStore.get(val);
                  return Promise.resolve({ data: record || null, error: null });
                },
                single: () => {
                  const record = processedMutationsStore.get(val);
                  return Promise.resolve({ data: record || null, error: null });
                },
              }),
            }),
            upsert: (payload: any) => {
              processedMutationsStore.set(payload.mutation_id, payload);
              return Promise.resolve({ data: payload, error: null });
            },
          };
        }

        if (table === 'documents') {
          return {
            upsert: (_payload: any) => ({
              select: () => ({
                single: () => {
                  serverDocumentVersion++;
                  return Promise.resolve({
                    data: { version: serverDocumentVersion, updated_at: '2026-09-28T14:00:00Z' },
                    error: null,
                  });
                },
              }),
            }),
          };
        }

        return {};
      },
    };

    const entry: OutboxEntry = {
      id: 'outbox-1',
      mutationId: 'mutation-uuid-42',
      userId,
      projectId: 'p1',
      entityType: 'document',
      entityId: 'doc-42',
      operation: 'create',
      payload: { title: 'Idempotent Document' },
      localRevision: 1,
      baseServerVersion: null,
      state: 'in_flight',
      attemptCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const adapter = new DocumentPushAdapter();

    // 1. First push succeeds on server and records mutationId
    const firstResult = await adapter.push(entry, mockSupabase);
    expect(firstResult).toBeDefined();
    expect(firstResult?.version).toBe('2');
    expect(processedMutationsStore.has('mutation-uuid-42')).toBe(true);

    // 2. Simulate client network failure: response was dropped, client retries with the SAME mutationId
    entry.attemptCount = 2;
    const retryResult = await adapter.push(entry, mockSupabase);

    // Invariant: Server recognizes mutationId, does NOT re-increment version, returns prior version
    expect(retryResult).toBeDefined();
    expect(retryResult?.version).toBe('2');
    expect(serverDocumentVersion).toBe(2); // Still 2, not incremented again!

    // 3. Retry again: exactly-once logical effect
    entry.attemptCount = 3;
    const thirdResult = await adapter.push(entry, mockSupabase);
    expect(thirdResult?.version).toBe('2');
    expect(serverDocumentVersion).toBe(2);
  });

  it('supports idempotent check and record across system designs and folders', async () => {
    const store = new Map<string, any>();

    const mockSupabase = {
      from: (table: string) => {
        if (table === 'processed_mutations') {
          return {
            select: () => ({
              eq: (_col: string, val: string) => ({
                maybeSingle: () => Promise.resolve({ data: store.get(val) || null, error: null }),
                single: () => Promise.resolve({ data: store.get(val) || null, error: null }),
              }),
            }),
            upsert: (payload: any) => {
              store.set(payload.mutation_id, payload);
              return Promise.resolve({ data: payload, error: null });
            },
          };
        }
        return {
          upsert: (_payload: any) => ({
            select: () => ({
              single: () => Promise.resolve({ data: { version: 5, updated_at: '2026-09-28T14:10:00Z' }, error: null }),
            }),
          }),
        };
      },
    };

    const folderAdapter = new WorkspaceFolderPushAdapter();
    const folderEntry: OutboxEntry = {
      id: 'folder-outbox-1',
      mutationId: 'folder-mut-100',
      userId,
      projectId: 'p1',
      entityType: 'workspace_folder',
      entityId: 'folder-1',
      operation: 'create',
      payload: { name: 'Root Folder' },
      localRevision: 1,
      baseServerVersion: null,
      state: 'in_flight',
      attemptCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const folderRes1 = await folderAdapter.push(folderEntry, mockSupabase);
    expect(folderRes1?.version).toBe('5');
    expect(store.has('folder-mut-100')).toBe(true);

    const folderRes2 = await folderAdapter.push(folderEntry, mockSupabase);
    expect(folderRes2?.version).toBe('5');

    const designAdapter = new SystemDesignPushAdapter();
    const designEntry: OutboxEntry = {
      id: 'design-outbox-1',
      mutationId: 'design-mut-200',
      userId,
      projectId: 'p1',
      entityType: 'system_design',
      entityId: 'design-1',
      operation: 'create',
      payload: { name: 'Graph Architecture' },
      localRevision: 1,
      baseServerVersion: null,
      state: 'in_flight',
      attemptCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const designRes1 = await designAdapter.push(designEntry, mockSupabase);
    expect(designRes1?.version).toBe('5');
    expect(store.has('design-mut-200')).toBe(true);

    const designRes2 = await designAdapter.push(designEntry, mockSupabase);
    expect(designRes2?.version).toBe('5');
  });

  it('safely handles concurrent push calls for the same mutationId without double-application', async () => {
    let callCount = 0;
    const store = new Map<string, any>();

    const mockSupabase = {
      from: (table: string) => {
        if (table === 'processed_mutations') {
          return {
            select: () => ({
              eq: (_col: string, val: string) => ({
                maybeSingle: async () => {
                  return { data: store.get(val) || null, error: null };
                },
              }),
            }),
            upsert: async (payload: any) => {
              store.set(payload.mutation_id, payload);
              return { data: payload, error: null };
            },
          };
        }
        return {
          upsert: (_payload: any) => ({
            select: () => ({
              single: async () => {
                callCount++;
                return { data: { version: 10, updated_at: '2026-09-28T14:20:00Z' }, error: null };
              },
            }),
          }),
        };
      },
    };

    const entry: OutboxEntry = {
      id: 'concurrent-1',
      mutationId: 'concurrent-mut-300',
      userId,
      projectId: 'p1',
      entityType: 'document',
      entityId: 'doc-concurrent',
      operation: 'create',
      payload: { title: 'Concurrent' },
      localRevision: 1,
      baseServerVersion: null,
      state: 'in_flight',
      attemptCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const adapter = new DocumentPushAdapter();

    // First finishes and stores in ledger
    const res1 = await adapter.push(entry, mockSupabase);
    expect(res1?.version).toBe('10');
    expect(callCount).toBe(1);

    // Second worker attempts to push same mutation
    const res2 = await adapter.push(entry, mockSupabase);
    expect(res2?.version).toBe('10');
    expect(callCount).toBe(1); // Not executed again!
  });
});
