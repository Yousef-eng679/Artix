import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ArtixDB, closeAllArtixDBs } from '@/lib/local/db';
import { DocumentRepository } from '@/lib/repositories/documentRepository';
import { ProjectRepository } from '@/lib/repositories/projectRepository';
import { OutboxRepository } from '@/lib/repositories/outboxRepository';
import { SyncMetadataRepository } from '@/lib/repositories/syncMetadataRepository';
import { ConflictRepository } from '@/lib/repositories/conflictRepository';
import { PullEngine } from '@/lib/sync/pullEngine';
import { SyncEngine, evictSyncEngine } from '@/lib/sync/syncEngine';
import { TabCoordinator, evictTabCoordinator, getTabCoordinator } from '@/lib/sync/tabCoordinator';
import { setDraft, getDraft } from '@/lib/cache/draftRecovery';

interface ServerEntityRow {
  id: string;
  user_id: string;
  project_id?: string | null;
  folder_id?: string | null;
  parent_folder_id?: string | null;
  name?: string;
  title?: string;
  content?: string;
  format?: string;
  board_state?: unknown;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface SyncChangeFeedRow {
  sequence: number;
  user_id: string;
  project_id: string | null;
  entity_type: 'project' | 'document' | 'system_design' | 'workspace_folder';
  entity_id: string;
  operation: 'create' | 'update' | 'delete';
  entity_version: number;
  changed_at: string;
  payload: Record<string, unknown>;
  mutation_id: string | null;
}

/**
 * Layer 2 Controllable Fake Supabase Server (`TASK-12`):
 * Implements real `apply_sync_mutation` CAS + `processed_mutations` idempotency +
 * `sync_changes` monotonic sequence feed + `get_sync_feed_bounds` + live entity tables,
 * with deterministic fault-injection hooks (lost HTTP ack after commit, stalled RPC gates).
 */
class ControllableFakeSupabaseServer {
  private seq = 0;
  tables: Record<
    'projects' | 'documents' | 'system_designs' | 'workspace_folders',
    Map<string, ServerEntityRow>
  > = {
    projects: new Map(),
    documents: new Map(),
    system_designs: new Map(),
    workspace_folders: new Map(),
  };

  syncChanges: SyncChangeFeedRow[] = [];
  processedMutations = new Map<string, Record<string, unknown>>();
  dropNextResponseAfterCommit = false;

  private entityToTable(entityType: string) {
    switch (entityType) {
      case 'project':
        return 'projects' as const;
      case 'document':
        return 'documents' as const;
      case 'system_design':
        return 'system_designs' as const;
      case 'workspace_folder':
        return 'workspace_folders' as const;
      default:
        throw new Error(`Unsupported entity_type: ${entityType}`);
    }
  }

  private recordChange(
    entityType: SyncChangeFeedRow['entity_type'],
    op: SyncChangeFeedRow['operation'],
    row: ServerEntityRow,
    mutationId: string | null,
  ) {
    this.seq += 1;
    this.syncChanges.push({
      sequence: this.seq,
      user_id: row.user_id,
      project_id: entityType === 'project' ? row.id : (row.project_id ?? null),
      entity_type: entityType,
      entity_id: row.id,
      operation: op,
      entity_version: row.version,
      changed_at: row.updated_at,
      payload: structuredClone(row) as unknown as Record<string, unknown>,
      mutation_id: mutationId,
    });
  }

  createClientForUser(activeUserIdGetter: () => string) {
    const server = this;

    const makeTableBuilder = (tableName: string) => {
      const filters: Array<(row: any) => boolean> = [];
      let gtCol: string | null = null;
      let gtVal: number | null = null;
      let limitVal: number | null = null;

      const executeSelect = async () => {
        const uid = activeUserIdGetter();
        if (tableName === 'sync_changes') {
          let rows = server.syncChanges.filter((r) => r.user_id === uid);
          for (const f of filters) rows = rows.filter(f);
          if (gtCol === 'sequence' && gtVal !== null) {
            rows = rows.filter((r) => r.sequence > gtVal!);
          }
          rows = [...rows].sort((a, b) => a.sequence - b.sequence);
          if (limitVal !== null) rows = rows.slice(0, limitVal);
          return { data: structuredClone(rows), error: null };
        }

        const map =
          server.tables[tableName as keyof typeof server.tables] ??
          new Map<string, ServerEntityRow>();
        let rows = Array.from(map.values()).filter((r) => r.user_id === uid);
        for (const f of filters) rows = rows.filter(f);
        return { data: structuredClone(rows), error: null };
      };

      const builder: any = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return builder;
        },
        is: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return builder;
        },
        gt: (col: string, val: number) => {
          gtCol = col;
          gtVal = val;
          return builder;
        },
        order: () => builder,
        limit: (n: number) => {
          limitVal = n;
          return builder;
        },
        maybeSingle: async () => {
          const res = await executeSelect();
          return { data: res.data[0] ?? null, error: null };
        },
        single: async () => {
          const res = await executeSelect();
          if (!res.data[0]) {
            return { data: null, error: { code: 'PGRST116', message: 'Row not found' } };
          }
          return { data: res.data[0], error: null };
        },
        then: (onFulfilled: any, onRejected: any) =>
          executeSelect().then(onFulfilled, onRejected),
      };
      return builder;
    };

    return {
      from: (tableName: string) => makeTableBuilder(tableName),
      rpc: async (fnName: string, args: Record<string, any>) => {
        const uid = activeUserIdGetter();

        if (fnName === 'get_sync_feed_bounds') {
          const userChanges = server.syncChanges.filter((c) => c.user_id === uid);
          const maxSeq =
            userChanges.length > 0 ? userChanges[userChanges.length - 1].sequence : 0;
          return {
            data: [{ min_retained_sequence: 0, max_sequence: maxSeq }],
            error: null,
          };
        }

        if (fnName !== 'apply_sync_mutation') {
          return { data: null, error: { message: `Unknown RPC ${fnName}` } };
        }

        if (args.p_user_id !== uid) {
          return { data: null, error: { status: 403, message: 'Unauthorized p_user_id' } };
        }

        const mutationKey = `${uid}:${args.p_mutation_id}`;
        if (server.processedMutations.has(mutationKey)) {
          return {
            data: structuredClone(server.processedMutations.get(mutationKey)!),
            error: null,
          };
        }

        const entityType = args.p_entity_type as SyncChangeFeedRow['entity_type'];
        const tableName = server.entityToTable(entityType);
        const table = server.tables[tableName];
        const entityId = String(args.p_entity_id);
        const op = String(args.p_operation);
        const payload = (args.p_payload ?? {}) as Record<string, any>;
        const nowIso = new Date().toISOString();
        const existing = table.get(entityId);

        let response: Record<string, unknown>;

        if (op === 'create') {
          const nextVer = existing && existing.deleted_at === null ? existing.version : 1;
          const row: ServerEntityRow = {
            id: entityId,
            user_id: uid,
            project_id:
              entityType === 'project' ? null : (args.p_project_id ?? payload.projectId ?? null),
            folder_id: payload.folderId ?? payload.folder_id ?? null,
            parent_folder_id: payload.parentFolderId ?? payload.parent_folder_id ?? null,
            name: payload.name,
            title: payload.title,
            content: payload.content ?? '',
            format: payload.format ?? 'markdown',
            board_state: payload.boardState ?? payload.board_state,
            version: nextVer,
            created_at: existing?.created_at ?? nowIso,
            updated_at: nowIso,
            deleted_at: null,
          };
          table.set(entityId, row);
          server.recordChange(entityType, 'create', row, args.p_mutation_id);
          response = {
            status: 'applied',
            version: row.version,
            updated_at: row.updated_at,
          };
          server.processedMutations.set(mutationKey, response);
        } else if (op === 'update') {
          const baseVer = Number(args.p_base_version);
          if (!Number.isInteger(baseVer) || baseVer < 1) {
            return {
              data: null,
              error: { code: '22023', status: 422, message: 'p_base_version >= 1 required' },
            };
          }

          if (!existing || existing.deleted_at !== null) {
            return {
              data: {
                status: 'conflict',
                reason: 'remote_deleted',
                current_version: null,
                current_row: null,
              },
              error: null,
            };
          }

          if (existing.version !== baseVer) {
            return {
              data: {
                status: 'conflict',
                reason: 'version_mismatch',
                current_version: existing.version,
                current_row: structuredClone(existing),
              },
              error: null,
            };
          }

          const updated: ServerEntityRow = {
            ...existing,
            ...(payload.name !== undefined ? { name: payload.name } : {}),
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.content !== undefined ? { content: payload.content } : {}),
            ...(payload.format !== undefined ? { format: payload.format } : {}),
            ...(payload.folderId !== undefined ? { folder_id: payload.folderId } : {}),
            ...(payload.boardState !== undefined ? { board_state: payload.boardState } : {}),
            version: existing.version + 1,
            updated_at: nowIso,
          };
          table.set(entityId, updated);
          server.recordChange(entityType, 'update', updated, args.p_mutation_id);
          response = {
            status: 'applied',
            version: updated.version,
            updated_at: updated.updated_at,
          };
          server.processedMutations.set(mutationKey, response);
        } else if (op === 'delete') {
          const baseVer = Number(args.p_base_version);
          if (!Number.isInteger(baseVer) || baseVer < 1) {
            return {
              data: null,
              error: { code: '22023', status: 422, message: 'p_base_version >= 1 required' },
            };
          }

          if (!existing || existing.deleted_at !== null) {
            response = { status: 'applied', version: null, updated_at: nowIso };
            server.processedMutations.set(mutationKey, response);
          } else if (existing.version !== baseVer) {
            return {
              data: {
                status: 'conflict',
                reason: 'version_mismatch',
                current_version: existing.version,
                current_row: structuredClone(existing),
              },
              error: null,
            };
          } else {
            const tombstoned: ServerEntityRow = {
              ...existing,
              version: existing.version + 1,
              updated_at: nowIso,
              deleted_at: nowIso,
            };
            table.set(entityId, tombstoned);
            server.recordChange(entityType, 'delete', tombstoned, args.p_mutation_id);
            response = {
              status: 'applied',
              version: tombstoned.version,
              updated_at: nowIso,
            };
            server.processedMutations.set(mutationKey, response);
          }
        } else {
          return { data: null, error: { message: `Unsupported op ${op}` } };
        }

        if (server.dropNextResponseAfterCommit) {
          server.dropNextResponseAfterCommit = false;
          throw new TypeError('Failed to fetch (simulated HTTP drop after server commit)');
        }

        return { data: structuredClone(response), error: null };
      },
    };
  }
}

function makeLeaderCoordinator(tabId: string): TabCoordinator {
  const coord = new TabCoordinator({ channelName: `fault-inject-${tabId}-${crypto.randomUUID()}` });
  vi.spyOn(coord, 'isLeaderTab').mockReturnValue(true);
  vi.spyOn(coord, 'getTabId').mockReturnValue(tabId);
  return coord;
}

function makeDeviceStack(userId: string, dbName: string, supabaseClient: any, tabId: string) {
  const db = new ArtixDB(dbName);
  const outboxRepo = new OutboxRepository(db);
  const syncMetaRepo = new SyncMetadataRepository(db);
  const conflictRepo = new ConflictRepository(db);
  const projectRepo = new ProjectRepository(db, outboxRepo, syncMetaRepo);
  const docRepo = new DocumentRepository(db, outboxRepo, syncMetaRepo);
  const coordinator = makeLeaderCoordinator(tabId);
  const pullEngine = new PullEngine({
    supabaseClient,
    db,
    conflictRepo,
    syncMetadataRepo: syncMetaRepo,
    tabCoordinator: coordinator,
  });
  const syncEngine = new SyncEngine({
    userId,
    autoSyncOnEnqueue: false,
    supabaseClient,
    outboxRepo,
    syncMetadataRepo: syncMetaRepo,
    conflictRepo,
    pullEngine,
    tabCoordinator: coordinator,
  });

  return {
    db,
    outboxRepo,
    syncMetaRepo,
    conflictRepo,
    projectRepo,
    docRepo,
    pullEngine,
    syncEngine,
  };
}

describe('TASK-12: Layer 2 Controllable Fake-Server Distributed Sync Fault-Injection Suite', () => {
  const openDbs: ArtixDB[] = [];
  const engines: SyncEngine[] = [];

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const eng of engines.splice(0)) {
      eng.destroy();
    }
    await closeAllArtixDBs();
    for (const db of openDbs.splice(0)) {
      db.close();
      await db.delete();
    }
    localStorage.clear();
  });

  it('1. S-01: converges with zero conflict when HTTP ack is lost after commit, user edits P2 locally, and pull sees M1 self-echo', async () => {
    const userId = '11111111-aaaa-4111-8111-111111111111';
    const server = new ControllableFakeSupabaseServer();
    const clientA = server.createClientForUser(() => userId);
    const clientB = server.createClientForUser(() => userId);

    const devA = makeDeviceStack(userId, `s01_devA_${crypto.randomUUID()}`, clientA, 'tab-dev-a');
    const devB = makeDeviceStack(userId, `s01_devB_${crypto.randomUUID()}`, clientB, 'tab-dev-b');
    openDbs.push(devA.db, devB.db);
    engines.push(devA.syncEngine, devB.syncEngine);
    await Promise.all([devA.db.open(), devB.db.open()]);

    const proj = await devA.projectRepo.create({ userId, name: 'Core Platform' });
    const doc = await devA.docRepo.create({
      userId,
      projectId: proj.id,
      title: 'Distributed Spec',
      content: 'v1 initial baseline',
      format: 'markdown',
    });
    await devA.syncEngine.triggerSync(userId);

    // Edit P1 on Device A, then drop HTTP response AFTER server commits M1 (v2)
    await devA.docRepo.update(doc.id, { content: 'P1 committed before network drop' });
    server.dropNextResponseAfterCommit = true;
    await devA.syncEngine.drainOutbox(userId);

    // Server already committed v2 ('P1 committed before network drop'), while M1 in Device A has dispatched === true
    expect(server.tables.documents.get(doc.id)?.version).toBe(2);
    const afterDropOutbox = await devA.outboxRepo.listByEntity(userId, 'document', doc.id);
    expect(afterDropOutbox).toHaveLength(1);
    expect(afterDropOutbox[0].dispatched).toBe(true);

    // While offline/retrying, user types P2 locally on Device A!
    await devA.docRepo.update(doc.id, { content: 'P2 newer local edit must survive' });
    const queuedEntries = await devA.outboxRepo.listByEntity(userId, 'document', doc.id);
    expect(queuedEntries).toHaveLength(2);

    // Clear retry backoff on M1 so reconnect sync runs pull + drain immediately
    await devA.db.outbox.update(afterDropOutbox[0].id, { nextRetryAt: 0 });

    // Reconnect sync on Device A: PullEngine sees M1 self-echo, preserves local P2, advances M2 base to v2, and pushes M2 -> v3!
    await devA.syncEngine.triggerSync(userId);

    expect(await devA.conflictRepo.listUnresolved(userId)).toHaveLength(0);
    expect(await devA.outboxRepo.listByEntity(userId, 'document', doc.id)).toHaveLength(0);
    expect((await devA.db.documents.get(doc.id))?.content).toBe('P2 newer local edit must survive');
    expect(server.tables.documents.get(doc.id)).toMatchObject({
      version: 3,
      content: 'P2 newer local edit must survive',
    });

    // Device B hydrates and converges to exact v3 content
    await devB.pullEngine.bootstrapHydrateAll(userId);
    expect((await devB.db.documents.get(doc.id))?.content).toBe('P2 newer local edit must survive');
  });

  it('2. S-02: rolls back push-ack Dexie transaction atomically on storage failure and converges idempotently on retry', async () => {
    const userId = '22222222-bbbb-4222-8222-222222222222';
    const server = new ControllableFakeSupabaseServer();
    const client = server.createClientForUser(() => userId);
    const dev = makeDeviceStack(userId, `s02_dev_${crypto.randomUUID()}`, client, 'tab-s02');
    openDbs.push(dev.db);
    engines.push(dev.syncEngine);
    await dev.db.open();

    const proj = await dev.projectRepo.create({ userId, name: 'Crash Safety' });
    await dev.syncEngine.triggerSync(userId);

    const doc = await dev.docRepo.create({
      userId,
      projectId: proj.id,
      title: 'Atomic Ack Doc',
      content: 'Body v1',
      format: 'markdown',
    });

    // Call 1 of sync_metadata.put inside drainOutbox is markSyncing; Call 2 is inside post-push atomic ack!
    let putCount = 0;
    const origPut = dev.db.sync_metadata.put.bind(dev.db.sync_metadata);
    const putSpy = vi
      .spyOn(dev.db.sync_metadata, 'put')
      .mockImplementation(((item: any, key?: any) => {
        putCount++;
        if (putCount === 2) {
          return Promise.reject(new Error('Simulated IndexedDB crash mid-ack'));
        }
        return origPut(item, key);
      }) as any);

    await dev.syncEngine.drainOutbox(userId);
    putSpy.mockRestore();

    // Transactional rollback guarantee: outbox entry was NOT deleted when sync_metadata.put failed!
    const remaining = await dev.outboxRepo.listByEntity(userId, 'document', doc.id);
    expect(remaining).toHaveLength(1);
    const metaAfterAbort = await dev.syncMetaRepo.get('document', doc.id);
    expect(metaAfterAbort?.syncState).not.toBe('synced');

    // Clear retry backoff and replay idempotently against processed_mutations -> converges to synced!
    await dev.db.outbox.update(remaining[0].id, { nextRetryAt: 0 });
    await dev.syncEngine.drainOutbox(userId);

    expect(await dev.outboxRepo.listByEntity(userId, 'document', doc.id)).toHaveLength(0);
    expect((await dev.syncMetaRepo.get('document', doc.id))?.syncState).toBe('synced');
    expect((await dev.syncMetaRepo.get('document', doc.id))?.serverVersion).toBe('1');
  });

  it('3. S-03: handles multi-device remote_deleted conflicts across all 3 resolution strategies and persists across DB restart', async () => {
    const userId = '33333333-cccc-4333-8333-333333333333';
    const server = new ControllableFakeSupabaseServer();
    const clientA = server.createClientForUser(() => userId);
    const clientB = server.createClientForUser(() => userId);

    const dbNameA = `s03_devA_${crypto.randomUUID()}`;
    let devA = makeDeviceStack(userId, dbNameA, clientA, 'tab-s03-a');
    const devB = makeDeviceStack(userId, `s03_devB_${crypto.randomUUID()}`, clientB, 'tab-s03-b');
    openDbs.push(devA.db, devB.db);
    engines.push(devA.syncEngine, devB.syncEngine);
    await Promise.all([devA.db.open(), devB.db.open()]);

    const proj = await devA.projectRepo.create({ userId, name: 'Multi-Device' });
    const doc1 = await devA.docRepo.create({
      userId,
      projectId: proj.id,
      title: 'Doc Restore',
      content: 'Base 1',
      format: 'markdown',
    });
    const doc2 = await devA.docRepo.create({
      userId,
      projectId: proj.id,
      title: 'Doc Accept Delete',
      content: 'Base 2',
      format: 'markdown',
    });
    const doc3 = await devA.docRepo.create({
      userId,
      projectId: proj.id,
      title: 'Doc Copy',
      content: 'Base 3',
      format: 'markdown',
    });
    await devA.syncEngine.triggerSync(userId);

    // Device B hydrates and deletes all 3 docs remotely
    await devB.pullEngine.bootstrapHydrateAll(userId);
    await devB.docRepo.delete(doc1.id);
    await devB.docRepo.delete(doc2.id);
    await devB.docRepo.delete(doc3.id);
    await devB.syncEngine.triggerSync(userId);

    // Offline Device A edits all 3 docs before pulling Device B's deletes, then pushes via drainOutbox
    await devA.docRepo.update(doc1.id, { content: 'Local edit 1' });
    await devA.docRepo.update(doc2.id, { content: 'Local edit 2' });
    await devA.docRepo.update(doc3.id, { content: 'Local edit 3' });
    await devA.syncEngine.drainOutbox(userId);

    // Close and reopen Device A's IndexedDB to prove conflict durability across restart
    devA.syncEngine.destroy();
    devA.db.close();
    devA = makeDeviceStack(userId, dbNameA, clientA, 'tab-s03-a-restarted');
    openDbs.push(devA.db);
    engines.push(devA.syncEngine);
    await devA.db.open();

    const unresolved = await devA.conflictRepo.listUnresolved(userId);
    expect(unresolved).toHaveLength(3);
    expect(unresolved.every((c) => c.reason === 'remote_deleted')).toBe(true);

    const c1 = unresolved.find((c) => c.entityId === doc1.id)!;
    const c2 = unresolved.find((c) => c.entityId === doc2.id)!;
    const c3 = unresolved.find((c) => c.entityId === doc3.id)!;

    await devA.conflictRepo.resolveConflict({ conflictId: c1.id, strategy: 'keep_local' });
    await devA.conflictRepo.resolveConflict({ conflictId: c2.id, strategy: 'keep_remote' });
    const copyRes = await devA.conflictRepo.resolveConflict({
      conflictId: c3.id,
      strategy: 'create_copy',
    });

    await devA.syncEngine.triggerSync(userId);

    expect(await devA.conflictRepo.listUnresolved(userId)).toHaveLength(0);
    expect(server.tables.documents.get(doc1.id)?.deleted_at).toBeNull();
    expect(server.tables.documents.get(doc1.id)?.content).toBe('Local edit 1');
    expect((await devA.db.documents.get(doc2.id))?.isDeleted).toBe(true);
    expect(server.tables.documents.get(doc2.id)?.deleted_at).not.toBeNull();
    expect((await devA.db.documents.get(doc3.id))?.isDeleted).toBe(true);
    expect(copyRes.copyEntityId).toBeDefined();
    expect(server.tables.documents.get(copyRes.copyEntityId!)?.content).toBe('Local edit 3');
  });

  it('4. S-05: fences zombie Tab A via leaseToken after lease expiry and Tab B takeover', async () => {
    const userId = '44444444-dddd-4444-8444-444444444444';
    const server = new ControllableFakeSupabaseServer();
    const sharedDb = new ArtixDB(`s05_shared_${crypto.randomUUID()}`);
    openDbs.push(sharedDb);
    await sharedDb.open();

    const outboxRepo = new OutboxRepository(sharedDb);
    const syncMetaRepo = new SyncMetadataRepository(sharedDb);
    const conflictRepo = new ConflictRepository(sharedDb);
    const docRepo = new DocumentRepository(sharedDb, outboxRepo, syncMetaRepo);

    const doc = await docRepo.create({
      userId,
      projectId: null,
      title: 'Fenced Doc',
      content: 'Initial',
      format: 'markdown',
    });

    let releaseZombieRpc!: (err: Error) => void;
    let notifyZombieEntered!: () => void;
    const zombieEntered = new Promise<void>((resolve) => {
      notifyZombieEntered = resolve;
    });

    const zombieClient = {
      from: server.createClientForUser(() => userId).from,
      rpc: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            notifyZombieEntered();
            releaseZombieRpc = reject;
          }),
      ),
    };
    const activeClient = server.createClientForUser(() => userId);

    const coordA = makeLeaderCoordinator('tab-zombie-a');
    const coordB = makeLeaderCoordinator('tab-active-b');

    const engineA = new SyncEngine({
      userId,
      autoSyncOnEnqueue: false,
      supabaseClient: zombieClient,
      outboxRepo,
      syncMetadataRepo: syncMetaRepo,
      conflictRepo,
      pullEngine: new PullEngine({ supabaseClient: zombieClient, db: sharedDb }),
      tabCoordinator: coordA,
    });
    const engineB = new SyncEngine({
      userId,
      autoSyncOnEnqueue: false,
      supabaseClient: activeClient,
      outboxRepo,
      syncMetadataRepo: syncMetaRepo,
      conflictRepo,
      pullEngine: new PullEngine({ supabaseClient: activeClient, db: sharedDb }),
      tabCoordinator: coordB,
    });
    engines.push(engineA, engineB);

    // Tab A starts draining and stalls mid-flight
    const tabAPromise = engineA.drainOutbox(userId);
    await zombieEntered;

    // Lease expires (+60s); Tab B reclaims and completes push -> synced v1!
    await outboxRepo.recoverStaleLeases({ now: Date.now() + 60_000 });
    await engineB.drainOutbox(userId);

    expect(await outboxRepo.listByEntity(userId, 'document', doc.id)).toHaveLength(0);
    expect((await syncMetaRepo.get('document', doc.id))?.syncState).toBe('synced');
    expect((await syncMetaRepo.get('document', doc.id))?.serverVersion).toBe('1');

    // Zombie Tab A finally fails with a non-retryable 422 error — must be fenced by leaseToken!
    const lateErr: any = new Error('Zombie stale failure');
    lateErr.status = 422;
    releaseZombieRpc(lateErr);
    await tabAPromise;

    // Sync metadata & outbox remain completely untouched at Tab B's authoritative synced state!
    expect(await outboxRepo.listByEntity(userId, 'document', doc.id)).toHaveLength(0);
    expect((await syncMetaRepo.get('document', doc.id))?.syncState).toBe('synced');
    expect((await syncMetaRepo.get('document', doc.id))?.serverVersion).toBe('1');
  });

  it('5. S-06: isolates Account A -> Account B -> Account A across Dexie, drafts, TabCoordinator, and cloud sync', async () => {
    const userA = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
    const userB = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
    let activeUser = userA;

    const server = new ControllableFakeSupabaseServer();
    const sharedClient = server.createClientForUser(() => activeUser);

    // Session 1: Account A creates offline work & draft
    const stackA1 = makeDeviceStack(userA, `s06_userA_${userA}`, sharedClient, 'tab-a1');
    openDbs.push(stackA1.db);
    engines.push(stackA1.syncEngine);
    await stackA1.db.open();

    const projA = await stackA1.projectRepo.create({ userId: userA, name: 'Alice Secret Project' });
    const docA = await stackA1.docRepo.create({
      userId: userA,
      projectId: projA.id,
      title: 'Alice Offline Spec',
      content: 'Confidential A',
      format: 'markdown',
    });
    setDraft(docA.id, 'Alice unsaved draft', userA);

    // Switch to Account B before Account A syncs
    stackA1.syncEngine.destroy();
    evictSyncEngine(userA);
    evictTabCoordinator(userA);
    stackA1.db.close();
    activeUser = userB;

    const stackB = makeDeviceStack(userB, `s06_userB_${userB}`, sharedClient, 'tab-b1');
    openDbs.push(stackB.db);
    engines.push(stackB.syncEngine);
    await stackB.db.open();

    // Account B sees ZERO of Account A's projects, docs, or drafts
    expect(await stackB.db.projects.count()).toBe(0);
    expect(await stackB.db.documents.count()).toBe(0);
    expect(getDraft(docA.id, userB)).toBeNull();

    const projB = await stackB.projectRepo.create({ userId: userB, name: 'Bob Workspace' });
    await stackB.syncEngine.triggerSync(userB);
    expect(server.tables.projects.get(projB.id)?.user_id).toBe(userB);
    expect(server.tables.documents.has(docA.id)).toBe(false);

    // Switch back to Account A -> fresh coordinator + SyncEngine drains Account A's queued offline work!
    stackB.syncEngine.destroy();
    evictSyncEngine(userB);
    evictTabCoordinator(userB);
    stackB.db.close();
    activeUser = userA;

    const coordA2 = getTabCoordinator(userA);
    expect(coordA2).toBeDefined();

    const stackA2 = makeDeviceStack(userA, `s06_userA_${userA}`, sharedClient, 'tab-a2');
    openDbs.push(stackA2.db);
    engines.push(stackA2.syncEngine);
    await stackA2.db.open();

    expect(getDraft(docA.id, userA)).toBe('Alice unsaved draft');

    await stackA2.syncEngine.triggerSync(userA);
    expect(server.tables.projects.get(projA.id)?.name).toBe('Alice Secret Project');
    expect(server.tables.documents.get(docA.id)?.content).toBe('Confidential A');
    expect(await stackA2.db.projects.get(projB.id)).toBeUndefined();
    coordA2.destroy();
  });
});
