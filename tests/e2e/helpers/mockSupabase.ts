import type { Page } from '@playwright/test';

export const E2E_USER_ID = '00000000-0000-4000-8000-000000000001';
export const E2E_PROJECT_ID = 'e2e-demo-project';

export function isDummySupabaseEnv(): boolean {
  const url = process.env.VITE_SUPABASE_URL || 'https://dummy.supabase.co';
  return url.includes('dummy.supabase.co');
}

/**
 * Installs deterministic route handlers for `*.supabase.co` so browser tests
 * never depend on external DNS or live Supabase availability in CI.
 */
export async function mockSupabaseNetwork(
  page: Page,
  options: { authenticated: boolean }
): Promise<void> {
  const nowIso = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;

  const mockUser = {
    id: E2E_USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'e2e@artix.dev',
    email_confirmed_at: nowIso,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { display_name: 'E2E Engineer' },
    created_at: nowIso,
    updated_at: nowIso,
  };

  const mockProjects = [
    {
      id: E2E_PROJECT_ID,
      user_id: E2E_USER_ID,
      name: 'E2E Architecture Project',
      created_at: nowIso,
      updated_at: nowIso,
    },
  ];

  await page.route('**/*.supabase.co/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const accept = req.headers()['accept'] || '';
    const wantsObject = accept.includes('application/vnd.pgrst.object+json');

    if (url.includes('/auth/v1/user')) {
      if (!options.authenticated) {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Auth session missing' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockUser),
      });
      return;
    }

    if (url.includes('/auth/v1/token')) {
      if (!options.authenticated) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'invalid_grant' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'e2e-mock-access-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: expiresAt,
          refresh_token: 'e2e-mock-refresh-token',
          user: mockUser,
        }),
      });
      return;
    }

    if (url.includes('/auth/v1/logout')) {
      await route.fulfill({ status: 204, body: '' });
      return;
    }

    if (url.includes('/rest/v1/projects')) {
      if (req.method() === 'POST') {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(req.postData() || '{}');
        } catch {
          parsed = {};
        }
        const created = {
          id: `proj-${Date.now()}`,
          user_id: E2E_USER_ID,
          name: String(parsed.name || 'Created E2E Project'),
          created_at: nowIso,
          updated_at: nowIso,
        };
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(wantsObject ? created : [created]),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(wantsObject ? mockProjects[0] : mockProjects),
      });
      return;
    }

    if (url.includes('/rest/v1/subscriptions')) {
      const sub = {
        user_id: E2E_USER_ID,
        plan_tier: 'pro',
        status: 'active',
        billing_cycle: 'monthly',
        current_period_end: null,
        stripe_customer_id: 'cus_e2e_mock',
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(wantsObject ? sub : [sub]),
      });
      return;
    }

    // Default empty response for sync_changes, documents, system_designs, folders, profiles
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(wantsObject ? null : []),
    });
  });
}

/**
 * Seeds both an authenticated Supabase session (compatible with any project ref)
 * and obfuscated BYOK AI settings before page scripts execute.
 */
export async function installAuthenticatedE2ESession(page: Page): Promise<void> {
  await mockSupabaseNetwork(page, { authenticated: true });

  await page.addInitScript(
    ({ userId }) => {
      const nowSec = Math.floor(Date.now() / 1000);
      const sessionJson = JSON.stringify({
        access_token: 'e2e-mock-access-token',
        refresh_token: 'e2e-mock-refresh-token',
        expires_in: 3600,
        expires_at: nowSec + 3600,
        token_type: 'bearer',
        user: {
          id: userId,
          aud: 'authenticated',
          role: 'authenticated',
          email: 'e2e@artix.dev',
          email_confirmed_at: new Date().toISOString(),
          app_metadata: { provider: 'email', providers: ['email'] },
          user_metadata: { display_name: 'E2E Engineer' },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      });

      localStorage.setItem('sb-dummy-auth-token', sessionJson);
      localStorage.setItem(
        'artix.ai.settings.v1',
        JSON.stringify({
          primary: {
            provider: 'openai',
            apiKey: 'obf:c2stbW9jay10ZXN0LWtleQ==', // obf:sk-mock-test-key
            model: 'gpt-4o',
          },
        })
      );

      // Ensure custom local .env Supabase project refs also hydrate the mock session
      let activeMockSession: string | null = sessionJson;
      const origGetItem = Storage.prototype.getItem;
      const origRemoveItem = Storage.prototype.removeItem;

      Storage.prototype.getItem = function (key: string): string | null {
        const existing = origGetItem.call(this, key);
        if (
          existing === null &&
          this === window.localStorage &&
          activeMockSession &&
          /^sb-.*-auth-token$/.test(key)
        ) {
          return activeMockSession;
        }
        return existing;
      };

      Storage.prototype.removeItem = function (key: string): void {
        if (this === window.localStorage && /^sb-.*-auth-token$/.test(key)) {
          activeMockSession = null;
        }
        return origRemoveItem.call(this, key);
      };
    },
    { userId: E2E_USER_ID }
  );
}
