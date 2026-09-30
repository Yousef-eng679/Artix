# Artix Repository & Synchronization API Reference

> **Status**: `IMPLEMENTED`  
> **Target**: Post-C12 Public API Signatures

---

## 1. DocumentRepository (`src/lib/repositories/documentRepository.ts`)

```typescript
export class DocumentRepository {
  constructor(db: ArtixDB, outboxRepo: OutboxRepository, syncMetadataRepo: SyncMetadataRepository);

  // Queries
  getById(id: string): Promise<LocalDocument | undefined>;
  listByProject(userId: string, projectId: string): Promise<LocalDocument[]>;

  // Mutations (Atomic 3-Table Dexie Transactions)
  create(params: {
    id?: string;
    title: string;
    content: string;
    format?: DocumentFormat;
    projectId: string;
    folderId?: string | null;
    userId: string;
  }): Promise<LocalDocument>;

  update(
    id: string,
    updates: Partial<Pick<LocalDocument, 'title' | 'content' | 'format' | 'folderId'>>,
    userId: string
  ): Promise<LocalDocument>;

  delete(id: string, userId: string): Promise<void>;
}
```

---

## 2. SystemDesignRepository (`src/lib/repositories/systemDesignRepository.ts`)

```typescript
export class SystemDesignRepository {
  constructor(db: ArtixDB, outboxRepo: OutboxRepository, syncMetadataRepo: SyncMetadataRepository);

  getById(id: string): Promise<LocalSystemDesign | undefined>;
  listByProject(userId: string, projectId: string): Promise<LocalSystemDesign[]>;

  create(params: {
    id?: string;
    name: string;
    boardState?: BoardState;
    projectId: string;
    folderId?: string | null;
    userId: string;
  }): Promise<LocalSystemDesign>;

  update(
    id: string,
    updates: Partial<Pick<LocalSystemDesign, 'name' | 'boardState' | 'folderId'>>,
    userId: string
  ): Promise<LocalSystemDesign>;

  delete(id: string, userId: string): Promise<void>;
}
```

---

## 3. WorkspaceFolderRepository (`src/lib/repositories/folderRepository.ts`)

```typescript
export class WorkspaceFolderRepository {
  constructor(db: ArtixDB, outboxRepo: OutboxRepository, syncMetadataRepo: SyncMetadataRepository);

  getById(id: string): Promise<LocalWorkspaceFolder | undefined>;
  listByProject(userId: string, projectId: string): Promise<LocalWorkspaceFolder[]>;

  create(params: {
    id?: string;
    name: string;
    projectId: string;
    parentFolderId?: string | null;
    userId: string;
  }): Promise<LocalWorkspaceFolder>;

  rename(id: string, name: string, userId: string): Promise<LocalWorkspaceFolder>;
  move(id: string, parentFolderId: string | null, userId: string): Promise<LocalWorkspaceFolder>;
  deleteCascade(id: string, userId: string): Promise<void>;
}
```

---

## 4. SyncEngine & PullEngine (`src/lib/sync/`)

```typescript
export class SyncEngine {
  triggerSync(userId: string, options?: { reason?: string; force?: boolean }): Promise<void>;
  drainOutbox(userId: string): Promise<{ pushed: number; failed: number }>;
}

export class PullEngine {
  pullAll(userId: string): Promise<{ appliedCount: number; conflictCount: number }>;
  pullBatch(userId: string, batchSize?: number): Promise<{ hasMore: boolean; appliedCount: number }>;
}

export class TabCoordinator {
  getTabId(): string;
  isLeaderTab(): boolean;
  onLeadershipChange(callback: (isLeader: boolean) => void): () => void;
  broadcastChange(params: { entityType: EntityType; entityId: string; operation: OutboxOperation; localRevision: number }): void;
  requestLeaderSync(): void;
}
```
