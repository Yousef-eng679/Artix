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

export function isValidPositiveBaseVersion(val: unknown): val is string {
  return typeof val === 'string' && /^[1-9]\d*$/.test(val);
}

function pickValidBaseVersion(primary?: string | null, fallback?: string | null): string | null {
  if (isValidPositiveBaseVersion(primary)) return primary;
  if (isValidPositiveBaseVersion(fallback)) return fallback;
  return null;
}

export class OutboxRepository {
  private db: ArtixDB;

  constructor(db?: ArtixDB) {
    this.db = db || getArtixDB();
  }

  /**
   * Direct in-transaction enqueue logic without wrapping in an extra transaction block.
   * Can be safely called inside multi-table parent transactions (e.g. [table, outbox, sync_metadata]).
   *
   * Audit Gap S-01 / Amendment C:
   * Once an entry has been dispatched over the network (`entry.dispatched === true`),
   * its `mutationId`, `operation`, and `payload` are IMMUTABLE — even if a timeout or
   * stale-lease recovery returned it to `state: 'pending'`. Subsequent local edits
   * append a new causal entry (and may coalesce into that new undispatched tail entry).
   */
  async enqueueInTx(params: EnqueueOutboxParams): Promise<OutboxEntry | null> {
    const existingEntries = (
      await this.db.outbox
        .where('[userId+entityType+entityId]')
        .equals([params.userId, params.entityType, params.entityId])
        .toArray()
    ).sort((a, b) => a.createdAt - b.createdAt);

    // Only compact against an UNDISPATCHED 'pending' tail entry
    const tailEntry = existingEntries.length > 0 ? existingEntries[existingEntries.length - 1] : undefined;
    const existing =
      tailEntry && tailEntry.state === 'pending' && !tailEntry.dispatched ? tailEntry : undefined;

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

      // Case 2: create + delete -> cancel out completely! (Undispatched entity born and died offline)
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
          baseServerVersion: pickValidBaseVersion(existing.baseServerVersion, params.baseServerVersion),
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
          baseServerVersion: pickValidBaseVersion(existing.baseServerVersion, params.baseServerVersion),
          payload: params.payload ?? null,
          localRevision: Math.max(existing.localRevision, params.localRevision),
          updatedAt: now,
        };
        await this.db.outbox.put(updated);
        return updated;
      }

      // Case 5: existing is delete and incoming is delete -> redundant no-op
      if (existing.operation === 'delete' && params.operation === 'delete') {
        if (!isValidPositiveBaseVersion(existing.baseServerVersion) && isValidPositiveBaseVersion(params.baseServerVersion)) {
          const healed: OutboxEntry = {
            ...existing,
            baseServerVersion: params.baseServerVersion,
            updatedAt: now,
          };
          await this.db.outbox.put(healed);
          return healed;
        }
        return existing;
      }

      // Case 6: existing is delete and incoming is update -> explicit restore/un-delete
      if (existing.operation === 'delete' && params.operation === 'update') {
        const updated: OutboxEntry = {
          ...existing,
          mutationId: stableMutationId,
          operation: 'update',
          baseServerVersion: pickValidBaseVersion(existing.baseServerVersion, params.baseServerVersion),
          payload: params.payload ?? null,
          localRevision: Math.max(existing.localRevision, params.localRevision),
          updatedAt: now,
        };
        await this.db.outbox.put(updated);
        return updated;
      }

      // Case 7: existing is delete and incoming is create -> replace with create
      if (existing.operation === 'delete' && params.operation === 'create') {
        const updated: OutboxEntry = {
          ...existing,
          mutationId: crypto.randomUUID(),
          operation: 'create',
          baseServerVersion: null,
          payload: params.payload,
          localRevision: Math.max(existing.localRevision, params.localRevision),
          updatedAt: now,
        };
        await this.db.outbox.put(updated);
        return updated;
      }
    }

    // No compactable undispatched entry found; append a new causal entry with strictly monotonic createdAt
    const monotonicCreatedAt = existingEntries.reduce(
      (maxTs, entry) => Math.max(maxTs, entry.createdAt + 1),
      now,
    );

    const normalizedBase =
      params.operation === 'create'
        ? null
        : pickValidBaseVersion(params.baseServerVersion, null);

    const newEntry: OutboxEntry = {
      id: crypto.randomUUID(),
      mutationId: params.mutationId || crypto.randomUUID(),
      userId: params.userId,
      projectId: params.projectId,
      entityType: params.entityType,
      entityId: params.entityId,
      operation: params.operation,
      baseServerVersion: normalizedBase,
      localRevision: params.localRevision,
      payload: params.payload,
      state: 'pending',
      dispatched: false,
      attemptCount: 0,
      createdAt: monotonicCreatedAt,
      updatedAt: monotonicCreatedAt,
    };

    await this.db.outbox.add(newEntry);
    return newEntry;
  }

  /**
   * Enqueues a mutation into the outbox with automatic compaction/coalescing.
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
   * If options.readyOnly is true:
   * - Filters out entries currently waiting in backoff (nextRetryAt > now).
   * - Enforces the Per-Entity Causal Barrier (TASK-07 / Amendment C): a subsequent
   *   pending entry `E2` for `(userId, entityType, entityId)` is NEVER returned while
   *   an earlier entry `E1` for that same entity is `in_flight`, `blocked`, `failed`,
   *   or `pending` in backoff.
   */
  async getPending(
    limit?: number,
    userId?: string,
    options?: { readyOnly?: boolean; now?: number }
  ): Promise<OutboxEntry[]> {
    if (options?.readyOnly) {
      const now = options.now ?? Date.now();
      const allEntries = userId
        ? await this.db.outbox.where('userId').equals(userId).toArray()
        : await this.db.outbox.toArray();

      const byEntity = new Map<string, OutboxEntry[]>();
      for (const entry of allEntries) {
        const key = `${entry.userId}:${entry.entityType}:${entry.entityId}`;
        const list = byEntity.get(key);
        if (list) {
          list.push(entry);
        } else {
          byEntity.set(key, [entry]);
        }
      }

      const eligible: OutboxEntry[] = [];
      for (const chain of byEntity.values()) {
        chain.sort((a, b) => a.createdAt - b.createdAt);
        for (const entry of chain) {
          const isReady =
            entry.state === 'pending' && (!entry.nextRetryAt || entry.nextRetryAt <= now);
          if (!isReady) {
            // Causal barrier: stop evaluating later entries for this same entity
            break;
          }
          eligible.push(entry);
        }
      }

      eligible.sort((a, b) => a.createdAt - b.createdAt);
      if (limit && limit > 0) {
        return eligible.slice(0, limit);
      }
      return eligible;
    }

    const collection = this.db.outbox.where('state').equals('pending');
    const entries = await collection.sortBy('createdAt');
    let filtered = entries;

    if (userId) {
      filtered = filtered.filter((e) => e.userId === userId);
    }

    if (limit && limit > 0) {
      filtered = filtered.slice(0, limit);
    }
    return filtered;
  }

  /**
   * Retrieves all non-completed outbox entries for a specific entity.
   */
  async listByEntity(userId: string, entityType: EntityType, entityId: string): Promise<OutboxEntry[]> {
    const entries = await this.db.outbox
      .where('[userId+entityType+entityId]')
      .equals([userId, entityType, entityId])
      .toArray();
    return entries.sort((a, b) => a.createdAt - b.createdAt);
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
   * stamping the immutable `dispatched = true` flag, lease owner, and expiration timestamp.
   */
  async markInFlight(
    id: string,
    leaseOwner = 'sync_engine',
    leaseDurationMs = 30000
  ): Promise<void> {
    const now = Date.now();
    await this.db.transaction('rw', this.db.outbox, async () => {
      const existing = await this.db.outbox.get(id);
      if (!existing) return;
      await this.db.outbox.put({
        ...existing,
        state: 'in_flight',
        dispatched: true,
        dispatchedAt: existing.dispatchedAt ?? now,
        leaseOwner,
        leaseExpiresAt: now + leaseDurationMs,
        updatedAt: now,
      });
    });
  }

  /**
   * Reclaims stale 'in_flight' entries whose lease has expired,
   * or entries orphaned by other crashed tabs when promoted to leader,
   * restoring them back to 'pending' state while preserving `dispatched: true`.
   */
  async recoverStaleLeases(
    optionsOrNow?:
      | number
      | {
          now?: number;
          forceOrphanedByOtherTabs?: boolean;
          currentTabId?: string;
        }
  ): Promise<number> {
    const opts =
      typeof optionsOrNow === 'number'
        ? { now: optionsOrNow }
        : optionsOrNow || {};
    const now = opts.now ?? Date.now();
    const { forceOrphanedByOtherTabs, currentTabId } = opts;

    return await this.db.transaction('rw', this.db.outbox, async () => {
      const inFlightEntries = await this.db.outbox
        .where('state')
        .equals('in_flight')
        .toArray();

      let recoveredCount = 0;
      for (const entry of inFlightEntries) {
        const isStaleByTime = !entry.leaseExpiresAt || entry.leaseExpiresAt <= now;
        const isOrphanedByOtherTab =
          Boolean(forceOrphanedByOtherTabs) &&
          Boolean(currentTabId) &&
          Boolean(entry.leaseOwner) &&
          entry.leaseOwner !== currentTabId;

        if (isStaleByTime || isOrphanedByOtherTab) {
          await this.db.outbox.update(entry.id, {
            state: 'pending',
            dispatched: true,
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
   * Preserves `entry.dispatched` immutably.
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
        const exponent = Math.max(0, attemptCount - 1);
        const baseDelay = Math.min(1000 * Math.pow(2, exponent), 30000);
        const jitter = Math.floor(Math.random() * Math.min(500, baseDelay));
        nextRetryAt = now + baseDelay + jitter;
      }

      const updated: OutboxEntry = {
        ...entry,
        attemptCount,
        state,
        dispatched: entry.dispatched ? true : false,
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
   * Converts an orphan local update entry (that has never existed on the server) into a create operation.
   */
  async convertToCreate(id: string, payload: unknown): Promise<void> {
    await this.db.outbox.update(id, {
      operation: 'create',
      baseServerVersion: null,
      payload,
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
