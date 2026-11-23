import type { BrowserContext, Page, Route } from '@playwright/test';

export interface MockServerProject {
  id: string;
  user_id: string;
  name: string;
  version: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MockServerFolder {
  id: string;
  user_id: string;
  project_id: string;
  parent_folder_id: string | null;
  name: string;
  version: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MockServerDocument {
  id: string;
  user_id: string;
  project_id: string | null;
  folder_id: string | null;
  title: string;
  content: string;
  format: string;
  version: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MockServerDesign {
  id: string;
  user_id: string;
  project_id: string | null;
  folder_id: string | null;
  name: string;
  board_state: Record<string, unknown>;
  version: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MockSyncChange {
  sequence: number;
  user_id: string;
  entity_type: 'project' | 'document' | 'system_design' | 'workspace_folder';
  entity_id: string;
  operation: 'create' | 'update' | 'delete';
  entity_version: number | null;
  mutation_id: string | null;
  payload: Record<string, unknown> | null;
  changed_at: string;
}

export interface MockUserAccount {
  id: string;
  email: string;
  displayName: string;
  planTier?: 'free' | 'pro';
}

export class StatefulMockSupabase {
  private offline = false;
  public offlineRequestAttempts = 0;
  public tokenRefreshCalls = 0;

  private activeUser: MockUserAccount;
  private users = new Map<string, MockUserAccount>();
  public projects = new Map<string, MockServerProject>();
  public folders = new Map<string, MockServerFolder>();
  public documents = new Map<string, MockServerDocument>();
  public designs = new Map<string, MockServerDesign>();
  public syncChanges: MockSyncChange[] = [];
  private processedMutations = new Map<string, { version: number | null; updated_at: string }>();
  private nextSequence = 1;

  constructor(initialUser: MockUserAccount) {
    this.activeUser = initialUser;
    this.registerUser(initialUser);
  }

  registerUser(user: MockUserAccount): void {
    this.users.set(user.id, user);
  }

  setActiveUser(user: MockUserAccount): void {
    this.registerUser(user);
    this.activeUser = user;
  }

  setOffline(isOffline: boolean): void {
    this.offline = isOffline;
    if (isOffline) {
      this.offlineRequestAttempts = 0;
    }
  }

  private appendChange(
    userId: string,
    entityType: MockSyncChange['entity_type'],
    entityId: string,
    operation: MockSyncChange['operation'],
    entityVersion: number | null,
    mutationId: string | null,
    payload: Record<string, unknown> | null,
  ): MockSyncChange {
    const entry: MockSyncChange = {
      sequence: this.nextSequence++,
      user_id: userId,
      entity_type: entityType,
      entity_id: entityId,
      operation,
      entity_version: entityVersion,
      mutation_id: mutationId,
      payload,
      changed_at: new Date().toISOString(),
    };
    this.syncChanges.push(entry);
    return entry;
  }

  seedProject(input: { id: string; userId: string; name: string; recordFeed?: boolean }): MockServerProject {
    const now = new Date().toISOString();
    const row: MockServerProject = {
      id: input.id,
      user_id: input.userId,
      name: input.name,
      version: 1,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
    this.projects.set(row.id, row);
    if (input.recordFeed !== false) {
      this.appendChange(row.user_id, 'project', row.id, 'create', 1, null, { ...row });
    }
    return row;
  }

  seedFolder(input: {
    id: string;
    userId: string;
    projectId: string;
    name: string;
    parentFolderId?: string | null;
  }): MockServerFolder {
    const now = new Date().toISOString();
    const row: MockServerFolder = {
      id: input.id,
      user_id: input.userId,
      project_id: input.projectId,
      parent_folder_id: input.parentFolderId ?? null,
      name: input.name,
      version: 1,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
    this.folders.set(row.id, row);
    this.appendChange(row.user_id, 'workspace_folder', row.id, 'create', 1, null, { ...row });
    return row;
  }

  seedDocument(input: {
    id: string;
    userId: string;
    projectId: string;
    folderId?: string | null;
    title: string;
    content: string;
    format?: string;
    recordFeed?: boolean;
  }): MockServerDocument {
    const now = new Date().toISOString();
    const row: MockServerDocument = {
      id: input.id,
      user_id: input.userId,
      project_id: input.projectId,
      folder_id: input.folderId ?? null,
      title: input.title,
      content: input.content,
      format: input.format ?? 'markdown',
      version: 1,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
    this.documents.set(row.id, row);
    if (input.recordFeed !== false) {
      this.appendChange(row.user_id, 'document', row.id, 'create', 1, null, { ...row });
    }
    return row;
  }

  seedDesign(input: {
    id: string;
    userId: string;
    projectId: string;
    folderId?: string | null;
    name: string;
    boardState?: Record<string, unknown>;
  }): MockServerDesign {
    const now = new Date().toISOString();
    const row: MockServerDesign = {
      id: input.id,
      user_id: input.userId,
      project_id: input.projectId,
      folder_id: input.folderId ?? null,
      name: input.name,
      board_state: input.boardState ?? { nodes: [], edges: [], strokes: [] },
      version: 1,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
    this.designs.set(row.id, row);
    this.appendChange(row.user_id, 'system_design', row.id, 'create', 1, null, { ...row });
    return row;
  }

  simulateExternalDocumentUpdate(docId: string, updates: { title?: string; content?: string }): MockServerDocument {
    const existing = this.documents.get(docId);
    if (!existing) {
      throw new Error(`Document ${docId} not found in mock server`);
    }
    const updated: MockServerDocument = {
      ...existing,
      ...(updates.title !== undefined ? { title: updates.title } : {}),
      ...(updates.content !== undefined ? { content: updates.content } : {}),
      version: existing.version + 1,
      updated_at: new Date().toISOString(),
    };
    this.documents.set(docId, updated);
    this.appendChange(updated.user_id, 'document', docId, 'update', updated.version, null, {
      ...updated,
    });
    return updated;
  }

  private resolveRequestUser(route: Route): MockUserAccount {
    const authHeader = route.request().headers()['authorization'] || '';
    const match = authHeader.match(/user:([0-9a-f-]{36})/i);
    if (match && this.users.has(match[1])) {
      return this.users.get(match[1])!;
    }
    return this.activeUser;
  }

  private buildSupabaseUserPayload(account: MockUserAccount) {
    const nowIso = new Date().toISOString();
    return {
      id: account.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: account.email,
      email_confirmed_at: nowIso,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: { display_name: account.displayName },
      created_at: nowIso,
      updated_at: nowIso,
    };
  }

  buildSessionJson(account: MockUserAccount, expiresOffsetSec = 3600): string {
    const nowSec = Math.floor(Date.now() / 1000);
    return JSON.stringify({
      access_token: `e2e-token-user:${account.id}-${nowSec}`,
      refresh_token: `e2e-refresh-user:${account.id}`,
      expires_in: 3600,
      expires_at: nowSec + expiresOffsetSec,
      token_type: 'bearer',
      user: this.buildSupabaseUserPayload(account),
    });
  }

  async attach(context: BrowserContext): Promise<void> {
    await context.route('**/*.supabase.co/**', async (route) => {
      if (this.offline) {
        this.offlineRequestAttempts += 1;
        await route.abort('internetdisconnected');
        return;
      }

      const req = route.request();
      const urlObj = new URL(req.url());
      const pathname = urlObj.pathname;
      const accept = req.headers()['accept'] || '';
      const wantsObject = accept.includes('application/vnd.pgrst.object+json');
      const user = this.resolveRequestUser(route);

      if (pathname.includes('/realtime/v1')) {
        await route.abort('connectionrefused');
        return;
      }

      if (pathname.endsWith('/auth/v1/user')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(this.buildSupabaseUserPayload(user)),
        });
        return;
      }

      if (pathname.endsWith('/auth/v1/token')) {
        this.tokenRefreshCalls += 1;
        let resolvedAccount = user;
        try {
          const body = JSON.parse(req.postData() || '{}') as {
            refresh_token?: string;
            email?: string;
          };
          if (body.refresh_token) {
            const m = body.refresh_token.match(/user:([0-9a-f-]{36})/i);
            if (m && this.users.has(m[1])) {
              resolvedAccount = this.users.get(m[1])!;
            }
          } else if (body.email) {
            const byEmail = [...this.users.values()].find((u) => u.email === body.email);
            if (byEmail) {
              resolvedAccount = byEmail;
              this.activeUser = byEmail;
            }
          }
        } catch {
          // Ignore non-JSON token bodies
        }

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: this.buildSessionJson(resolvedAccount, 3600),
        });
        return;
      }

      if (pathname.endsWith('/auth/v1/logout')) {
        await route.fulfill({ status: 204, body: '' });
        return;
      }

      if (pathname.endsWith('/rest/v1/rpc/get_sync_feed_bounds')) {
        const userSeqs = this.syncChanges
          .filter((c) => c.user_id === user.id)
          .map((c) => c.sequence);
        const maxSeq = userSeqs.length > 0 ? Math.max(...userSeqs) : 0;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            min_retained_sequence: 0,
            max_sequence: maxSeq,
          }),
        });
        return;
      }

      if (pathname.endsWith('/rest/v1/rpc/apply_sync_mutation')) {
        const args = JSON.parse(req.postData() || '{}') as {
          p_mutation_id: string;
          p_user_id: string;
          p_entity_type: MockSyncChange['entity_type'];
          p_entity_id: string;
          p_operation: MockSyncChange['operation'];
          p_project_id?: string | null;
          p_payload?: Record<string, unknown>;
          p_base_version?: number | null;
        };

        const existingLedger = this.processedMutations.get(args.p_mutation_id);
        if (existingLedger) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              status: 'already_processed',
              version: existingLedger.version,
              updated_at: existingLedger.updated_at,
            }),
          });
          return;
        }

        const result = this.applyMutation(args);
        if (result.status === 'applied') {
          this.processedMutations.set(args.p_mutation_id, {
            version: result.version as number | null,
            updated_at: result.updated_at as string,
          });
        }

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(result),
        });
        return;
      }

      if (pathname.endsWith('/rest/v1/sync_changes')) {
        let rows = this.syncChanges.filter((c) => c.user_id === user.id);
        const seqFilter = urlObj.searchParams.get('sequence');
        if (seqFilter?.startsWith('gt.')) {
          const gtVal = Number(seqFilter.slice(3));
          rows = rows.filter((c) => c.sequence > gtVal);
        }
        const orderParam = urlObj.searchParams.get('order') || 'sequence.asc';
        rows = [...rows].sort((a, b) =>
          orderParam.includes('desc') ? b.sequence - a.sequence : a.sequence - b.sequence,
        );
        const limitParam = urlObj.searchParams.get('limit');
        if (limitParam) {
          rows = rows.slice(0, Number(limitParam));
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(wantsObject ? (rows[0] ?? null) : rows),
        });
        return;
      }

      if (pathname.endsWith('/rest/v1/projects')) {
        const rows = this.filterEntityRows([...this.projects.values()], user.id, urlObj);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` },
          body: JSON.stringify(wantsObject ? (rows[0] ?? null) : rows),
        });
        return;
      }

      if (pathname.endsWith('/rest/v1/workspace_folders')) {
        const rows = this.filterEntityRows([...this.folders.values()], user.id, urlObj);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` },
          body: JSON.stringify(wantsObject ? (rows[0] ?? null) : rows),
        });
        return;
      }

      if (pathname.endsWith('/rest/v1/documents')) {
        const rows = this.filterEntityRows([...this.documents.values()], user.id, urlObj);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` },
          body: JSON.stringify(wantsObject ? (rows[0] ?? null) : rows),
        });
        return;
      }

      if (pathname.endsWith('/rest/v1/system_designs')) {
        const rows = this.filterEntityRows([...this.designs.values()], user.id, urlObj);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` },
          body: JSON.stringify(wantsObject ? (rows[0] ?? null) : rows),
        });
        return;
      }

      if (pathname.endsWith('/rest/v1/subscriptions')) {
        const sub = {
          user_id: user.id,
          plan_tier: user.planTier ?? 'pro',
          status: 'active',
          billing_cycle: 'monthly',
          current_period_end: null,
          stripe_customer_id: `cus_${user.id.slice(0, 8)}`,
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(wantsObject ? sub : [sub]),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'content-range': '0-0/0' },
        body: JSON.stringify(wantsObject ? null : []),
      });
    });
  }

  private filterEntityRows<
    T extends { id: string; user_id: string; deleted_at: string | null; project_id?: string | null },
  >(all: T[], fallbackUserId: string, urlObj: URL): T[] {
    let userId = fallbackUserId;
    const userParam = urlObj.searchParams.get('user_id');
    if (userParam?.startsWith('eq.')) {
      userId = userParam.slice(3);
    }

    let rows = all.filter((r) => r.user_id === userId);
    const idParam = urlObj.searchParams.get('id');
    if (idParam?.startsWith('eq.')) {
      const targetId = idParam.slice(3);
      rows = rows.filter((r) => r.id === targetId);
    }
    const projParam = urlObj.searchParams.get('project_id');
    if (projParam?.startsWith('eq.')) {
      const targetProj = projParam.slice(3);
      rows = rows.filter((r) => r.project_id === targetProj);
    }
    const deletedParam = urlObj.searchParams.get('deleted_at');
    if (!deletedParam || deletedParam === 'is.null') {
      rows = rows.filter((r) => r.deleted_at === null);
    }
    return rows;
  }

  private applyMutation(args: {
    p_mutation_id: string;
    p_user_id: string;
    p_entity_type: MockSyncChange['entity_type'];
    p_entity_id: string;
    p_operation: MockSyncChange['operation'];
    p_project_id?: string | null;
    p_payload?: Record<string, unknown>;
    p_base_version?: number | null;
  }): Record<string, unknown> {
    const now = new Date().toISOString();
    const payload = args.p_payload ?? {};
    const projectId =
      args.p_project_id ??
      (typeof payload.project_id === 'string' ? payload.project_id : null) ??
      (typeof payload.projectId === 'string' ? payload.projectId : null);

    const storeMap = {
      project: this.projects,
      workspace_folder: this.folders,
      document: this.documents,
      system_design: this.designs,
    } as const;

    const store = storeMap[args.p_entity_type] as unknown as Map<
      string,
      Record<string, unknown> & { version: number; deleted_at: string | null }
    >;
    const existing = store.get(args.p_entity_id);

    if (args.p_operation === 'create') {
      if (existing && existing.deleted_at === null) {
        return {
          status: 'conflict',
          reason: 'already_exists',
          current_version: existing.version,
          current_row: { ...existing },
        };
      }

      let created: Record<string, unknown>;
      if (args.p_entity_type === 'project') {
        created = {
          id: args.p_entity_id,
          user_id: args.p_user_id,
          name: String(payload.name ?? 'Untitled Project'),
          version: 1,
          deleted_at: null,
          created_at: now,
          updated_at: now,
        };
      } else if (args.p_entity_type === 'workspace_folder') {
        created = {
          id: args.p_entity_id,
          user_id: args.p_user_id,
          project_id: projectId,
          parent_folder_id: (payload.parent_folder_id ?? payload.parentFolderId ?? null) as
            | string
            | null,
          name: String(payload.name ?? 'New Folder'),
          version: 1,
          deleted_at: null,
          created_at: now,
          updated_at: now,
        };
      } else if (args.p_entity_type === 'document') {
        created = {
          id: args.p_entity_id,
          user_id: args.p_user_id,
          project_id: projectId,
          folder_id: (payload.folder_id ?? payload.folderId ?? null) as string | null,
          title: String(payload.title ?? 'Untitled Document'),
          content: String(payload.content ?? ''),
          format: String(payload.format ?? 'markdown'),
          version: 1,
          deleted_at: null,
          created_at: now,
          updated_at: now,
        };
      } else {
        created = {
          id: args.p_entity_id,
          user_id: args.p_user_id,
          project_id: projectId,
          folder_id: (payload.folder_id ?? payload.folderId ?? null) as string | null,
          name: String(payload.name ?? 'New System Design'),
          board_state: (payload.board_state ?? payload.boardState ?? {
            nodes: [],
            edges: [],
            strokes: [],
          }) as Record<string, unknown>,
          version: 1,
          deleted_at: null,
          created_at: now,
          updated_at: now,
        };
      }

      store.set(args.p_entity_id, created);
      this.appendChange(
        args.p_user_id,
        args.p_entity_type,
        args.p_entity_id,
        'create',
        1,
        args.p_mutation_id,
        { ...created },
      );
      return { status: 'applied', version: 1, updated_at: now };
    }

    if (!existing || existing.deleted_at !== null) {
      if (args.p_operation === 'delete') {
        return { status: 'applied', version: null, updated_at: now };
      }
      return {
        status: 'conflict',
        reason: 'remote_deleted',
        current_version: null,
      };
    }

    if (!args.p_base_version || existing.version !== args.p_base_version) {
      return {
        status: 'conflict',
        reason: 'version_mismatch',
        current_version: existing.version,
        current_row: { ...existing },
      };
    }

    if (args.p_operation === 'delete') {
      store.delete(args.p_entity_id);
      this.appendChange(
        args.p_user_id,
        args.p_entity_type,
        args.p_entity_id,
        'delete',
        existing.version,
        args.p_mutation_id,
        null,
      );
      return { status: 'applied', version: null, updated_at: now };
    }

    const nextVersion = existing.version + 1;
    const updated = {
      ...existing,
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.content !== undefined ? { content: payload.content } : {}),
      ...(payload.format !== undefined ? { format: payload.format } : {}),
      ...(payload.folder_id !== undefined || payload.folderId !== undefined
        ? { folder_id: payload.folder_id ?? payload.folderId ?? null }
        : {}),
      ...(payload.board_state !== undefined || payload.boardState !== undefined
        ? { board_state: payload.board_state ?? payload.boardState }
        : {}),
      version: nextVersion,
      updated_at: now,
    };

    store.set(args.p_entity_id, updated);
    this.appendChange(
      args.p_user_id,
      args.p_entity_type,
      args.p_entity_id,
      'update',
      nextVersion,
      args.p_mutation_id,
      { ...updated },
    );

    return { status: 'applied', version: nextVersion, updated_at: now };
  }
}

export async function seedSupabaseSessionInStorage(
  page: Page,
  server: StatefulMockSupabase,
  account: MockUserAccount,
  expiresOffsetSec = 3600,
): Promise<void> {
  const sessionJson = server.buildSessionJson(account, expiresOffsetSec);
  await page.evaluate((json) => {
    const keysToUpdate: string[] = ['sb-dummy-auth-token'];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && /^sb-.*-auth-token$/.test(k) && !keysToUpdate.includes(k)) {
        keysToUpdate.push(k);
      }
    }
    for (const key of keysToUpdate) {
      localStorage.setItem(key, json);
    }
  }, sessionJson);
}
