import { OutboxEntry } from '@/lib/local/types';
import { EntityPushAdapter, PushResult } from './types';
import { withTimeout } from '../syncEngine';

export class DocumentPushAdapter implements EntityPushAdapter {
  async push(entry: OutboxEntry, supabase: any): Promise<PushResult | null> {
    const { entityId, operation, payload, userId, projectId } = entry;
    const body = (payload as Record<string, any>) || {};

    if (operation === 'create') {
      const { data, error } = await withTimeout(
        supabase
          .from('documents')
          .upsert({
            id: entityId,
            user_id: userId,
            project_id: projectId,
            folder_id: body.folderId ?? body.folder_id ?? null,
            title: body.title || 'Untitled Document',
            content: body.content || '',
            format: body.format || 'markdown',
            updated_at: new Date().toISOString(),
          })
          .select('version, updated_at')
          .single()
      );

      if (error) throw error;
      return {
        version: data?.version !== undefined ? String(data.version) : undefined,
        updated_at: data?.updated_at,
      };
    }

    if (operation === 'update') {
      const updateData: Record<string, any> = {
        updated_at: new Date().toISOString(),
      };
      if (body.title !== undefined) updateData.title = body.title;
      if (body.content !== undefined) updateData.content = body.content;
      if (body.format !== undefined) updateData.format = body.format;
      if (body.folderId !== undefined) updateData.folder_id = body.folderId;
      if (body.folder_id !== undefined) updateData.folder_id = body.folder_id;

      let query = supabase
        .from('documents')
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
          `Conflict detected: document '${entityId}' was modified remotely (base version ${entry.baseServerVersion} mismatched)`
        );
        (conflictErr as any).status = 409;
        (conflictErr as any).code = 'CONFLICT';
        throw conflictErr;
      }

      return {
        version: data?.version !== undefined ? String(data.version) : undefined,
        updated_at: data?.updated_at,
      };
    }

    if (operation === 'delete') {
      let query = supabase.from('documents').delete().eq('id', entityId);
      if (entry.baseServerVersion) {
        const baseVer = parseInt(entry.baseServerVersion, 10);
        if (!isNaN(baseVer) && baseVer > 0) {
          query = query.eq('version', baseVer);
        }
      }
      const { error } = await withTimeout(query);
      if (error) throw error;
      return null;
    }

    throw new Error(`Unsupported document outbox operation: ${operation}`);
  }
}
