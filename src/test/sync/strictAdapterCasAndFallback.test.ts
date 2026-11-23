import { describe, it, expect, vi } from 'vitest';
import {
  DocumentPushAdapter,
  SystemDesignPushAdapter,
  WorkspaceFolderPushAdapter,
} from '@/lib/sync/adapters';
import { classifySyncError } from '@/lib/sync/errorTaxonomy';
import { OutboxEntry, EntityType } from '@/lib/local/types';

function makeOutboxEntry(
  overrides: Partial<OutboxEntry> & Pick<OutboxEntry, 'entityType' | 'operation'>
): OutboxEntry {
  return {
    id: 'outbox-strict-1',
    mutationId: '11111111-2222-4333-8444-555555555555',
    userId: 'user-strict-cas',
    projectId: 'proj-strict-cas',
    entityId: 'entity-strict-1',
    payload: { title: 'Doc', name: 'Item', content: 'Body' },
    localRevision: 2,
    baseServerVersion: '1',
    state: 'in_flight',
    attemptCount: 1,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

describe('TASK-02: Fail-Closed Adapter CAS Validation & No Silent Production RPC Fallback (C-01, C-02, S-04)', () => {
  const adapterCases: Array<{
    entityType: EntityType;
    table: string;
    createAdapter: () => DocumentPushAdapter | SystemDesignPushAdapter | WorkspaceFolderPushAdapter;
  }> = [
    {
      entityType: 'document',
      table: 'documents',
      createAdapter: () => new DocumentPushAdapter(),
    },
    {
      entityType: 'system_design',
      table: 'system_designs',
      createAdapter: () => new SystemDesignPushAdapter(),
    },
    {
      entityType: 'workspace_folder',
      table: 'workspace_folders',
      createAdapter: () => new WorkspaceFolderPushAdapter(),
    },
  ];

  const invalidBaselines: Array<any> = [null, undefined, '', '0', '-1', 'abc', '1.5', '1abc', 'NaN'];

  it.each(adapterCases)(
    'rejects $entityType update and delete with missing or malformed baseServerVersion before any RPC or table call (C-02)',
    async ({ entityType, createAdapter }) => {
      const adapter = createAdapter();

      for (const operation of ['update', 'delete'] as const) {
        for (const badBase of invalidBaselines) {
          const rpcSpy = vi.fn();
          const fromSpy = vi.fn();
          const supabaseWithRpc = { rpc: rpcSpy, from: fromSpy };
          const supabaseTableOnly = { from: fromSpy };

          const entry = makeOutboxEntry({
            entityType,
            operation,
            baseServerVersion: badBase,
          });

          let caughtRpcErr: any = null;
          try {
            await adapter.push(entry, supabaseWithRpc);
          } catch (err) {
            caughtRpcErr = err;
          }

          expect(caughtRpcErr).toBeInstanceOf(Error);
          expect(caughtRpcErr?.code).toBe('INVALID_CAS_BASELINE');
          expect(classifySyncError(caughtRpcErr).retryable).toBe(false);
          expect(rpcSpy).not.toHaveBeenCalled();
          expect(fromSpy).not.toHaveBeenCalled();

          let caughtTableErr: any = null;
          try {
            await adapter.push(entry, supabaseTableOnly);
          } catch (err) {
            caughtTableErr = err;
          }

          expect(caughtTableErr).toBeInstanceOf(Error);
          expect(caughtTableErr?.code).toBe('INVALID_CAS_BASELINE');
          expect(classifySyncError(caughtTableErr).retryable).toBe(false);
          expect(fromSpy).not.toHaveBeenCalled();
        }
      }
    }
  );

  it.each(adapterCases)(
    'fails closed with non-retryable SCHEMA_ERROR on PGRST202/42883 instead of falling back to non-atomic .from() writes (S-04) [$entityType]',
    async ({ entityType, createAdapter }) => {
      const adapter = createAdapter();

      for (const missingCode of ['PGRST202', '42883']) {
        const rpcSpy = vi.fn().mockResolvedValue({
          data: null,
          error: {
            code: missingCode,
            message: 'Could not find the function public.apply_sync_mutation in the schema cache',
          },
        });
        const fromSpy = vi.fn();

        const createEntry = makeOutboxEntry({
          entityType,
          operation: 'create',
          baseServerVersion: null,
        });

        let caught: any = null;
        try {
          await adapter.push(createEntry, { rpc: rpcSpy, from: fromSpy });
        } catch (err) {
          caught = err;
        }

        expect(rpcSpy).toHaveBeenCalledTimes(1);
        expect(fromSpy).not.toHaveBeenCalled();
        expect(caught).toBeInstanceOf(Error);
        expect(caught?.code).toBe('SCHEMA_ERROR');

        const classified = classifySyncError(caught);
        expect(classified.code).toBe('SCHEMA_ERROR');
        expect(classified.retryable).toBe(false);
      }
    }
  );

  it.each(adapterCases)(
    'uses .insert() rather than clobbering .upsert() on entity table creates in lightweight .from() mocks (S-04) [$entityType]',
    async ({ entityType, table, createAdapter }) => {
      const adapter = createAdapter();
      const insertSpy = vi.fn().mockReturnValue({
        select: () => ({
          single: () =>
            Promise.resolve({
              data: { version: 1, updated_at: '2026-11-01T12:00:00Z' },
              error: null,
            }),
        }),
      });
      const entityUpsertSpy = vi.fn();

      const mockTableOnlySupabase = {
        from: (t: string) => {
          if (t === 'processed_mutations') {
            return {
              select: () => ({
                eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
              }),
              upsert: () => Promise.resolve({ error: null }),
            };
          }
          expect(t).toBe(table);
          return {
            insert: insertSpy,
            upsert: entityUpsertSpy,
          };
        },
      };

      const entry = makeOutboxEntry({
        entityType,
        operation: 'create',
        baseServerVersion: null,
      });

      const res = await adapter.push(entry, mockTableOnlySupabase);
      expect(res?.version).toBe('1');
      expect(insertSpy).toHaveBeenCalledTimes(1);
      expect(entityUpsertSpy).not.toHaveBeenCalled();
    }
  );

  it('propagates structured conflictReason, remoteVersion, and remoteSnapshot from apply_sync_mutation (C-01 / S-03)', async () => {
    const adapter = new DocumentPushAdapter();

    const remoteRow = {
      id: 'entity-strict-1',
      version: 7,
      title: 'Concurrent Remote Title',
      content: 'Remote body v7',
      updated_at: '2026-11-01T12:05:00Z',
    };

    const mockRpcMismatch = {
      rpc: vi.fn().mockResolvedValue({
        data: {
          status: 'conflict',
          reason: 'version_mismatch',
          current_version: 7,
          current_row: remoteRow,
        },
        error: null,
      }),
    };

    const updateEntry = makeOutboxEntry({
      entityType: 'document',
      operation: 'update',
      baseServerVersion: '3',
    });

    await expect(adapter.push(updateEntry, mockRpcMismatch)).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
      conflictReason: 'version_mismatch',
      remoteVersion: '7',
      remoteSnapshot: remoteRow,
    });

    const mockRpcRemoteDeleted = {
      rpc: vi.fn().mockResolvedValue({
        data: {
          status: 'conflict',
          reason: 'remote_deleted',
          current_version: null,
          current_row: null,
        },
        error: null,
      }),
    };

    await expect(adapter.push(updateEntry, mockRpcRemoteDeleted)).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
      conflictReason: 'remote_deleted',
      remoteVersion: null,
      remoteSnapshot: null,
    });
  });
});
