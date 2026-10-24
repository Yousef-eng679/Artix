import { OutboxEntry } from '@/lib/local/types';
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
 * Primary atomic push path (Audit F-003).
 *
 * Dispatches `public.apply_sync_mutation` on PostgreSQL so the idempotency
 * check, entity create/update/delete (with CAS version guard), `sync_changes`
 * trigger insert, and `processed_mutations` ledger write execute inside a
 * single database transaction.
 *
 * Returns `{ handled: false, result: null }` only when `supabase.rpc` is absent
 * (lightweight unit-test `.from()` mocks) or when the migration has not yet been
 * applied on the target Supabase instance (`PGRST202`), allowing a safe rollout
 * fallback.
 */
export async function executeAtomicMutation(
  entry: OutboxEntry,
  supabase: any
): Promise<AtomicMutationDispatchResult> {
  const mutationId = entry.mutationId || entry.id;
  if (!mutationId || typeof supabase?.rpc !== 'function') {
    return { handled: false, result: null };
  }

  const parsedBase = entry.baseServerVersion ? parseInt(entry.baseServerVersion, 10) : null;
  const baseVersion =
    parsedBase !== null && !Number.isNaN(parsedBase) && parsedBase > 0 ? parsedBase : null;

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
      console.warn(
        '[idempotency] apply_sync_mutation RPC not found on server; falling back to legacy table push path.'
      );
      return { handled: false, result: null };
    }
    if (error.code === 'P0002' && error.status === undefined) {
      (error as any).status = 404;
    } else if (error.code === '42501' && error.status === undefined) {
      (error as any).status = 403;
    }
    throw error;
  }

  if (data?.status === 'conflict') {
    const conflictErr = new Error(
      `Conflict detected: ${entry.entityType} '${entry.entityId}' was modified remotely (base version ${entry.baseServerVersion ?? 'create'} mismatched)`
    );
    (conflictErr as any).status = 409;
    (conflictErr as any).code = 'CONFLICT';
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
 * Degraded fallback idempotency lookup used only when `apply_sync_mutation` RPC
 * is unavailable (e.g. unit-test `.from()` mocks or pre-migration rollout).
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
    // If table or mock doesn't support processed_mutations check, continue fallback push
  }

  return null;
}

/**
 * Degraded fallback ledger write used only when `apply_sync_mutation` RPC is
 * unavailable. Inspects PostgREST `{ error }` responses rather than silently
 * discarding them (Audit F-003).
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
