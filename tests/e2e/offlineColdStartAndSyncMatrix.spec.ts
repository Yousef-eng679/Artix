import { test, expect, type Page } from '@playwright/test';
import {
  StatefulMockSupabase,
  seedSupabaseSessionInStorage,
  type MockUserAccount,
} from './helpers/statefulMockSupabase';

const USER_A: MockUserAccount = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'alice-e2e@example.test',
  displayName: 'Alice Architect',
  planTier: 'pro',
};

const USER_B: MockUserAccount = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'bob-e2e@example.test',
  displayName: 'Bob Builder',
  planTier: 'pro',
};

const USER_UNHYDRATED: MockUserAccount = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'new-device@example.test',
  displayName: 'New Device User',
  planTier: 'free',
};

async function waitForActiveServiceWorker(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        return page.evaluate(async () => {
          if (!('serviceWorker' in navigator)) return false;
          const reg = await navigator.serviceWorker.getRegistration();
          if (!reg) return false;
          await navigator.serviceWorker.ready;
          return navigator.serviceWorker.controller !== null;
        });
      },
      {
        timeout: 20_000,
        message: 'Expected production Workbox Service Worker to claim control of the page',
      },
    )
    .toBe(true);
}

async function replaceMonacoEditorText(page: Page, nextText: string): Promise<void> {
  const viewLines = page.locator('.monaco-editor .view-lines').first();
  await expect(viewLines).toBeVisible({ timeout: 15_000 });
  await viewLines.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(nextText);
}

test.describe('4. True Offline-First Cold-Start Matrix, Sync Liveness & Isolation (TASK-14 / OF-16 / S-07)', () => {
  test('Matrix Case 1 & 8 Acceptance Steps: active SW + offline hard reload + offline Monaco edit & doc create + second offline reload + automatic reconnect sync', async ({
    context,
    page,
  }) => {
    const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    const folderId = 'ffffffff-ffff-4fff-8fff-fffffffffff1';
    const docId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
    const designId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';

    const server = new StatefulMockSupabase(USER_A);
    server.seedProject({ id: projectId, userId: USER_A.id, name: 'Offline Architecture Workspace' });
    server.seedFolder({ id: folderId, userId: USER_A.id, projectId, name: 'Core Specs' });
    server.seedDocument({
      id: docId,
      userId: USER_A.id,
      projectId,
      title: 'API Contract',
      content: '# API Contract v1',
    });
    server.seedDesign({
      id: designId,
      userId: USER_A.id,
      projectId,
      name: 'Gateway Topology',
    });
    await server.attach(context);

    // Boot public landing first so origin exists, seed session once, then hydrate online
    await page.goto('/auth');
    await waitForActiveServiceWorker(page);
    await seedSupabaseSessionInStorage(page, server, USER_A, 3600);

    await page.goto('/dashboard');
    await expect(page.getByText('Offline Architecture Workspace').first()).toBeVisible({
      timeout: 15_000,
    });

    // Open project online briefly or wait for workspace hydration to complete in Dexie
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByText('API Contract').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Gateway Topology').first()).toBeVisible();
    await expect(page.getByText('Core Specs').first()).toBeVisible();

    // Return to /dashboard, disconnect network completely, and perform COLD HARD RELOAD
    await page.goto('/dashboard');
    await expect(page.getByText('Offline Architecture Workspace').first()).toBeVisible();

    server.setOffline(true);
    await context.setOffline(true);

    // Acceptance Step 1 & 3: Cold reload while offline -> SW serves app, /dashboard shows projects
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForActiveServiceWorker(page);
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    await expect(page.getByText('Offline Architecture Workspace').first()).toBeVisible({
      timeout: 15_000,
    });

    // Acceptance Step 4: Open project offline -> files, folders, and system designs render
    await page.getByText('Offline Architecture Workspace').first().click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}`));
    await expect(page.getByText('API Contract').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Gateway Topology').first()).toBeVisible();
    await expect(page.getByText('Core Specs').first()).toBeVisible();

    // Acceptance Step 5: Open document -> local Monaco mounts offline & saves edits to Dexie
    await page.getByText('API Contract').first().click();
    await replaceMonacoEditorText(page, '# API Contract v2 — Edited Offline');
    await page.waitForTimeout(2_000); // allow 1500ms debounced autosave to commit to Dexie

    // Acceptance Step 6: Create a brand-new document while offline
    await page.getByRole('button', { name: 'Create new document' }).click();
    const nameInput = page.locator('#rename-input');
    await expect(nameInput).toBeVisible({ timeout: 10_000 });
    await nameInput.fill('Offline Created RFC');
    await page.getByRole('button', { name: /^Save$/i }).click();
    await expect(page.getByText('Offline Created RFC').first()).toBeVisible({ timeout: 10_000 });

    // Acceptance Step 5b: Hard reload AGAIN while STILL offline -> edits & new doc survive!
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Offline Created RFC').first()).toBeVisible({ timeout: 15_000 });
    await page.getByText('API Contract').first().click();
    await expect(page.locator('.monaco-editor').first()).toContainText('Edited Offline', {
      timeout: 15_000,
    });

    // Acceptance Step 7: Restore network -> automatic sync pushes both mutations within seconds
    server.setOffline(false);
    await context.setOffline(false);

    await expect
      .poll(
        () => {
          const updatedDoc = server.documents.get(docId);
          const createdRfc = [...server.documents.values()].find(
            (d) => d.title === 'Offline Created RFC',
          );
          return {
            updatedVersion: updatedDoc?.version ?? 0,
            updatedContent: updatedDoc?.content ?? '',
            hasCreatedRfc: Boolean(createdRfc),
          };
        },
        { timeout: 15_000 },
      )
      .toEqual({
        updatedVersion: 2,
        updatedContent: '# API Contract v2 — Edited Offline',
        hasCreatedRfc: true,
      });
  });

  test('Matrix Case 2: expired JWT (>2h) offline cold reload preserves session & Dexie workspace, then refreshes token and syncs on reconnect (OF-02, OF-03, TASK-25)', async ({
    context,
    page,
  }) => {
    const projectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
    const docId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2';

    const server = new StatefulMockSupabase(USER_A);
    server.seedProject({ id: projectId, userId: USER_A.id, name: 'Expired JWT Continuity Project' });
    server.seedDocument({
      id: docId,
      userId: USER_A.id,
      projectId,
      title: 'Continuity Spec',
      content: 'Initial v1',
    });
    await server.attach(context);

    await page.goto('/auth');
    await waitForActiveServiceWorker(page);
    await seedSupabaseSessionInStorage(page, server, USER_A, 3600);

    // Hydrate workspace online
    await page.goto('/dashboard');
    await expect(page.getByText('Expired JWT Continuity Project').first()).toBeVisible({
      timeout: 15_000,
    });

    // Expire access_token to 2 hours in the past (-7200s) and cut network
    await seedSupabaseSessionInStorage(page, server, USER_A, -7200);
    const callsBeforeOffline = server.tokenRefreshCalls;
    server.setOffline(true);
    await context.setOffline(true);

    // Cold reload /dashboard while offline with expired JWT -> MUST NOT redirect to /auth!
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText('Expired JWT Continuity Project').first()).toBeVisible({
      timeout: 15_000,
    });

    // Open project & edit Continuity Spec while offline under expired JWT
    await page.getByText('Expired JWT Continuity Project').first().click();
    await expect(page.getByText('Continuity Spec').first()).toBeVisible({ timeout: 15_000 });
    await page.getByText('Continuity Spec').first().click();
    await replaceMonacoEditorText(page, 'Edited offline with expired token');
    await page.waitForTimeout(2_000);

    // Reconnect -> auth refreshes token & sync engine pushes offline edit automatically
    server.setOffline(false);
    await context.setOffline(false);

    await expect
      .poll(
        () => ({
          refreshed: server.tokenRefreshCalls > callsBeforeOffline,
          content: server.documents.get(docId)?.content,
          version: server.documents.get(docId)?.version,
        }),
        { timeout: 15_000 },
      )
      .toEqual({
        refreshed: true,
        content: 'Edited offline with expired token',
        version: 2,
      });
  });

  test('Matrix Case 3 & Case 4: unhydrated new profile offline shows explicit notice, and pre-SW first-ever offline visit fails natively (OF-06, TASK-27)', async ({
    browser,
    context,
    page,
  }) => {
    const server = new StatefulMockSupabase(USER_UNHYDRATED);
    await server.attach(context);

    // Install SW on public /auth BEFORE any user logs in (Dexie for USER_UNHYDRATED is unhydrated)
    await page.goto('/auth');
    await waitForActiveServiceWorker(page);

    // Seed session for brand-new unhydrated user, then cut network BEFORE first /dashboard load
    await seedSupabaseSessionInStorage(page, server, USER_UNHYDRATED, -3600);
    server.setOffline(true);
    await context.setOffline(true);

    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    const unhydratedBanner = page.getByTestId('unhydrated-offline-banner');
    await expect(unhydratedBanner).toBeVisible({ timeout: 15_000 });
    await expect(unhydratedBanner).toContainText(
      'Workspace not yet downloaded for offline use — connect once to sync.',
    );

    // Matrix Case 4: Brand-new isolated context with zero prior visit (no SW installed) while offline
    const freshOfflineContext = await browser.newContext();
    try {
      await freshOfflineContext.setOffline(true);
      const freshPage = await freshOfflineContext.newPage();
      await expect(freshPage.goto('/dashboard')).rejects.toThrow();
    } finally {
      await freshOfflineContext.close();
    }
  });

  test('Multi-device CAS conflict resolution modal & stale dirty editor buffer protection prevent silent data loss (TASK-10, TASK-16, S-03, OF-11)', async ({
    context,
    page,
  }) => {
    const projectId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
    const docId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3';

    const server = new StatefulMockSupabase(USER_A);
    server.seedProject({ id: projectId, userId: USER_A.id, name: 'Conflict & Buffer Project' });
    server.seedDocument({
      id: docId,
      userId: USER_A.id,
      projectId,
      title: 'Shared Architecture RFC',
      content: '# Header\nOriginal Base Line',
    });
    await server.attach(context);

    await page.goto('/auth');
    await waitForActiveServiceWorker(page);
    await seedSupabaseSessionInStorage(page, server, USER_A, 3600);

    await page.goto(`/projects/${projectId}?doc=${docId}`);
    await expect(page.locator('.monaco-editor').first()).toContainText('Original Base Line', {
      timeout: 15_000,
    });

    // Part A: Go offline -> Device B commits v2 remotely while Device A edits v1 locally
    server.setOffline(true);
    await context.setOffline(true);

    server.simulateExternalDocumentUpdate(docId, {
      content: '# Header\nRemote Device B Update v2',
    });

    await replaceMonacoEditorText(page, '# Header\nLocal Device A Offline Edit');
    await page.waitForTimeout(2_000); // saves to local Dexie + outbox with baseServerVersion = 1

    // Reconnect -> CAS push detects version_mismatch -> ConflictResolutionCenter banner appears
    server.setOffline(false);
    await context.setOffline(false);

    const conflictBanner = page.getByTestId('conflict-banner');
    await expect(conflictBanner).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('review-conflicts-btn').click();

    const conflictModal = page.getByTestId('conflict-modal');
    await expect(conflictModal).toBeVisible();
    await page.getByTestId('conflict-keep-local-btn').click();

    await expect(conflictModal).toBeHidden({ timeout: 10_000 });
    await expect
      .poll(() => ({
        version: server.documents.get(docId)?.version,
        content: server.documents.get(docId)?.content,
      }))
      .toEqual({
        version: 3,
        content: '# Header\nLocal Device A Offline Edit',
      });

    // Part B: Stale Dirty Buffer Banner — type unsaved keystrokes while remote v4 arrives via pull
    server.simulateExternalDocumentUpdate(docId, {
      content: '# Header\nUrgent Remote Hotfix v4',
    });

    // Make editor buffer dirty WITHOUT waiting 1500ms for autosave, then trigger immediate online pull
    await replaceMonacoEditorText(page, '# Header\nUnsaved Dirty Typing In Progress');
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
    });

    const staleBanner = page.getByTestId('stale-buffer-banner');
    await expect(staleBanner).toBeVisible({ timeout: 15_000 });

    // Wait past autosave window and prove server v4 was NOT silently overwritten!
    await page.waitForTimeout(2_000);
    expect(server.documents.get(docId)?.content).toBe('# Header\nUrgent Remote Hotfix v4');
    expect(server.documents.get(docId)?.version).toBe(4);
  });

  test('Acceptance Step 8: Account switch A -> B -> A isolates Dexie & QueryClient caches and keeps sync alive (TASK-11, S-06, OF-12)', async ({
    context,
    page,
  }) => {
    const projA = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
    const projB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2';

    const server = new StatefulMockSupabase(USER_A);
    server.registerUser(USER_B);
    server.seedProject({ id: projA, userId: USER_A.id, name: 'Alice Confidential Project' });
    server.seedProject({ id: projB, userId: USER_B.id, name: 'Bob Isolated Project' });
    await server.attach(context);

    // 1. Login as Account A
    await page.goto('/auth');
    await waitForActiveServiceWorker(page);
    await seedSupabaseSessionInStorage(page, server, USER_A, 3600);
    await page.goto('/dashboard');
    await expect(page.getByText('Alice Confidential Project').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Bob Isolated Project')).toHaveCount(0);

    // 2. Sign out Account A -> switch to Account B
    const signOutBtn = page.getByRole('button', { name: /Sign Out|Log Out|Logout/i }).first();
    await signOutBtn.click();
    await expect(page).toHaveURL(/\/$|\/auth/);

    server.setActiveUser(USER_B);
    await seedSupabaseSessionInStorage(page, server, USER_B, 3600);
    await page.goto('/dashboard');

    await expect(page.getByText('Bob Isolated Project').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Alice Confidential Project')).toHaveCount(0);

    // 3. Sign out Account B -> switch BACK to Account A and prove SyncEngine + TabCoordinator still sync!
    await page.getByRole('button', { name: /Sign Out|Log Out|Logout/i }).first().click();
    await expect(page).toHaveURL(/\/$|\/auth/);

    server.setActiveUser(USER_A);
    await seedSupabaseSessionInStorage(page, server, USER_A, 3600);
    await page.goto('/dashboard');
    await expect(page.getByText('Alice Confidential Project').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Bob Isolated Project')).toHaveCount(0);

    // Create a new project as Account A after A -> B -> A round-trip and assert it syncs to Account A!
    await page.getByRole('button', { name: /New Project/i }).first().click();
    const projInput = page.locator('#name, input[placeholder*="Acme"], input[type="text"]').first();
    await expect(projInput).toBeVisible();
    await projInput.fill('Alice Post-Switch Synced Project');
    await page.getByRole('button', { name: /Create Project/i }).click();

    await expect
      .poll(
        () => {
          const synced = [...server.projects.values()].find(
            (p) => p.name === 'Alice Post-Switch Synced Project',
          );
          return synced?.user_id ?? null;
        },
        { timeout: 15_000 },
      )
      .toBe(USER_A.id);
  });
});
