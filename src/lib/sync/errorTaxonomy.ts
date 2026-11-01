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
  | 'RATE_LIMITED'
  | 'TIER_LIMIT_EXCEEDED'
  | 'UNKNOWN';

export interface ClassifiedSyncError {
  code: SyncErrorCode;
  category: SyncErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
  /** Server-requested minimum delay before retrying (from `Retry-After`), capped at MAX_SYNC_BACKOFF_MS. */
  retryAfterMs?: number;
  rawError?: unknown;
}

/** Hard ceiling for any scheduled sync retry delay (5 minutes). */
export const MAX_SYNC_BACKOFF_MS = 300_000;

function readHeader(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as any).get === 'function') {
    const v = (headers as any).get(name);
    return v === null || v === undefined ? null : String(v);
  }
  if (typeof headers === 'object') {
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === target && value !== undefined && value !== null) {
        return String(value);
      }
    }
  }
  return null;
}

/**
 * Parses an HTTP `Retry-After` value (delta-seconds or HTTP-date) into milliseconds,
 * clamped to `[0, MAX_SYNC_BACKOFF_MS]`. Returns `undefined` when absent/unparseable.
 */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;

  let ms: number | undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    ms = Math.round(Number(trimmed) * 1000);
  } else {
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) {
      ms = dateMs - now;
    }
  }
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return Math.min(MAX_SYNC_BACKOFF_MS, Math.max(0, ms));
}

function isLocalQuotaExceeded(err: any): boolean {
  if (!err) return false;
  if (err.name === 'QuotaExceededError') return true;
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.code === 22) return true;
  // Dexie wraps IndexedDB failures and exposes the original DOMException as `inner`
  if (err.inner && err.inner !== err) return isLocalQuotaExceeded(err.inner);
  return false;
}

const TIER_LIMIT_PATTERN = /\btier\b[^.]*\blimit\b[^.]*\breached\b/i;

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

  // 0a. Local browser storage quota (IndexedDB / DOMException code 22).
  // Matched strictly by error identity — never by a "quota" substring in server messages (OF-13).
  if (isLocalQuotaExceeded(err)) {
    return {
      code: 'STORAGE_QUOTA',
      category: 'STORAGE_QUOTA',
      message: 'Local browser storage quota exceeded',
      retryable: false,
      rawError: error,
    };
  }

  // 0b. HTTP 429 rate limiting -> retryable, honoring Retry-After
  if (status === 429 || rawCode === '429') {
    const retryAfterMs = parseRetryAfterMs(
      readHeader(err.headers, 'retry-after') ??
        (err.retryAfter !== undefined ? String(err.retryAfter) : null)
    );
    return {
      code: 'RATE_LIMITED',
      category: 'RATE_LIMITED',
      message: 'Server rate limit reached; retrying later',
      retryable: true,
      status: 429,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      rawError: error,
    };
  }

  // 0c. Server-side plan tier limit (public.check_plan_tier_limit) -> non-retryable, local data preserved
  if (TIER_LIMIT_PATTERN.test(message)) {
    return {
      code: 'TIER_LIMIT_EXCEEDED',
      category: 'TIER_LIMIT_EXCEEDED',
      message,
      retryable: false,
      status: status ?? 403,
      rawError: error,
    };
  }

  // 0. Deterministic local validation / missing RPC schema errors (must not be masked when offline)
  if (rawCode === 'INVALID_CAS_BASELINE' || rawCode === '22023') {
    return {
      code: 'VALIDATION_FAILED',
      category: 'VALIDATION_FAILED',
      message: message || 'Missing or invalid CAS baseServerVersion',
      retryable: false,
      status: status || 422,
      rawError: error,
    };
  }

  if (
    rawCode === 'SCHEMA_ERROR' ||
    rawCode === 'PGRST202' ||
    rawCode === '42883' ||
    rawCode === '42703' ||
    lowerMsg.includes('column does not exist') ||
    lowerMsg.includes('schema mismatch') ||
    lowerMsg.includes('could not find the function')
  ) {
    return {
      code: 'SCHEMA_ERROR',
      category: 'SCHEMA_ERROR',
      message: message || 'Database schema mismatch detected',
      retryable: false,
      rawError: error,
    };
  }

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

  // 3. (Local storage quota is classified up-front by error identity — see 0a.)

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

  // 10. Server 5xx Errors (Transient, retryable)
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

  // 11. Default / Unclassified
  return {
    code: 'UNKNOWN',
    category: 'UNKNOWN',
    message,
    retryable: false,
    status,
    rawError: error,
  };
}
