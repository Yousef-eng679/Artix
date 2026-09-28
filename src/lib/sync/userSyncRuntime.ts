import { supabase as defaultSupabaseClient } from '@/integrations/supabase/client';
import { ArtixDB, getUserArtixDB, migrateLegacyArtixDB, MigrationResult } from '../local/db';
import { DocumentRepository } from '../repositories/documentRepository';
import { WorkspaceFolderRepository } from '../repositories/folderRepository';
import { SystemDesignRepository } from '../repositories/systemDesignRepository';
import { OutboxRepository } from '../repositories/outboxRepository';
import { SyncMetadataRepository } from '../repositories/syncMetadataRepository';
import { ConflictRepository } from '../repositories/conflictRepository';
import { PullEngine } from './pullEngine';
import { SyncEngine } from './syncEngine';
import { TabCoordinator, getTabCoordinator } from './tabCoordinator';
import { RealtimeSyncManager } from './realtimeSync';

export type RuntimeState = 'uninitialized' | 'starting' | 'running' | 'degraded' | 'errored' | 'stopped';

export interface RuntimeError {
  code: 'STORAGE_UNAVAILABLE' | 'STORAGE_BLOCKED' | 'STORAGE_CORRUPTED' | 'MIGRATION_FAILED' | 'UNKNOWN';
  message: string;
  fatal: boolean;
  originalError?: unknown;
}

export interface RuntimeStatus {
  state: RuntimeState;
  userId: string;
  isStarted: boolean;
  isDegraded: boolean;
  error: RuntimeError | null;
  migration: MigrationResult | null;
}

export interface UserSyncRuntimeOptions {
  supabaseClient?: any;
  db?: ArtixDB;
  tabCoordinator?: TabCoordinator;
  realtimeSync?: RealtimeSyncManager;
}

/**
 * Encapsulates the entire offline-first synchronization runtime scoped to a single authenticated user.
 * Owns the user's IndexedDB connection, repositories, pull feed, sync engine, realtime listener, and multi-tab coordinator.
 */
export class UserSyncRuntime {
  readonly userId: string;
  readonly db: ArtixDB;
  readonly documentRepo: DocumentRepository;
  readonly folderRepo: WorkspaceFolderRepository;
  readonly systemDesignRepo: SystemDesignRepository;
  readonly outboxRepo: OutboxRepository;
  readonly syncMetadataRepo: SyncMetadataRepository;
  readonly conflictRepo: ConflictRepository;
  readonly pullEngine: PullEngine;
  readonly syncEngine: SyncEngine;
  readonly tabCoordinator: TabCoordinator;
  readonly realtimeSync: RealtimeSyncManager;

  private supabase: any;
  private isStarted = false;
  private unsubCrossTab?: () => void;
  private state: RuntimeState = 'uninitialized';
  private runtimeError: RuntimeError | null = null;
  private migrationResult: MigrationResult | null = null;
  private statusListeners = new Set<(status: RuntimeStatus) => void>();

  constructor(userId: string, options: UserSyncRuntimeOptions = {}) {
    if (!userId) {
      throw new Error('[UserSyncRuntime] userId is required to create a user-scoped sync runtime');
    }

    this.userId = userId;
    this.supabase = options.supabaseClient || defaultSupabaseClient;
    this.db = options.db || getUserArtixDB(userId);

    this.documentRepo = new DocumentRepository(this.db);
    this.folderRepo = new WorkspaceFolderRepository(this.db);
    this.systemDesignRepo = new SystemDesignRepository(this.db);
    this.outboxRepo = new OutboxRepository(this.db);
    this.syncMetadataRepo = new SyncMetadataRepository(this.db);
    this.conflictRepo = new ConflictRepository(this.db);

    this.tabCoordinator = options.tabCoordinator || getTabCoordinator(userId);

    this.pullEngine = new PullEngine({
      supabaseClient: this.supabase,
      db: this.db,
      documentRepo: this.documentRepo,
      folderRepo: this.folderRepo,
      systemDesignRepo: this.systemDesignRepo,
      conflictRepo: this.conflictRepo,
      syncMetadataRepo: this.syncMetadataRepo,
    });

    this.syncEngine = new SyncEngine({
      supabaseClient: this.supabase,
      outboxRepo: this.outboxRepo,
      syncMetadataRepo: this.syncMetadataRepo,
      conflictRepo: this.conflictRepo,
      pullEngine: this.pullEngine,
      tabCoordinator: this.tabCoordinator,
    });

    this.realtimeSync = options.realtimeSync || new RealtimeSyncManager({
      supabaseClient: this.supabase,
      syncEngine: this.syncEngine,
      tabCoordinator: this.tabCoordinator,
    });
  }

  /**
   * Returns current lifecycle and persistence health status.
   */
  getStatus(): RuntimeStatus {
    return {
      state: this.state,
      userId: this.userId,
      isStarted: this.isStarted,
      isDegraded: this.state === 'degraded',
      error: this.runtimeError,
      migration: this.migrationResult,
    };
  }

  /**
   * Subscribes to runtime status updates.
   */
  subscribeStatus(listener: (status: RuntimeStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private notifyStatus(): void {
    const status = this.getStatus();
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (err) {
        console.error('[UserSyncRuntime] Status listener error:', err);
      }
    }
  }

  /**
   * Initializes the runtime: opens database, runs legacy migrations,
   * reclaims in-flight crash leases, binds tab communication, starts realtime,
   * and kicks off asynchronous synchronization.
   */
  async start(): Promise<void> {
    if (this.isStarted) return;
    this.state = 'starting';
    this.runtimeError = null;
    this.notifyStatus();

    // 1. Open Database with safe error classification
    if (!this.db.isOpen()) {
      try {
        await this.db.open();
      } catch (dbErr: any) {
        const isBlocked = dbErr?.name === 'BlockedError' || dbErr?.name === 'UpgradeBlockedError';
        const isSecurity = dbErr?.name === 'SecurityError';
        const code = isBlocked ? 'STORAGE_BLOCKED' : isSecurity ? 'STORAGE_UNAVAILABLE' : 'STORAGE_CORRUPTED';
        this.runtimeError = {
          code,
          message: dbErr?.message || 'Failed to open local persistence database',
          fatal: true,
          originalError: dbErr,
        };
        this.state = 'errored';
        this.notifyStatus();
        return;
      }
    }

    // 2. Run legacy database migrations if needed
    try {
      const migResult = await migrateLegacyArtixDB(this.db, this.userId);
      this.migrationResult = migResult;
      if (!migResult.success && migResult.error) {
        this.state = 'degraded';
        this.runtimeError = {
          code: 'MIGRATION_FAILED',
          message: migResult.error.message || 'Legacy database migration failed',
          fatal: false,
          originalError: migResult.error,
        };
      }
    } catch (migErr: any) {
      this.state = 'degraded';
      this.runtimeError = {
        code: 'MIGRATION_FAILED',
        message: migErr?.message || 'Legacy migration threw an unexpected error',
        fatal: false,
        originalError: migErr,
      };
    }

    // 3. Reclaim stale in-flight leases from crashed previous sessions
    try {
      await this.outboxRepo.recoverStaleLeases({
        currentTabId: this.tabCoordinator?.getTabId?.(),
        forceOrphanedByOtherTabs: this.tabCoordinator?.isLeaderTab?.() ?? false,
      });
    } catch (leaseErr) {
      console.warn('[UserSyncRuntime] Stale lease recovery warning:', leaseErr);
    }

    // 4. Listen for entity change announcements from other tabs
    this.unsubCrossTab = this.tabCoordinator.onCrossTabChange(() => {
      // Standby or leader tabs can react to peer tab changes
    });

    // 5. Start realtime listener for wake-up acceleration
    this.realtimeSync.start(this.userId);

    // 6. Start background synchronization
    this.syncEngine.triggerSync(this.userId).catch((err) => {
      if (err?.name !== 'DatabaseClosedError') {
        console.warn(`[UserSyncRuntime] Initial sync error for user ${this.userId}:`, err);
      }
    });

    this.isStarted = true;
    if (this.state !== 'degraded') {
      this.state = 'running';
    }
    this.notifyStatus();
  }

  /**
   * Shuts down synchronization, realtime listener, unbinds cross-tab channels,
   * destroys listeners, and cleanly closes the user's IndexedDB connection.
   */
  async stop(): Promise<void> {
    if (!this.isStarted && this.state === 'stopped') return;

    if (this.unsubCrossTab) {
      this.unsubCrossTab();
      this.unsubCrossTab = undefined;
    }

    this.realtimeSync.stop();
    this.syncEngine.destroy();
    this.tabCoordinator.destroy();

    if (this.db.isOpen()) {
      this.db.close();
    }

    this.isStarted = false;
    this.state = 'stopped';
    this.notifyStatus();
    this.statusListeners.clear();
  }

  isActive(): boolean {
    return this.isStarted;
  }
}

// Global active user runtime reference
let activeRuntime: UserSyncRuntime | null = null;

/**
 * Opens or transitions to a user-scoped synchronization runtime upon user login.
 * If another user's runtime was active, it is stopped cleanly first.
 */
export async function openUserRuntime(
  userId: string,
  options: UserSyncRuntimeOptions = {}
): Promise<UserSyncRuntime> {
  if (activeRuntime) {
    if (activeRuntime.userId === userId && activeRuntime.isActive()) {
      return activeRuntime;
    }
    await activeRuntime.stop();
    activeRuntime = null;
  }

  const runtime = new UserSyncRuntime(userId, options);
  await runtime.start();
  activeRuntime = runtime;
  return runtime;
}

/**
 * Shuts down the current active user runtime upon user logout.
 */
export async function closeUserRuntime(userId?: string): Promise<void> {
  if (activeRuntime) {
    if (!userId || activeRuntime.userId === userId) {
      await activeRuntime.stop();
      activeRuntime = null;
    }
  }
}

/**
 * Returns the currently active user runtime, or undefined if no user is authenticated.
 */
export function getActiveUserRuntime(): UserSyncRuntime | undefined {
  return activeRuntime ?? undefined;
}
