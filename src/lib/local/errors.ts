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
