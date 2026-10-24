import { test, expect } from '@playwright/test';
import { isDummySupabaseEnv, mockSupabaseNetwork } from './helpers/mockSupabase';

test.describe('1. Authentication & Session Security', () => {
  test.describe('Browser route protection', () => {
    test.beforeEach(async ({ page }) => {
      await mockSupabaseNetwork(page, { authenticated: false });
    });

    test('unauthenticated users accessing /dashboard should be redirected to /auth', async ({ page }) => {
      await page.goto('/dashboard');
      await page.waitForURL(/\/auth(?:\?|$)/);
      await expect(page).toHaveURL(/\/auth(?:\?|$)/);
    });

    test('unauthenticated users accessing /projects/* should be redirected', async ({ page }) => {
      await page.goto('/projects/invalid-project-id-123');
      await page.waitForURL(/\/auth(?:\?|$)/);
      await expect(page).toHaveURL(/\/auth(?:\?|$)/);
    });

    test('public pages like /pricing should be accessible without authentication', async ({ page }) => {
      await page.goto('/pricing');
      await expect(page.getByText(/Simple, transparent pricing/i)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Free' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Pro' })).toBeVisible();
    });

    test('login page renders auth controls securely', async ({ page }) => {
      await page.goto('/auth');
      await expect(page.locator('input[type="email"]')).toBeVisible();
      await expect(page.locator('input[type="password"]')).toBeVisible();
      await expect(page.getByRole('button', { name: /sign in|login|submit/i }).first()).toBeVisible();
    });
  });

  test('direct unauthenticated REST API query to Supabase tables returns 401 Unauthorized', async ({ request }) => {
    test.skip(
      isDummySupabaseEnv(),
      'Skipped when VITE_SUPABASE_URL uses dummy CI placeholder; live endpoint check runs only against deployed Supabase.'
    );
    const supabaseUrl = process.env.VITE_SUPABASE_URL!;
    const response = await request.get(`${supabaseUrl}/rest/v1/projects?select=*`, {
      headers: {
        apikey: 'invalid-anon-key',
      },
    });
    expect([401, 403]).toContain(response.status());
  });
});
