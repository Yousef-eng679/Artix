# Artix Repository & Synchronization API Reference

> **Status**: `IMPLEMENTED`  
> **Target**: Productionized Billing, Strict CAS & True Offline-First Public API Signatures (`v2.5.0`)

---

## 1. ProjectRepository (`src/lib/repositories/projectRepository.ts`)

```typescript
export class ProjectRepository {
  constructor(db?: ArtixDB, outboxRepo?: OutboxRepository, syncMetadataRepo?: SyncMetadataRepository);

  // Queries
  getById(id: string): Promise<LocalProject | null>;
  getByIdIncludeDeleted(id: string): Promise<LocalProject | null>;
  listByUser(userId: string): Promise<LocalProject[]>;
  applyRemoteSnapshot(
    snapshot: ProjectSnapshot,
    options?: { syncStatus?: SyncStatus; serverVersion?: string }
  ): Promise<LocalProject>;

  // Mutations (Atomic Dexie Transactions)
  create(dto: CreateProjectDTO, options?: { skipOutbox?: boolean }): Promise<LocalProject>;
  rename(id: string, newName: string, options?: { skipOutbox?: boolean }): Promise<LocalProject>;
  update(
    id: string,
    updates: UpdateProjectDTO,
    options?: { skipOutbox?: boolean; expectedLocalRevision?: number }
  ): Promise<LocalProject>;
  delete(id: string, options?: { skipOutbox?: boolean }): Promise<number | null>; // 6-table cascade
  hardDelete(id: string): Promise<void>;
  restore(id: string): Promise<LocalProject | null>;
}
```

---

## 2. DocumentRepository (`src/lib/repositories/documentRepository.ts`)

```typescript
export class DocumentRepository {
  constructor(db?: ArtixDB, outboxRepo?: OutboxRepository, syncMetadataRepo?: SyncMetadataRepository);

  // Queries
  getById(id: string): Promise<LocalDocument | null>;
  getByIdIncludeDeleted(id: string): Promise<LocalDocument | null>;
  listByProject(userId: string, projectId: string | null): Promise<LocalDocument[]>;
  listAllByUser(userId: string): Promise<LocalDocument[]>;
  applyRemoteSnapshot(
    snapshot: DocumentSnapshot,
    options?: { syncStatus?: SyncStatus; serverVersion?: string }
  ): Promise<LocalDocument>;

  // Mutations (Atomic 3-Table Dexie Transactions; throws StaleBufferError on expectedLocalRevision mismatch)
  create(dto: CreateDocumentDTO, options?: { skipOutbox?: boolean }): Promise<LocalDocument>;
  update(
    id: string,
    updates: UpdateDocumentDTO,
    options?: { skipOutbox?: boolean; expectedLocalRevision?: number }
  ): Promise<LocalDocument>;
  delete(id: string, options?: { skipOutbox?: boolean }): Promise<number | null>;
  hardDelete(id: string): Promise<void>;
  restore(id: string): Promise<LocalDocument | null>;
}
```

---

## 3. SystemDesignRepository (`src/lib/repositories/systemDesignRepository.ts`)

```typescript
export class SystemDesignRepository {
  constructor(db?: ArtixDB, outboxRepo?: OutboxRepository, syncMetadataRepo?: SyncMetadataRepository);

  getById(id: string): Promise<LocalSystemDesign | null>;
  getByIdIncludeDeleted(id: string): Promise<LocalSystemDesign | null>;
  listByProject(userId: string, projectId: string): Promise<LocalSystemDesign[]>;
  listAllByUser(userId: string): Promise<LocalSystemDesign[]>;
  applyRemoteSnapshot(
    snapshot: SystemDesignSnapshot,
    options?: { syncStatus?: SyncStatus; serverVersion?: string }
  ): Promise<LocalSystemDesign>;

  // Throws StaleBufferError when expectedLocalRevision mismatches stored localRevision
  create(dto: CreateSystemDesignDTO, options?: { skipOutbox?: boolean }): Promise<LocalSystemDesign>;
  update(
    id: string,
    updates: UpdateSystemDesignDTO,
    options?: { skipOutbox?: boolean; expectedLocalRevision?: number }
  ): Promise<LocalSystemDesign>;
  delete(id: string, options?: { skipOutbox?: boolean }): Promise<number | null>;
  hardDelete(id: string): Promise<void>;
  restore(id: string): Promise<LocalSystemDesign | null>;
}
```

---

## 4. FolderRepository (`src/lib/repositories/folderRepository.ts`)

```typescript
export class FolderRepository {
  constructor(db?: ArtixDB, outboxRepo?: OutboxRepository, syncMetadataRepo?: SyncMetadataRepository);

  getById(id: string): Promise<LocalWorkspaceFolder | null>;
  getByIdIncludeDeleted(id: string): Promise<LocalWorkspaceFolder | null>;
  listByProject(userId: string, projectId: string): Promise<LocalWorkspaceFolder[]>;
  applyRemoteSnapshot(
    snapshot: FolderSnapshot,
    options?: { syncStatus?: SyncStatus; serverVersion?: string }
  ): Promise<LocalWorkspaceFolder>;

  create(dto: CreateFolderDTO, options?: { skipOutbox?: boolean }): Promise<LocalWorkspaceFolder>;
  rename(id: string, newName: string, options?: { skipOutbox?: boolean }): Promise<LocalWorkspaceFolder>;
  update(id: string, updates: UpdateFolderDTO, options?: { skipOutbox?: boolean }): Promise<LocalWorkspaceFolder>;
  delete(id: string, options?: { skipOutbox?: boolean }): Promise<number | null>; // 5-table cascade
  hardDelete(id: string): Promise<void>;
  restore(id: string): Promise<LocalWorkspaceFolder | null>;
}
```

---

## 5. OutboxRepository & ConflictRepository (`src/lib/repositories/`)

```typescript
export class OutboxRepository {
  enqueue(dto: EnqueueOutboxDTO): Promise<OutboxEntry | null>;
  enqueueInTx(dto: EnqueueOutboxDTO): Promise<OutboxEntry | null>;
  getPending(limit?: number, userId?: string, options?: { readyOnly?: boolean; now?: number }): Promise<OutboxEntry[]>;
  getBlocked(userId?: string): Promise<OutboxEntry[]>;
  markInFlight(id: string, tabId: string, leaseDurationMs?: number): Promise<string | null>; // returns leaseToken
  markFailedInTx(id: string, classifiedError: ClassifiedSyncError, expectedLeaseToken?: string | null): Promise<void>;
  recoverStaleLeases(now?: number): Promise<number>;
  retryBlockedEntry(id: string): Promise<boolean>;
  retryAllBlocked(userId?: string): Promise<number>;
}

export class ConflictRepository {
  recordConflict(record: Omit<ConflictRecord, 'id' | 'detectedAt'> & { id?: string; detectedAt?: number }): Promise<ConflictRecord>;
  listUnresolvedByUser(userId: string): Promise<ConflictRecord[]>;
  resolveConflict(params: {
    conflictId: string;
    strategy: 'keep_local' | 'keep_remote' | 'merge_document' | 'create_copy';
    mergedContent?: string;
    copyTitle?: string;
  }): Promise<void>;
}
```

---

## 6. SyncEngine, PullEngine & TabCoordinator (`src/lib/sync/`)

```typescript
export class SyncEngine {
  triggerSync(userId?: string): Promise<void>;
  retryBlocked(userId?: string): Promise<number>;
  pullChanges(userId: string): Promise<void>;
  pushMutationToCloud(entry: OutboxEntry): Promise<{ serverVersion?: string }>;
  getStatus(): SyncEngineStatus;
  getStatusWithPending(userId?: string): Promise<SyncEngineStatus>;
  subscribe(listener: (status: SyncEngineStatus) => void): () => void;
  destroy(): void;
}

export class PullEngine {
  syncPull(userId: string): Promise<{
    mode: 'bootstrap' | 'resnapshot' | 'incremental';
    totalPulled: number;
    finalCursor: number;
  }>;
  bootstrapHydrateAll(userId: string, bounds?: SyncFeedBounds): Promise<{ totalPulled: number; finalCursor: number }>;
  resnapshotAll(userId: string, bounds?: SyncFeedBounds): Promise<{ totalPulled: number; finalCursor: number }>;
  pullAll(userId: string): Promise<{ totalPulled: number; finalCursor: number }>;
  pullBatch(userId: string): Promise<{ pulledCount: number; newCursor: number; hasMore: boolean }>;
  getFeedBounds(userId: string): Promise<{ minRetainedSequence: number; maxSequence: number }>;
  isHydrated(): Promise<boolean>;
  getCursor(): Promise<number>;
  setCursor(cursor: number): Promise<void>;
}

export class TabCoordinator {
  getTabId(): string;
  getIsLeader(): boolean;
  isLeaderTab(): boolean;
  onLeadershipChange(callback: (isLeader: boolean) => void): () => void;
  broadcastChange(
    entityType: EntityType,
    entityId: string,
    operation: OutboxOperation,
    userId?: string,
    localRevision?: number
  ): void;
  notifyRemoteChange(
    entityType: EntityType,
    entityId: string,
    userId?: string,
    operation?: OutboxOperation,
    localRevision?: number
  ): void;
  requestLeaderSync(userId?: string): void;
  onCrossTabChange(callback: (event: CrossTabChangeEvent) => void): () => void;
  onSyncRequest(callback: (event: CrossTabSyncRequestEvent) => void): () => void;
  destroy(): void;
}
```
