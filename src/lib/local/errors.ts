export class LocalStorageError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'LocalStorageError';
  }
}

export class StorageQuotaExceededError extends LocalStorageError {
  constructor(message = 'Browser storage quota exceeded for IndexedDB') {
    super(message, 'STORAGE_QUOTA_EXCEEDED');
    this.name = 'StorageQuotaExceededError';
  }
}

export class EntityNotFoundError extends LocalStorageError {
  constructor(entityType: string, id: string) {
    super(`${entityType} with ID ${id} was not found in local database`, 'ENTITY_NOT_FOUND');
    this.name = 'EntityNotFoundError';
  }
}

export class DatabaseClosedError extends LocalStorageError {
  constructor(message = 'The local database connection is closed or has been blocked') {
    super(message, 'DATABASE_CLOSED');
    this.name = 'DatabaseClosedError';
  }
}

export class DuplicateNameError extends LocalStorageError {
  constructor(message: string) {
    super(message, 'DUPLICATE_NAME');
    this.name = 'DuplicateNameError';
  }
}

export class StaleBufferError extends LocalStorageError {
  constructor(
    entityType: string,
    id: string,
    public readonly expectedLocalRevision: number,
    public readonly actualLocalRevision: number,
  ) {
    super(
      `${entityType} ${id} changed since it was loaded (expected localRevision ${expectedLocalRevision}, found ${actualLocalRevision})`,
      'STALE_BUFFER',
    );
    this.name = 'StaleBufferError';
  }
}

export class MissingCasBaselineError extends LocalStorageError {
  public readonly status = 422;

  constructor(
    entityType: string,
    id: string,
    operation: string,
    received: unknown,
  ) {
    super(
      `Missing or invalid CAS baseServerVersion (${String(received)}) for ${entityType} '${id}' ${operation}`,
      'INVALID_CAS_BASELINE',
    );
    this.name = 'MissingCasBaselineError';
  }
}

export class UnresolvedConflictMarkersError extends LocalStorageError {
  public readonly status = 422;

  constructor(entityId: string) {
    super(
      `Document '${entityId}' still contains unresolved 3-way merge conflict markers (<<<<<<<, =======, >>>>>>>) and cannot be synced until resolved`,
      'UNRESOLVED_CONFLICT_MARKERS',
    );
    this.name = 'UnresolvedConflictMarkersError';
  }
}
