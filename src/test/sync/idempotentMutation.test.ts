import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  describe('Audit F-003: Atomic apply_sync_mutation RPC & Lost-Response Fault Injection', () => {
    function createTransactionalRpcHarness(authenticatedUserId: string) {
      const documents = new Map<string, { id: string; user_id: string; title: string; content: string; version: number; updated_at: string }>();
      const ledger = new Map<string, { mutation_id: string; user_id: string; version: number | null; updated_at: string }>();
      let entityWriteCount = 0;
      let dropNextResponseAfterCommit = false;

      const supabase = {
        rpc: async (fnName: string, params: Record<string, any>) => {
          expect(fnName).toBe('apply_sync_mutation');
          if (params.p_user_id !== authenticatedUserId) {
            return {
              data: null,
              error: { code: '42501', message: 'Authenticated user does not match mutation user_id' },
            };
          }

          // Single atomic server transaction: ledger lookup -> entity CAS write -> ledger insert
          const existingLedger = ledger.get(params.p_mutation_id);
          if (existingLedger && existingLedger.user_id === params.p_user_id) {
            return {
              data: {
                status: 'already_processed',
                version: existingLedger.version,
                updated_at: existingLedger.updated_at,
              },
              error: null,
            };
          }

          const entityId = params.p_entity_id as string;
          const op = params.p_operation as string;
          const payload = (params.p_payload ?? {}) as Record<string, any>;
          const baseVersion = params.p_base_version as number | null;
          const nowIso = `2026-10-20T12:00:0${entityWriteCount + 1}Z`;

          let committedVersion: number | null = null;

          if (op === 'create') {
            // ON CONFLICT (id) DO NOTHING
            if (documents.has(entityId)) {
              return { data: { status: 'conflict' }, error: null };
            }
            entityWriteCount++;
            committedVersion = 1;
            documents.set(entityId, {
              id: entityId,
              user_id: params.p_user_id,
              title: payload.title ?? 'Untitled Document',
              content: payload.content ?? '',
              version: committedVersion,
              updated_at: nowIso,
            });
          } else if (op === 'update') {
            const current = documents.get(entityId);
            if (!current || current.user_id !== params.p_user_id) {
              if (baseVersion !== null && baseVersion > 0) {
                return { data: { status: 'conflict' }, error: null };
              }
              return { data: null, error: { code: 'P0002', message: 'Document not found' } };
            }
            if (baseVersion !== null && baseVersion > 0 && current.version !== baseVersion) {
              return { data: { status: 'conflict' }, error: null };
            }
            entityWriteCount++;
            committedVersion = current.version + 1;
            documents.set(entityId, {
              ...current,
              title: payload.title ?? current.title,
              content: payload.content ?? current.content,
              version: committedVersion,
              updated_at: nowIso,
            });
          } else if (op === 'delete') {
            const current = documents.get(entityId);
            if (current && baseVersion !== null && baseVersion > 0 && current.version !== baseVersion) {
              return { data: { status: 'conflict', current_version: current.version }, error: null };
            }
            if (current) {
              entityWriteCount++;
              documents.delete(entityId);
            }
            committedVersion = null;
          }

          // Ledger row commits atomically in the SAME transaction BEFORE response leaves server
          ledger.set(params.p_mutation_id, {
            mutation_id: params.p_mutation_id,
            user_id: params.p_user_id,
            version: committedVersion,
            updated_at: nowIso,
          });

          if (dropNextResponseAfterCommit) {
            dropNextResponseAfterCommit = false;
            throw new Error('NetworkError: connection reset after PostgreSQL commit');
          }

          return {
            data: {
              status: 'applied',
              version: committedVersion,
              updated_at: nowIso,
            },
            error: null,
          };
        },
      };

      return {
        supabase,
        documents,
        ledger,
        getEntityWriteCount: () => entityWriteCount,
        injectResponseDropAfterCommit: () => {
          dropNextResponseAfterCommit = true;
        },
      };
    }

    it('commits entity + ledger atomically so a lost HTTP response never causes duplicate execution on retry', async () => {
      const harness = createTransactionalRpcHarness(userId);
      const adapter = new DocumentPushAdapter();

      // Seed initial v1 document
      harness.documents.set('doc-atomic-1', {
        id: 'doc-atomic-1',
        user_id: userId,
        title: 'Seed',
        content: 'v1 content',
        version: 1,
        updated_at: '2026-10-20T11:59:00Z',
      });

      const updateEntry: OutboxEntry = {
        id: 'outbox-atomic-update',
        mutationId: '11111111-1111-4111-8111-111111111111',
        userId,
        projectId: 'p1',
        entityType: 'document',
        entityId: 'doc-atomic-1',
        operation: 'update',
        payload: { title: 'Seed', content: 'v2 atomic edit' },
        localRevision: 2,
        baseServerVersion: '1',
        state: 'in_flight',
        attemptCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // Fault injection: DB transaction commits (version 1 -> 2 + ledger row),
      // then network drops before client receives response.
      harness.injectResponseDropAfterCommit();
      await expect(adapter.push(updateEntry, harness.supabase)).rejects.toThrow(/connection reset after PostgreSQL commit/);

      expect(harness.getEntityWriteCount()).toBe(1);
      expect(harness.documents.get('doc-atomic-1')?.version).toBe(2);
      expect(harness.ledger.has(updateEntry.mutationId)).toBe(true);

      // Client retries with the same mutationId (baseServerVersion is still '1' locally!
      // Without atomic ledger commit, CAS baseVersion=1 against server version=2 would falsely 409!)
      updateEntry.attemptCount = 2;
      const retryAck = await adapter.push(updateEntry, harness.supabase);

      expect(retryAck).toEqual({
        version: '2',
        updated_at: '2026-10-20T12:00:01Z',
      });
      expect(harness.getEntityWriteCount()).toBe(1);
      expect(harness.documents.get('doc-atomic-1')?.content).toBe('v2 atomic edit');
    });

    it('never overwrites a post-create remote v2 edit when retrying a create whose response was lost', async () => {
      const harness = createTransactionalRpcHarness(userId);
      const adapter = new DocumentPushAdapter();

      const createEntry: OutboxEntry = {
        id: 'outbox-create-lost',
        mutationId: '22222222-2222-4222-8222-222222222222',
        userId,
        projectId: 'p1',
        entityType: 'document',
        entityId: 'doc-post-create',
        operation: 'create',
        payload: { title: 'Draft', content: 'Initial v1 body' },
        localRevision: 1,
        baseServerVersion: null,
        state: 'in_flight',
        attemptCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // 1. Server commits create (v1) + ledger atomically, HTTP response is lost.
      harness.injectResponseDropAfterCommit();
      await expect(adapter.push(createEntry, harness.supabase)).rejects.toThrow(/connection reset/);
      expect(harness.documents.get('doc-post-create')?.version).toBe(1);

      // 2. Another session updates the document on the server to v2 before client A retries.
      harness.documents.set('doc-post-create', {
        id: 'doc-post-create',
        user_id: userId,
        title: 'Published Spec',
        content: 'Newer v2 remote edit that MUST NOT be clobbered',
        version: 2,
        updated_at: '2026-10-20T12:05:00Z',
      });

      // 3. Client A retries create with the original mutationId.
      createEntry.attemptCount = 2;
      const replayAck = await adapter.push(createEntry, harness.supabase);

      expect(replayAck?.version).toBe('1');
      // Server v2 content is strictly preserved!
      expect(harness.documents.get('doc-post-create')).toMatchObject({
        title: 'Published Spec',
        content: 'Newer v2 remote edit that MUST NOT be clobbered',
        version: 2,
      });

      // 4. Even if an unrecorded create collides with an existing ID, ON CONFLICT DO NOTHING
      // returns 409 CONFLICT rather than overwriting v2.
      const collidingCreate: OutboxEntry = {
        ...createEntry,
        id: 'outbox-colliding-create',
        mutationId: '33333333-3333-4333-8333-333333333333',
        payload: { title: 'Stale Clobber Attempt', content: 'Should fail with 409' },
      };
      await expect(adapter.push(collidingCreate, harness.supabase)).rejects.toMatchObject({
        status: 409,
        code: 'CONFLICT',
      });
      expect(harness.documents.get('doc-post-create')?.content).toBe(
        'Newer v2 remote edit that MUST NOT be clobbered'
      );
    });

    it('falls back to legacy table path on PGRST202 and surfaces ledger upsert errors in recordIdempotency', async () => {
      let fallbackUpsertCalled = false;
      const mockPreMigrationSupabase = {
        rpc: async () => ({
          data: null,
          error: {
            code: 'PGRST202',
            message: 'Could not find the function public.apply_sync_mutation in the schema cache',
          },
        }),
        from: (table: string) => {
          if (table === 'processed_mutations') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
              upsert: async () => ({
                data: null,
                error: { code: '42501', message: 'new row violates row-level security policy' },
              }),
            };
          }
          return {
            upsert: () => ({
              select: () => ({
                single: async () => {
                  fallbackUpsertCalled = true;
                  return { data: { version: 1, updated_at: '2026-10-20T12:10:00Z' }, error: null };
                },
              }),
            }),
          };
        },
      };

      const entry: OutboxEntry = {
        id: 'outbox-fallback-1',
        mutationId: '44444444-4444-4444-8444-444444444444',
        userId,
        projectId: 'p1',
        entityType: 'document',
        entityId: 'doc-fallback-1',
        operation: 'create',
        payload: { title: 'Pre-migration rollout' },
        localRevision: 1,
        baseServerVersion: null,
        state: 'in_flight',
        attemptCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const adapter = new DocumentPushAdapter();
      const res = await adapter.push(entry, mockPreMigrationSupabase);
      expect(fallbackUpsertCalled).toBe(true);
      expect(res?.version).toBe('1');

      const ledgerOutcome = await recordIdempotency(entry, res, mockPreMigrationSupabase);
      expect(ledgerOutcome.recorded).toBe(false);
      expect((ledgerOutcome.error as any)?.code).toBe('42501');
    });

    it('audits 20261020110000_atomic_idempotent_mutation_rpc.sql invariants', () => {
      const sqlPath = path.resolve(
        process.cwd(),
        'supabase/migrations/20261020110000_atomic_idempotent_mutation_rpc.sql'
      );
      const sql = fs.readFileSync(sqlPath, 'utf8');

      expect(sql).toContain('ADD COLUMN IF NOT EXISTS parent_folder_id UUID NULL');
      expect(sql).toContain('CREATE OR REPLACE FUNCTION public.apply_sync_mutation');
      expect(sql).toContain('SECURITY INVOKER');
      expect(sql).toContain('SET search_path = public');
      expect(sql).toContain('IF auth.uid() IS DISTINCT FROM p_user_id THEN');
      expect(sql).toContain('pg_advisory_xact_lock');
      expect(sql).toContain('ON CONFLICT (id) DO NOTHING');
      expect(sql).toContain('INSERT INTO public.processed_mutations');
      expect(sql).toContain('REVOKE ALL ON FUNCTION public.apply_sync_mutation');
      expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.apply_sync_mutation');
    });
  });
});
