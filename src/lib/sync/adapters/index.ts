import { EntityType } from '@/lib/local/types';
import { EntityPushAdapter } from './types';
import { WorkspaceFolderPushAdapter } from './folderPushAdapter';
import { DocumentPushAdapter } from './documentPushAdapter';
import { SystemDesignPushAdapter } from './systemDesignPushAdapter';

export * from './types';
export * from './folderPushAdapter';
export * from './documentPushAdapter';
export * from './systemDesignPushAdapter';

const adapters: Record<EntityType, EntityPushAdapter> = {
  workspace_folder: new WorkspaceFolderPushAdapter(),
  document: new DocumentPushAdapter(),
  system_design: new SystemDesignPushAdapter(),
};

export function getPushAdapter(entityType: EntityType): EntityPushAdapter {
  const adapter = adapters[entityType];
  if (!adapter) {
    throw new Error(`No push adapter registered for entity type: ${entityType}`);
  }
  return adapter;
}
