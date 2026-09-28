import { OutboxEntry } from '@/lib/local/types';
import { EntityPushAdapter, PushResult } from './types';
import { withTimeout } from '../transportTimeout';
import { checkIdempotency, recordIdempotency } from './idempotency';

export class WorkspaceFolderPushAdapter implements EntityPushAdapter {
  async push(entry: OutboxEntry, supabase: any): Promise<PushResult | null> {
    const cached = await checkIdempotency(entry, supabase);
    if (cached) return cached;

    const { entityId, operation, payload, userId, projectId } = entry;
    const body = (payload as Record<string, any>) || {};

    if (operation === 'create') {
      const { data, error } = await withTimeout(
        supabase
          .from('workspace_folders')
          .upsert({
            id: entityId,
            user_id: userId,
            project_id: projectId,
            name: body.name,
            parent_folder_id: body.parentFolderId ?? body.parent_folder_id ?? null,
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
      if (body.parentFolderId !== undefined) updateData.parent_folder_id = body.parentFolderId;
      if (body.parent_folder_id !== undefined) updateData.parent_folder_id = body.parent_folder_id;

      let query = supabase
        .from('workspace_folders')
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
          `Conflict detected: folder '${entityId}' was modified remotely (base version ${entry.baseServerVersion} mismatched)`
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
      let query = supabase.from('workspace_folders').delete().eq('id', entityId);
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

    throw new Error(`Unsupported folder outbox operation: ${operation}`);
  }
}
