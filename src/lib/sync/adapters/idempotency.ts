import { OutboxEntry } from '@/lib/local/types';
import { MissingCasBaselineError } from '@/lib/local/errors';
import { PushResult } from './types';
import { withTimeout } from '../transportTimeout';

export interface AtomicMutationDispatchResult {
  handled: boolean;
  result: PushResult | null;
}

export interface RecordIdempotencyOutcome {
  recorded: boolean;
  error?: unknown;
}

function isMissingRpcError(error: any): boolean {
  if (!error) return false;
  const code = String(error.code || '');
  const message = String(error.message || error.details || '');
  return (
    code === 'PGRST202' ||
    code === '42883' ||
    /could not find the function/i.test(message) ||
    /function .*apply_sync_mutation.* does not exist/i.test(message)
  );
}

/**
 * Validates that an `update` or `delete` outbox mutation carries a strictly
 * positive integer CAS `baseServerVersion` (Audit Gap C-02).
 *
 * Fails closed BEFORE any RPC or table call so missing or malformed baselines
 * (`null`, `""`, `"0"`, `"-1"`, `"abc"`, `"1.5"`, `"1abc"`) can never silently
 * bypass optimistic concurrency checks.
 */
export function requireValidCasBaseVersion(entry: OutboxEntry): number {
  const raw = entry.baseServerVersion;
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) {
    throw new MissingCasBaselineError(entry.entityType, entry.entityId, entry.operation, raw);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new MissingCasBaselineError(entry.entityType, entry.entityId, entry.operation, raw);
  }
  return parsed;
}

/**
 * Primary atomic push path (Audit F-003, C-01, C-02, S-03, S-04).
 *
 * Dispatches `public.apply_sync_mutation` on PostgreSQL so the idempotency
 * check, entity create/update/delete (with strict CAS version guard),
 * `sync_changes` trigger insert, and `processed_mutations` ledger write execute
 * inside a single database transaction.
 *
 * Returns `{ handled: false, result: null }` ONLY when `supabase.rpc` is not a
 * function (lightweight `.from()`-only unit test mocks). When `supabase.rpc` is
 * present, missing RPC errors (`PGRST202` / `42883`) fail closed with a
 * non-retryable `SCHEMA_ERROR` rather than degrading to non-atomic writes.
 */
export async function executeAtomicMutation(
  entry: OutboxEntry,
  supabase: any
): Promise<AtomicMutationDispatchResult> {
  const baseVersion =
    entry.operation === 'update' || entry.operation === 'delete'
      ? requireValidCasBaseVersion(entry)
      : null;

  if (typeof supabase?.rpc !== 'function') {
    return { handled: false, result: null };
  }

  const mutationId = entry.mutationId || entry.id;
  if (!mutationId) {
    const invalidErr: any = new Error(
      `Missing mutationId for ${entry.entityType} '${entry.entityId}' ${entry.operation}`
    );
    invalidErr.code = 'VALIDATION_FAILED';
    invalidErr.status = 422;
    throw invalidErr;
  }

  const { data, error } = await withTimeout<any>(
    supabase.rpc('apply_sync_mutation', {
      p_mutation_id: mutationId,
      p_user_id: entry.userId,
      p_entity_type: entry.entityType,
      p_entity_id: entry.entityId,
      p_operation: entry.operation,
      p_project_id: entry.projectId ?? null,
      p_payload: (entry.payload as Record<string, unknown>) ?? {},
      p_base_version: baseVersion,
    })
  );

  if (error) {
    if (isMissingRpcError(error)) {
      const schemaErr: any = new Error(
        `Required atomic sync RPC public.apply_sync_mutation is missing on server (${error.code || 'PGRST202'}): ${error.message || 'schema mismatch'}`
      );
      schemaErr.code = 'SCHEMA_ERROR';
      schemaErr.originalCode = error.code;
      throw schemaErr;
    }
    if (error.code === 'P0002' && error.status === undefined) {
      (error as any).status = 404;
    } else if (error.code === '42501' && error.status === undefined) {
      (error as any).status = 403;
    }
    throw error;
  }

  if (data?.status === 'conflict') {
    const reason =
      data.reason ?? (entry.operation === 'create' ? 'already_exists' : 'version_mismatch');
    const conflictErr = new Error(
      `Conflict detected (${reason}): ${entry.entityType} '${entry.entityId}' was modified remotely (base version ${entry.baseServerVersion ?? 'create'} mismatched)`
    );
    (conflictErr as any).status = 409;
    (conflictErr as any).code = 'CONFLICT';
    (conflictErr as any).conflictReason = reason;
    (conflictErr as any).remoteVersion =
      data.current_version !== undefined && data.current_version !== null
        ? String(data.current_version)
        : null;
    (conflictErr as any).remoteSnapshot = data.current_row ?? null;
    throw conflictErr;
  }

  if (entry.operation === 'delete' && (data?.version === null || data?.version === undefined)) {
    return { handled: true, result: null };
  }

  return {
    handled: true,
    result: {
      version:
        data?.version !== undefined && data?.version !== null ? String(data.version) : undefined,
      updated_at: data?.updated_at ?? undefined,
    },
  };
}

/**
 * Unit-test `.from()`-only mock idempotency lookup used exclusively when
 * `supabase.rpc` is absent on lightweight test stubs.
 */
export async function checkIdempotency(entry: OutboxEntry, supabase: any): Promise<PushResult | null> {
  const mutationId = entry.mutationId || entry.id;
  if (!mutationId || !supabase?.from) return null;

  try {
    const builder = supabase.from('processed_mutations');
    if (typeof builder?.select !== 'function') return null;

    const selectQuery = builder
      .select('mutation_id, version, updated_at')
      .eq('mutation_id', mutationId);

    const query = typeof selectQuery?.maybeSingle === 'function'
      ? selectQuery.maybeSingle()
      : (typeof selectQuery?.single === 'function' ? selectQuery.single() : null);

    if (!query) return null;

    const { data, error } = await query;
    if (!error && data && data.mutation_id === mutationId) {
      return {
        version: data.version !== undefined && data.version !== null ? String(data.version) : undefined,
        updated_at: data.updated_at,
      };
    }
  } catch {
    // If table or mock doesn't support processed_mutations check, continue test-mock push
  }

  return null;
}

/**
 * Unit-test `.from()`-only mock ledger write. Inspects PostgREST `{ error }`
 * responses rather than silently discarding them (Audit F-003).
 */
export async function recordIdempotency(
  entry: OutboxEntry,
  result: PushResult | null,
  supabase: any
): Promise<RecordIdempotencyOutcome> {
  const mutationId = entry.mutationId || entry.id;
  if (!mutationId || !supabase?.from) {
    return { recorded: false };
  }

  try {
    const builder = supabase.from('processed_mutations');
    if (typeof builder?.upsert !== 'function') {
      return { recorded: false };
    }

    const response = await builder.upsert({
      mutation_id: mutationId,
      user_id: entry.userId,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      version: result?.version ? parseInt(result.version, 10) : null,
      updated_at: result?.updated_at || new Date().toISOString(),
    });

    if (response?.error) {
      console.warn(
        `[idempotency] Ledger upsert returned error for mutation ${mutationId}:`,
        response.error
      );
      return { recorded: false, error: response.error };
    }

    return { recorded: true };
  } catch (err) {
    console.warn(
      `[idempotency] Ledger upsert threw for mutation ${mutationId}:`,
      err
    );
    return { recorded: false, error: err };
  }
}
