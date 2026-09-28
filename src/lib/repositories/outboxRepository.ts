import { ArtixDB, getArtixDB } from '../local/db';
import { EntityType, OutboxEntry, OutboxOperation, OutboxState } from '../local/types';

export interface EnqueueOutboxParams {
  userId: string;
  projectId: string | null;
  entityType: EntityType;
  entityId: string;
  operation: OutboxOperation;
  payload: unknown;
  localRevision: number;
  baseServerVersion?: string | null;
  mutationId?: string;
}

export class OutboxRepository {
  private db: ArtixDB;

  constructor(db?: ArtixDB) {
    this.db = db || getArtixDB();
  }

  /**
   * Direct in-transaction enqueue logic without wrapping in an extra transaction block.
   * Can be safely called inside multi-table parent transactions (e.g. [table, outbox, sync_metadata]).
   */
  async enqueueInTx(params: EnqueueOutboxParams): Promise<OutboxEntry | null> {
    // Find any existing pending or in_flight entry for this exact entity
    const existingEntries = await this.db.outbox
      .where('[userId+entityType+entityId]')
      .equals([params.userId, params.entityType, params.entityId])
      .toArray();

    // We only compact against entries that are currently 'pending'
    const existing = existingEntries.find((e) => e.state === 'pending');

    const now = Date.now();

    if (existing) {
      const stableMutationId = existing.mutationId || existing.id || crypto.randomUUID();

      // Case 1: create + update -> keep as create, merge payload
      if (existing.operation === 'create' && params.operation === 'update') {
        const mergedPayload = this.mergePayloads(existing.payload, params.payload);
        const updated: OutboxEntry = {
          ...existing,
          mutationId: stableMutationId,
          payload: mergedPayload,
          localRevision: Math.max(existing.localRevision, params.localRevision),
          updatedAt: now,
        };
        await this.db.outbox.put(updated);
        return updated;
      }

      // Case 2: create + delete -> cancel out completely! (Entity was born and died offline)
      if (existing.operation === 'create' && params.operation === 'delete') {
        await this.db.outbox.delete(existing.id);
        return null;
      }

      // Case 3: update + update -> merge payload and bump revision
      if (existing.operation === 'update' && params.operation === 'update') {
        const mergedPayload = this.mergePayloads(existing.payload, params.payload);
        const updated: OutboxEntry = {
          ...existing,
          mutationId: stableMutationId,
          baseServerVersion: existing.baseServerVersion ?? params.baseServerVersion ?? null,
          payload: mergedPayload,
          localRevision: Math.max(existing.localRevision, params.localRevision),
          updatedAt: now,
        };
        await this.db.outbox.put(updated);
        return updated;
      }

      // Case 4: update + delete -> convert to delete
      if (existing.operation === 'update' && params.operation === 'delete') {
        const updated: OutboxEntry = {
          ...existing,
          mutationId: stableMutationId,
          operation: 'delete',
          baseServerVersion: existing.baseServerVersion ?? params.baseServerVersion ?? null,
          payload: params.payload ?? null,
          localRevision: Math.max(existing.localRevision, params.localRevision),
          updatedAt: now,
        };
        await this.db.outbox.put(updated);
        return updated;
      }

      // Case 5: existing is delete and incoming is delete -> redundant no-op
      if (existing.operation === 'delete' && params.operation === 'delete') {
        return existing;
      }
    }

    // No compactable pending entry found; append new entry
    const newEntry: OutboxEntry = {
      id: crypto.randomUUID(),
      mutationId: params.mutationId || crypto.randomUUID(),
      userId: params.userId,
      projectId: params.projectId,
      entityType: params.entityType,
      entityId: params.entityId,
      operation: params.operation,
      baseServerVersion: params.baseServerVersion ?? null,
      localRevision: params.localRevision,
      payload: params.payload,
      state: 'pending',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.outbox.add(newEntry);
    return newEntry;
  }

  /**
   * Enqueues a mutation into the outbox with automatic compaction/coalescing.
   * Compaction rules:
   * 1. create + update -> create with updated/merged payload
   * 2. create + delete -> cancelled completely (removes entry, returns null)
   * 3. update + update -> update with merged payload and latest localRevision
   * 4. update + delete -> converts operation to delete
   */
  async enqueue(params: EnqueueOutboxParams): Promise<OutboxEntry | null> {
    return await this.db.transaction('rw', this.db.outbox, async () => {
      return await this.enqueueInTx(params);
    });
  }

  /**
   * Helper to merge two payloads cleanly.
   */
  private mergePayloads(base: unknown, incoming: unknown): unknown {
    if (base && typeof base === 'object' && incoming && typeof incoming === 'object') {
      return {
        ...(base as Record<string, unknown>),
        ...(incoming as Record<string, unknown>),
      };
    }
    return incoming ?? base;
  }

  /**
   * Retrieves pending outbox entries ordered chronologically (FIFO).
   * If options.readyOnly is true, filters out entries currently waiting in backoff (nextRetryAt > now).
   */
  async getPending(
    limit?: number,
    userId?: string,
    options?: { readyOnly?: boolean; now?: number }
  ): Promise<OutboxEntry[]> {
    const collection = this.db.outbox.where('state').equals('pending');

    const entries = await collection.sortBy('createdAt');
    let filtered = entries;

    if (options?.readyOnly) {
      const now = options.now ?? Date.now();
      filtered = filtered.filter((e) => !e.nextRetryAt || e.nextRetryAt <= now);
    }

    if (userId) {
      filtered = filtered.filter((e) => e.userId === userId);
    }

    if (limit && limit > 0) {
      filtered = filtered.slice(0, limit);
    }
    return filtered;
  }

  /**
   * Retrieves in-flight entries.
   */
  async getInFlight(userId?: string): Promise<OutboxEntry[]> {
    const entries = await this.db.outbox.where('state').equals('in_flight').toArray();
    return userId ? entries.filter((e) => e.userId === userId) : entries;
  }

  /**
   * Retrieves an outbox entry by ID.
   */
  async getById(id: string): Promise<OutboxEntry | undefined> {
    return await this.db.outbox.get(id);
  }

  /**
   * Marks an outbox entry as 'in_flight' while it is being synchronized,
   * stamping the lease owner and expiration timestamp.
   */
  async markInFlight(
    id: string,
    leaseOwner = 'sync_engine',
    leaseDurationMs = 30000
  ): Promise<void> {
    const now = Date.now();
    await this.db.outbox.update(id, {
      state: 'in_flight',
      leaseOwner,
      leaseExpiresAt: now + leaseDurationMs,
      updatedAt: now,
    });
  }

  /**
   * Reclaims stale 'in_flight' entries whose lease has expired,
   * restoring them back to 'pending' state so they can be re-synchronized.
   * Useful on SyncEngine startup or before draining outbox.
   */
  async recoverStaleLeases(now = Date.now()): Promise<number> {
    return await this.db.transaction('rw', this.db.outbox, async () => {
      const inFlightEntries = await this.db.outbox
        .where('state')
        .equals('in_flight')
        .toArray();

      let recoveredCount = 0;
      for (const entry of inFlightEntries) {
        if (!entry.leaseExpiresAt || entry.leaseExpiresAt <= now) {
          await this.db.outbox.update(entry.id, {
            state: 'pending',
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: now,
          });
          recoveredCount++;
        }
      }
      return recoveredCount;
    });
  }

  /**
   * Marks an outbox entry as completed by removing it from the durable outbox.
   */
  async markCompleted(id: string): Promise<void> {
    await this.db.outbox.delete(id);
  }

  /**
   * Handles a sync failure: increments attempt count and marks as 'blocked' or schedules jittered backoff.
   * If error.retryable is explicitly false, transitions to 'blocked' immediately.
   */
  async markFailed(
    id: string,
    error: { code: string; message: string; retryable?: boolean },
    maxRetries = 5
  ): Promise<OutboxEntry | undefined> {
    return await this.db.transaction('rw', this.db.outbox, async () => {
      const entry = await this.db.outbox.get(id);
      if (!entry) return undefined;

      const isRetryable = error.retryable !== false;
      const attemptCount = entry.attemptCount + 1;
      const isBlocked = !isRetryable || attemptCount >= maxRetries;
      const state: OutboxState = isBlocked ? 'blocked' : 'pending';

      const now = Date.now();
      let nextRetryAt: number | null = null;
      if (!isBlocked && isRetryable) {
        // Full jitter exponential backoff: min(1000 * 2^(attempts-1) + jitter, 30000)
        const exponent = Math.max(0, attemptCount - 1);
        const baseDelay = Math.min(1000 * Math.pow(2, exponent), 30000);
        const jitter = Math.floor(Math.random() * Math.min(500, baseDelay));
        nextRetryAt = now + baseDelay + jitter;
      }

      const updated: OutboxEntry = {
        ...entry,
        attemptCount,
        state,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextRetryAt,
        lastError: {
          code: error.code,
          message: error.message,
          at: now,
        },
        updatedAt: now,
      };

      await this.db.outbox.put(updated);
      return updated;
    });
  }

  /**
   * Returns count of currently pending entries.
   */
  async countPending(userId?: string): Promise<number> {
    const entries = await this.getPending(undefined, userId);
    return entries.length;
  }

  /**
   * Updates baseServerVersion for a pending outbox entry (e.g. after previous mutation in pipeline succeeded).
   */
  async updateBaseServerVersion(id: string, baseServerVersion: string): Promise<void> {
    await this.db.outbox.update(id, {
      baseServerVersion,
      updatedAt: Date.now(),
    });
  }

  /**
   * Clears outbox entries (useful in testing or manual sync resets).
   */
  async clear(userId?: string): Promise<void> {
    if (userId) {
      await this.db.outbox.where('userId').equals(userId).delete();
    } else {
      await this.db.outbox.clear();
    }
  }
}
