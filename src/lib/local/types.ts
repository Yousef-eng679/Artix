import { DocumentFormat } from '@/components/Editor/languageMap';
import { BoardState } from '@/hooks/useSystemDesigns';

export type EntityType = 'document' | 'system_design' | 'workspace_folder';

export type OutboxOperation = 'create' | 'update' | 'delete';

export type OutboxState = 'pending' | 'in_flight' | 'blocked' | 'failed';

export type SyncState = 'synced' | 'pending' | 'syncing' | 'conflict' | 'error';

export interface LocalDocument {
  id: string;
  projectId: string | null;
  userId: string;
  folderId: string | null;
  title: string;
  content: string;
  format: DocumentFormat;
  createdAt: string;
  updatedAt: string;
  localRevision: number;
  isDeleted: boolean;
  deletedAt?: string | null;
}

export interface LocalSystemDesign {
  id: string;
  projectId: string;
  userId: string;
  folderId: string | null;
  name: string;
  boardState: BoardState;
  createdAt: string;
  updatedAt: string;
  localRevision: number;
  isDeleted: boolean;
  deletedAt?: string | null;
}

export interface LocalWorkspaceFolder {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  parentFolderId: string | null;
  createdAt: string;
  updatedAt: string;
  localRevision: number;
  isDeleted: boolean;
  deletedAt?: string | null;
}

export interface OutboxEntry {
  id: string;
  entityType: EntityType;
  entityId: string;
  userId: string;
  projectId: string | null;
  operation: OutboxOperation;
  baseServerVersion: string | null;
  localRevision: number;
  payload: unknown;
  state: OutboxState;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  lastError?: {
    code: string;
    message: string;
    at: number;
  };
}

export interface SyncMetadata {
  id: string; // format: `${entityType}:${entityId}`
  entityType: EntityType;
  entityId: string;
  userId: string;
  serverVersion: string | null;
  serverUpdatedAt: string | null;
  localRevision: number;
  syncState: SyncState;
  lastSyncedAt: number | null;
}

export interface ConflictRecord {
  id: string;
  entityType: EntityType;
  entityId: string;
  userId: string;
  basePayload: unknown;
  localPayload: unknown;
  remotePayload: unknown;
  detectedAt: number;
  resolvedAt?: number | null;
}

export interface DatabaseMeta {
  key: string;
  value: unknown;
  updatedAt: number;
}
