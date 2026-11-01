import { OutboxEntry } from '@/lib/local/types';
import { EntityPushAdapter, PushResult } from './types';
import { withTimeout } from '../transportTimeout';
import {
  checkIdempotency,
  executeAtomicMutation,
  recordIdempotency,
  requireValidCasBaseVersion,
} from './idempotency';

export class WorkspaceFolderPushAdapter implements EntityPushAdapter {
  async push(entry: OutboxEntry, supabase: any): Promise<PushResult | null> {
    // Primary atomic server path (Audit F-003, C-01, C-02, S-04):
    // Validates CAS baseline fail-closed and executes inside a single PostgreSQL
    // transaction via public.apply_sync_mutation whenever supabase.rpc exists.
    const atomic = await executeAtomicMutation(entry, supabase);
    if (atomic.handled) return atomic.result;

    // Lightweight .from()-only unit-test mock path (never reached on real Supabase clients)
    const cached = await checkIdempotency(entry, supabase);
    if (cached) return cached;

    const { entityId, operation, payload, userId, projectId } = entry;
    const body = (payload as Record<string, any>) || {};

    if (operation === 'create') {
      const { data, error } = await withTimeout(
        supabase
          .from('workspace_folders')
          .insert({
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
      const baseVer = requireValidCasBaseVersion(entry);

      const updateData: Record<string, any> = {
        updated_at: new Date().toISOString(),
      };
      if (body.name !== undefined) updateData.name = body.name;
      if (body.parentFolderId !== undefined) updateData.parent_folder_id = body.parentFolderId;
      if (body.parent_folder_id !== undefined) updateData.parent_folder_id = body.parent_folder_id;

      const query = supabase
        .from('workspace_folders')
        .update(updateData)
        .eq('id', entityId)
        .eq('version', baseVer);

      const selectBuilder = query.select('version, updated_at');
      const executeQuery = typeof selectBuilder.maybeSingle === 'function'
        ? selectBuilder.maybeSingle()
        : selectBuilder.single();

      const { data, error } = await withTimeout(executeQuery);

      if (error) throw error;

      if (!data) {
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
      const baseVer = requireValidCasBaseVersion(entry);

      const query = supabase
        .from('workspace_folders')
        .delete()
        .eq('id', entityId)
        .eq('version', baseVer);

      const selectBuilder = typeof query.select === 'function' ? query.select('id') : query;
      const { data, error } = await withTimeout(selectBuilder);
      if (error) throw error;

      if (data === null || (Array.isArray(data) && data.length === 0)) {
        try {
          const checkQuery = supabase.from('workspace_folders').select('version').eq('id', entityId);
          const executeCheck = typeof checkQuery?.maybeSingle === 'function'
            ? checkQuery.maybeSingle()
            : (typeof checkQuery?.single === 'function' ? checkQuery.single() : checkQuery);
          const { data: remoteRow } = await executeCheck;
          if (remoteRow && remoteRow.version !== undefined) {
            const conflictErr = new Error(
              `Conflict detected: folder '${entityId}' was modified remotely before delete (base version ${entry.baseServerVersion} mismatched)`
            );
            (conflictErr as any).status = 409;
            (conflictErr as any).code = 'CONFLICT';
            throw conflictErr;
          }
        } catch (fetchErr: any) {
          if (fetchErr.status === 409 || fetchErr.code === 'CONFLICT') throw fetchErr;
        }
      }

      await recordIdempotency(entry, null, supabase);
      return null;
    }

    throw new Error(`Unsupported folder outbox operation: ${operation}`);
  }
}
