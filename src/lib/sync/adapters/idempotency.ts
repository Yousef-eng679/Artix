import { OutboxEntry } from '@/lib/local/types';
import { PushResult } from './types';

/**
 * Checks if the mutation was already processed on the server (e.g. on retry after lost response).
 * If found, returns the previously recorded version and updated_at, preventing double-application.
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
    // If table or mock doesn't support processed_mutations check, continue standard push
  }

  return null;
}

/**
 * Records the successfully processed mutation in the idempotency ledger on Supabase.
 */
export async function recordIdempotency(entry: OutboxEntry, result: PushResult | null, supabase: any): Promise<void> {
  const mutationId = entry.mutationId || entry.id;
  if (!mutationId || !supabase?.from) return;

  try {
    const builder = supabase.from('processed_mutations');
    if (typeof builder?.upsert !== 'function') return;

    await builder.upsert({
      mutation_id: mutationId,
      user_id: entry.userId,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      version: result?.version ? parseInt(result.version, 10) : null,
      updated_at: result?.updated_at || new Date().toISOString(),
    });
  } catch {
    // Non-fatal if recording fails
  }
}
