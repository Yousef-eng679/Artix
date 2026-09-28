import { supabase as defaultSupabaseClient } from '@/integrations/supabase/client';
import { ArtixDB, getUserArtixDB, migrateLegacyArtixDB } from '../local/db';
import { DocumentRepository } from '../repositories/documentRepository';
import { WorkspaceFolderRepository } from '../repositories/folderRepository';
import { SystemDesignRepository } from '../repositories/systemDesignRepository';
import { OutboxRepository } from '../repositories/outboxRepository';
import { SyncMetadataRepository } from '../repositories/syncMetadataRepository';
import { ConflictRepository } from '../repositories/conflictRepository';
import { PullEngine } from './pullEngine';
import { SyncEngine } from './syncEngine';
import { TabCoordinator, getTabCoordinator } from './tabCoordinator';

export interface UserSyncRuntimeOptions {
  supabaseClient?: any;
  db?: ArtixDB;
  tabCoordinator?: TabCoordinator;
}

/**
 * Encapsulates the entire offline-first synchronization runtime scoped to a single authenticated user.
 * Owns the user's IndexedDB connection, repositories, pull feed, sync engine, and multi-tab coordinator.
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

  private supabase: any;
  private isStarted = false;
  private unsubCrossTab?: () => void;

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
  }

  /**
   * Initializes the runtime: opens database, runs legacy migrations,
   * reclaims in-flight crash leases, binds tab communication, and kicks off asynchronous synchronization.
   */
  async start(): Promise<void> {
    if (this.isStarted) return;

    if (!this.db.isOpen()) {
      await this.db.open();
    }

    // Run legacy database migrations if needed
    try {
      await migrateLegacyArtixDB(this.db, this.userId);
    } catch (migErr) {
      console.warn(`[UserSyncRuntime] Legacy migration warning for user ${this.userId}:`, migErr);
    }

    // Reclaim stale in-flight leases from crashed previous sessions
    await this.outboxRepo.recoverStaleLeases();

    // Listen for entity change announcements from other tabs
    this.unsubCrossTab = this.tabCoordinator.onCrossTabChange(() => {
      // Standby or leader tabs can react to peer tab changes
    });

    // Start background synchronization
    this.syncEngine.triggerSync(this.userId).catch((err) => {
      console.warn(`[UserSyncRuntime] Initial sync error for user ${this.userId}:`, err);
    });

    this.isStarted = true;
  }

  /**
   * Shuts down synchronization, unbinds cross-tab channels, destroys listeners,
   * and cleanly closes the user's IndexedDB connection.
   */
  async stop(): Promise<void> {
    if (!this.isStarted) return;

    if (this.unsubCrossTab) {
      this.unsubCrossTab();
      this.unsubCrossTab = undefined;
    }

    this.syncEngine.destroy();
    this.tabCoordinator.destroy();

    if (this.db.isOpen()) {
      this.db.close();
    }

    this.isStarted = false;
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
