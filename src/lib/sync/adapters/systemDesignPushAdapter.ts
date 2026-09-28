import { OutboxEntry } from '@/lib/local/types';
import { EntityPushAdapter, PushResult } from './types';
import { withTimeout } from '../transportTimeout';
import { checkIdempotency, recordIdempotency } from './idempotency';

export class SystemDesignPushAdapter implements EntityPushAdapter {
  async push(entry: OutboxEntry, supabase: any): Promise<PushResult | null> {
    const cached = await checkIdempotency(entry, supabase);
    if (cached) return cached;

    const { entityId, operation, payload, userId, projectId } = entry;
    const body = (payload as Record<string, any>) || {};

    if (operation === 'create') {
      const { data, error } = await withTimeout(
        supabase
          .from('system_designs')
          .upsert({
            id: entityId,
            user_id: userId,
            project_id: projectId,
            folder_id: body.folderId ?? body.folder_id ?? null,
            name: body.name || 'New System Design',
            board_state: body.boardState ?? body.board_state ?? { nodes: [], edges: [], strokes: [] },
            updated_at: new Date().toISOString(),
          })
          .select('version, updated_at')
          .single()
      );

      if (error) throw error;
      const result: PushResult = {
        version: data?.version !== undefined ? String(data.version) : undefined,
        updated_at: data?.updated_at,
      };
      await recordIdempotency(entry, result, supabase);
      return result;
    }

    if (operation === 'update') {
      const updateData: Record<string, any> = {
        updated_at: new Date().toISOString(),
      };
      if (body.name !== undefined) updateData.name = body.name;
      if (body.boardState !== undefined) updateData.board_state = body.boardState;
      if (body.board_state !== undefined) updateData.board_state = body.board_state;
      if (body.folderId !== undefined) updateData.folder_id = body.folderId;
      if (body.folder_id !== undefined) updateData.folder_id = body.folder_id;

      let query = supabase
        .from('system_designs')
        .update(updateData)
        .eq('id', entityId);

      // CAS: verify remote row has not been incremented by another device
      if (entry.baseServerVersion) {
        const baseVer = parseInt(entry.baseServerVersion, 10);
        if (!isNaN(baseVer) && baseVer > 0) {
          query = query.eq('version', baseVer);
        }
      }

      const selectBuilder = query.select('version, updated_at');
      const executeQuery = typeof selectBuilder.maybeSingle === 'function'
        ? selectBuilder.maybeSingle()
        : selectBuilder.single();

      const { data, error } = await withTimeout(executeQuery);

      if (error) throw error;

      if (!data && entry.baseServerVersion) {
        const conflictErr = new Error(
          `Conflict detected: system design '${entityId}' was modified remotely (base version ${entry.baseServerVersion} mismatched)`
        );
        (conflictErr as any).status = 409;
        (conflictErr as any).code = 'CONFLICT';
        throw conflictErr;
      }

      const result: PushResult = {
        version: data?.version !== undefined ? String(data.version) : undefined,
        updated_at: data?.updated_at,
      };
      await recordIdempotency(entry, result, supabase);
      return result;
    }

    if (operation === 'delete') {
      let query = supabase.from('system_designs').delete().eq('id', entityId);
      if (entry.baseServerVersion) {
        const baseVer = parseInt(entry.baseServerVersion, 10);
        if (!isNaN(baseVer) && baseVer > 0) {
          query = query.eq('version', baseVer);
        }
      }
      const { error } = await withTimeout(query);
      if (error) throw error;
      await recordIdempotency(entry, null, supabase);
      return null;
    }

    throw new Error(`Unsupported system design outbox operation: ${operation}`);
  }
}
