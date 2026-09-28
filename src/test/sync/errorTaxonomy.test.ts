import { describe, it, expect } from 'vitest';
import { classifySyncError } from '@/lib/sync/errorTaxonomy';

describe('Phase 4: Sync Error Taxonomy', () => {
  it('classifies network timeout errors as retryable REQUEST_TIMEOUT', () => {
    const timeoutErr = new Error('request timed out');
    timeoutErr.name = 'TimeoutError';
    const classified = classifySyncError(timeoutErr);

    expect(classified.category).toBe('REQUEST_TIMEOUT');
    expect(classified.retryable).toBe(true);
    expect(classified.status).toBe(408);
  });

  it('classifies network offline and fetch failures as retryable NETWORK_UNAVAILABLE', () => {
    const fetchErr = new TypeError('Failed to fetch');
    const classified = classifySyncError(fetchErr);

    expect(classified.category).toBe('NETWORK_UNAVAILABLE');
    expect(classified.code).toBe('NETWORK_ERROR');
    expect(classified.retryable).toBe(true);
    expect(classified.status).toBe(0);
  });

  it('classifies HTTP 401 and expired JWT as non-retryable AUTH_EXPIRED', () => {
    const authErr = { status: 401, message: 'JWT expired' };
    const classified = classifySyncError(authErr);

    expect(classified.code).toBe('AUTH_EXPIRED');
    expect(classified.retryable).toBe(false);
    expect(classified.status).toBe(401);
  });

  it('classifies HTTP 403 and RLS violations as non-retryable FORBIDDEN', () => {
    const rlsErr = { status: 403, message: 'new row violates row-level security policy for table documents' };
    const classified = classifySyncError(rlsErr);

    expect(classified.code).toBe('FORBIDDEN');
    expect(classified.retryable).toBe(false);
    expect(classified.status).toBe(403);
  });

  it('classifies HTTP 404 and PGRST116 as non-retryable NOT_FOUND', () => {
    const notFoundErr = { status: 404, code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };
    const classified = classifySyncError(notFoundErr);

    expect(classified.code).toBe('NOT_FOUND');
    expect(classified.retryable).toBe(false);
  });

  it('classifies Postgres 23505 unique violations as non-retryable DUPLICATE_NAME', () => {
    const dupErr = { code: '23505', message: 'duplicate key value violates unique constraint workspace_folders_name_key' };
    const classified = classifySyncError(dupErr);

    expect(classified.code).toBe('DUPLICATE_NAME');
    expect(classified.retryable).toBe(false);
    expect(classified.status).toBe(409);
  });

  it('classifies HTTP 409 as non-retryable CONFLICT', () => {
    const conflictErr = { status: 409, message: 'Remote version is newer than base version' };
    const classified = classifySyncError(conflictErr);

    expect(classified.code).toBe('CONFLICT');
    expect(classified.retryable).toBe(false);
  });

  it('classifies HTTP 422 and foreign key violations as non-retryable VALIDATION_FAILED', () => {
    const fkErr = { code: '23503', status: 422, message: 'insert or update on table documents violates foreign key constraint' };
    const classified = classifySyncError(fkErr);

    expect(classified.code).toBe('VALIDATION_FAILED');
    expect(classified.retryable).toBe(false);
  });

  it('classifies HTTP 5xx errors as retryable SERVER_ERROR', () => {
    const srvErr = { status: 503, message: 'Service Unavailable' };
    const classified = classifySyncError(srvErr);

    expect(classified.code).toBe('SERVER_ERROR');
    expect(classified.retryable).toBe(true);
    expect(classified.status).toBe(503);
  });

  it('classifies QuotaExceededError as non-retryable STORAGE_QUOTA', () => {
    const quotaErr = new Error('Quota exceeded');
    quotaErr.name = 'QuotaExceededError';
    const classified = classifySyncError(quotaErr);

    expect(classified.code).toBe('STORAGE_QUOTA');
    expect(classified.retryable).toBe(false);
  });
});
