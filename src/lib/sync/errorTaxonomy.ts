export type SyncErrorCode =
  | 'NETWORK_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'REQUEST_TIMEOUT'
  | 'ETIMEDOUT'
  | 'AUTH_EXPIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'DUPLICATE_NAME'
  | 'CONFLICT'
  | 'SERVER_ERROR'
  | 'STORAGE_QUOTA'
  | 'SCHEMA_ERROR'
  | 'UNKNOWN';

export interface ClassifiedSyncError {
  code: SyncErrorCode;
  category: SyncErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
  rawError?: unknown;
}

/**
 * Classifies any runtime error, Supabase PostgREST error, or network timeout
 * into the standardized synchronization error taxonomy.
 */
export function classifySyncError(error: unknown): ClassifiedSyncError {
  if (!error) {
    return {
      code: 'UNKNOWN',
      category: 'UNKNOWN',
      message: 'Unknown synchronization failure',
      retryable: false,
    };
  }

  const err = error as any;
  const status = typeof err.status === 'number' ? err.status : undefined;
  const rawCode = String(err.code || '');
  const message = String(err.message || err.error_description || err.details || 'Sync error');
  const lowerMsg = message.toLowerCase();

  // 1. Timeout detection
  if (
    err.name === 'TimeoutError' ||
    rawCode === 'ETIMEDOUT' ||
    lowerMsg.includes('timed out') ||
    lowerMsg.includes('timeout')
  ) {
    return {
      code: rawCode === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'REQUEST_TIMEOUT',
      category: 'REQUEST_TIMEOUT',
      message: 'Network transport request timed out',
      retryable: true,
      status: 408,
      rawError: error,
    };
  }

  // 2. Network connectivity detection
  if (
    (typeof navigator !== 'undefined' && !navigator.onLine) ||
    lowerMsg.includes('failed to fetch') ||
    lowerMsg.includes('network') ||
    lowerMsg.includes('offline') ||
    lowerMsg.includes('connection refused') ||
    err.name === 'NetworkError' ||
    status === 0
  ) {
    return {
      code: 'NETWORK_ERROR',
      category: 'NETWORK_UNAVAILABLE',
      message: 'Network connection is unavailable or offline',
      retryable: true,
      status: 0,
      rawError: error,
    };
  }

  // 3. Storage Quota Exceeded (IndexedDB local failure)
  if (err.name === 'QuotaExceededError' || lowerMsg.includes('quota')) {
    return {
      code: 'STORAGE_QUOTA',
      category: 'STORAGE_QUOTA',
      message: 'Local browser storage quota exceeded',
      retryable: false,
      rawError: error,
    };
  }

  // 4. Authentication / Token Expiration
  if (
    status === 401 ||
    rawCode === 'PGRST301' ||
    lowerMsg.includes('jwt') ||
    lowerMsg.includes('token expired') ||
    lowerMsg.includes('unauthorized')
  ) {
    return {
      code: 'AUTH_EXPIRED',
      category: 'AUTH_EXPIRED',
      message: 'Authentication session expired or invalid',
      retryable: false,
      status: 401,
      rawError: error,
    };
  }

  // 5. Forbidden / Authorization / RLS violation
  if (status === 403 || lowerMsg.includes('permission denied') || lowerMsg.includes('rls')) {
    return {
      code: 'FORBIDDEN',
      category: 'FORBIDDEN',
      message: 'Access denied by server security policy',
      retryable: false,
      status: 403,
      rawError: error,
    };
  }

  // 6. Not Found
  if (status === 404 || rawCode === 'PGRST116' || lowerMsg.includes('not found')) {
    return {
      code: 'NOT_FOUND',
      category: 'NOT_FOUND',
      message: 'Remote resource was not found',
      retryable: false,
      status: 404,
      rawError: error,
    };
  }

  // 7. Duplicate Key / Unique Constraint Violation
  if (
    rawCode === '23505' ||
    lowerMsg.includes('unique constraint') ||
    lowerMsg.includes('duplicate key') ||
    lowerMsg.includes('already exists')
  ) {
    return {
      code: 'DUPLICATE_NAME',
      category: 'DUPLICATE_NAME',
      message: 'A resource with this identifier or name already exists',
      retryable: false,
      status: 409,
      rawError: error,
    };
  }

  // 8. General Conflict / Stale Version (409)
  if (status === 409 || lowerMsg.includes('conflict')) {
    return {
      code: 'CONFLICT',
      category: 'CONFLICT',
      message: 'Concurrent modification conflict detected',
      retryable: false,
      status: 409,
      rawError: error,
    };
  }

  // 9. Validation Failure / Bad Payload / Foreign Key / Schema Constraint
  if (
    status === 422 ||
    status === 400 ||
    rawCode === '23502' || // not-null violation
    rawCode === '23503' || // foreign key violation
    rawCode === '23514' || // check violation
    rawCode === '22P02' || // invalid text representation (bad uuid, etc)
    lowerMsg.includes('validation') ||
    lowerMsg.includes('violates foreign key')
  ) {
    return {
      code: 'VALIDATION_FAILED',
      category: 'VALIDATION_FAILED',
      message: message || 'Remote schema validation failed',
      retryable: false,
      status: status || 422,
      rawError: error,
    };
  }

  // 10. Database Schema Mismatch
  if (rawCode === '42703' || lowerMsg.includes('column does not exist') || lowerMsg.includes('schema mismatch')) {
    return {
      code: 'SCHEMA_ERROR',
      category: 'SCHEMA_ERROR',
      message: 'Database schema mismatch detected',
      retryable: false,
      rawError: error,
    };
  }

  // 11. Server 5xx Errors (Transient, retryable)
  if (status && status >= 500 && status < 600) {
    return {
      code: 'SERVER_ERROR',
      category: 'SERVER_ERROR',
      message: `Server returned temporary status ${status}`,
      retryable: true,
      status,
      rawError: error,
    };
  }

  // 12. Default / Unclassified
  return {
    code: 'UNKNOWN',
    category: 'UNKNOWN',
    message,
    retryable: false,
    status,
    rawError: error,
  };
}
