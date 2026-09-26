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
}

export class OutboxRepository {
  private db: ArtixDB;

  constructor(db?: ArtixDB) {
    this.db = db || getArtixDB();
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
      // Find any existing pending or in_flight entry for this exact entity
      const existingEntries = await this.db.outbox
        .where('[userId+entityType+entityId]')
        .equals([params.userId, params.entityType, params.entityId])
        .toArray();

      // We only compact against entries that are currently 'pending'
      const existing = existingEntries.find((e) => e.state === 'pending');

      const now = Date.now();

      if (existing) {
        // Case 1: create + update -> keep as create, merge payload
        if (existing.operation === 'create' && params.operation === 'update') {
          const mergedPayload = this.mergePayloads(existing.payload, params.payload);
          const updated: OutboxEntry = {
            ...existing,
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
            operation: 'delete',
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
   */
  async getPending(limit?: number, userId?: string): Promise<OutboxEntry[]> {
    const collection = this.db.outbox.where('state').equals('pending');

    const entries = await collection.sortBy('createdAt');
    let filtered = userId ? entries.filter((e) => e.userId === userId) : entries;

    if (limit && limit > 0) {
      filtered = filtered.slice(0, limit);
    }
    return filtered;
  }

  /**
   * Retrieves an outbox entry by ID.
   */
  async getById(id: string): Promise<OutboxEntry | undefined> {
    return await this.db.outbox.get(id);
  }

  /**
   * Marks an outbox entry as 'in_flight' while it is being synchronized.
   */
  async markInFlight(id: string): Promise<void> {
    await this.db.outbox.update(id, {
      state: 'in_flight',
      updatedAt: Date.now(),
    });
  }

  /**
   * Marks an outbox entry as completed by removing it from the durable outbox.
   */
  async markCompleted(id: string): Promise<void> {
    await this.db.outbox.delete(id);
  }

  /**
   * Handles a sync failure: increments attempt count and marks as 'blocked' or keeps as 'pending' for retry.
   */
  async markFailed(
    id: string,
    error: { code: string; message: string },
    maxRetries = 5
  ): Promise<OutboxEntry | undefined> {
    return await this.db.transaction('rw', this.db.outbox, async () => {
      const entry = await this.db.outbox.get(id);
      if (!entry) return undefined;

      const attemptCount = entry.attemptCount + 1;
      const state: OutboxState = attemptCount >= maxRetries ? 'blocked' : 'pending';

      const updated: OutboxEntry = {
        ...entry,
        attemptCount,
        state,
        lastError: {
          code: error.code,
          message: error.message,
          at: Date.now(),
        },
        updatedAt: Date.now(),
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
