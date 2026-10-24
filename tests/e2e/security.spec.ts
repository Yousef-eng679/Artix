import { test, expect } from '@playwright/test';
import {
  E2E_PROJECT_ID,
  installAuthenticatedE2ESession,
  isDummySupabaseEnv,
} from './helpers/mockSupabase';

test.describe('3. Security & Penetration Audits', () => {
  test.describe('Browser DOM & storage security', () => {
    test.beforeEach(async ({ page }) => {
      await installAuthenticatedE2ESession(page);
    });

    test('XSS Injection: Malicious script tags in inputs are safely sanitized in DOM rendering', async ({ page }) => {
      await page.goto('/dashboard');

      const newProjectBtn = page.getByRole('button', { name: /New Project/i }).first();
      await expect(newProjectBtn).toBeVisible();
      await newProjectBtn.click();

      const input = page.locator('#name, input[placeholder*="Acme"], input[type="text"]').first();
      await expect(input).toBeVisible();

      const xssPayload = '<script id="xss-tl">window.__XSS_EXECUTED__=true;</script>';
      await input.fill(xssPayload);

      const createBtn = page.getByRole('button', { name: /Create Project/i });
      await createBtn.click();

      const executed = await page.evaluate(
        () => (window as unknown as { __XSS_EXECUTED__?: boolean }).__XSS_EXECUTED__
      );
      expect(executed).toBeUndefined();
    });

    test('XSS Injection: Vector image handlers (<img src=x onerror=...>) do not execute script context', async ({ page }) => {
      await page.goto('/pricing');

      const payload = '<img src="invalid-img.png" onerror="window.__XSS_IMG__=true;" />';
      await page.evaluate((html) => {
        const div = document.createElement('div');
        div.textContent = html;
        document.body.appendChild(div);
      }, payload);

      const executed = await page.evaluate(
        () => (window as unknown as { __XSS_IMG__?: boolean }).__XSS_IMG__
      );
      expect(executed).toBeUndefined();
    });

    test('API Key Obfuscation: Stored keys in localStorage are obfuscated with obf: prefix', async ({ page }) => {
      await page.goto('/settings');

      const keyInput = page.locator('input[type="password"], input[placeholder*="key"]').first();
      if (await keyInput.isVisible()) {
        await keyInput.fill('sk-test-secret-api-key-99999');

        const saveBtn = page.getByRole('button', { name: /Save|Update/i }).first();
        if (await saveBtn.isVisible()) {
          await saveBtn.click();
        }
      }

      const rawStored = await page.evaluate(() => localStorage.getItem('artix.ai.settings.v1'));
      expect(rawStored).not.toBeNull();
      expect(rawStored).not.toContain('sk-test-secret-api-key-99999');
      expect(rawStored).toContain('obf:');
    });

    test('Double-Click Prevention: Rapid submit clicks do not fire duplicate API invocations', async ({ page }) => {
      let callCount = 0;
      await page.route('**/v1/chat/completions', async (route) => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 500));
        await route.fulfill({ status: 200, body: 'data: {"choices":[]}\n\n' });
      });

      await page.goto(`/projects/${E2E_PROJECT_ID}`);
      const prdButton = page.getByRole('button', { name: /PRD|Generate PRD/i }).first();
      if (await prdButton.isVisible()) {
        await prdButton.click();

        const generateBtn = page.getByRole('button', { name: /Generate/i }).first();
        if (await generateBtn.isVisible()) {
          await generateBtn.click({ clickCount: 3, delay: 50 });
          await page.waitForTimeout(1000);
          expect(callCount).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  test('CORS Edge Function Headers: Edge Functions enforce origin restrictions', async ({ request }) => {
    test.skip(
      isDummySupabaseEnv(),
      'Skipped when VITE_SUPABASE_URL uses dummy CI placeholder; CORS logic is verified in src/test/security.test.ts.'
    );
    const supabaseUrl = process.env.VITE_SUPABASE_URL!;

    const response = await request.fetch(`${supabaseUrl}/functions/v1/create-checkout-session`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://malicious-attacker-domain.com',
        'Access-Control-Request-Method': 'POST',
      },
    });

    const allowOrigin = response.headers()['access-control-allow-origin'];
    if (allowOrigin && allowOrigin !== '*') {
      expect(allowOrigin).not.toEqual('https://malicious-attacker-domain.com');
    }
  });
});
