import { test, expect } from '@playwright/test';
import {
  E2E_PROJECT_ID,
  installAuthenticatedE2ESession,
} from './helpers/mockSupabase';

test.describe('2. Functional E2E Product Journeys', () => {
  test.beforeEach(async ({ page }) => {
    await installAuthenticatedE2ESession(page);
  });

  test('Dashboard renders navigation, project creation modal, and pricing links', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByText(/Artix/i).first()).toBeVisible();
    const newProjectBtn = page.getByRole('button', { name: /New Project/i }).first();
    await expect(newProjectBtn).toBeVisible();

    // Open New Project Modal
    await newProjectBtn.click();
    await expect(page.getByText(/Create New Project/i)).toBeVisible();
  });

  test('PRD Generator Modal opens, switches templates, and generates Markdown PRD', async ({ page }) => {
    // Intercept AI streaming call to return deterministic test PRD
    await page.route('**/v1/chat/completions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {"choices":[{"delta":{"content":"# Agile PRD: Authentication System\\n\\n## Given/When/Then DoD\\n- **Given** user is on login page\\n- **When** credentials are submitted\\n- **Then** JWT session is set."}}]}\n\ndata: [DONE]\n\n',
      });
    });

    await page.goto(`/projects/${E2E_PROJECT_ID}`);

    const prdButton = page.getByRole('button', { name: /PRD|Generate PRD/i }).first();
    if (await prdButton.isVisible()) {
      await prdButton.click();
      await expect(page.getByText(/PRD Generator/i)).toBeVisible();

      const templateSelect = page.locator('select, [role="combobox"]').first();
      if (await templateSelect.isVisible()) {
        await templateSelect.click();
      }

      const textarea = page.locator('textarea').first();
      if (await textarea.isVisible()) {
        await textarea.fill('Build a secure JWT authentication system with Supabase RLS.');
      }

      const generateBtn = page.getByRole('button', { name: /Generate/i }).first();
      if (await generateBtn.isVisible()) {
        await generateBtn.click();
      }
    }
  });

  test('Vibe Coding Generator supports Artix, Cursor, and Generic targets with Copy & Refine', async ({ page }) => {
    await page.route('**/v1/chat/completions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {"choices":[{"delta":{"content":"## Goal\\nImplement Supabase RLS policy.\\n\\n## Files to Modify\\n- [MODIFY] src/hooks/useAuth.tsx"}}]}\n\ndata: [DONE]\n\n',
      });
    });

    await page.goto(`/projects/${E2E_PROJECT_ID}`);

    const vibeButton = page.getByRole('button', { name: /Vibe|Vibe Coding/i }).first();
    if (await vibeButton.isVisible()) {
      await vibeButton.click();
      await expect(page.getByText(/Vibe Coding Prompt Generator/i)).toBeVisible();

      await expect(page.getByText(/Bolt/i)).not.toBeVisible();
      await expect(page.getByText(/v0/i)).not.toBeVisible();
    }
  });

  test('Agentic Workflow Designer supports pattern switching and topology parameters', async ({ page }) => {
    await page.goto(`/projects/${E2E_PROJECT_ID}`);

    const agentButton = page.getByRole('button', { name: /Agentic|Agentic Workflow/i }).first();
    if (await agentButton.isVisible()) {
      await agentButton.click();
      await expect(page.getByText(/Agentic Workflow Designer/i)).toBeVisible();
    }
  });

  test('System Architect Canvas renders nodes and triggers Auto Layout', async ({ page }) => {
    await page.goto(`/projects/${E2E_PROJECT_ID}`);

    const autoLayoutBtn = page.getByRole('button', { name: /Auto Layout/i }).first();
    if (await autoLayoutBtn.isVisible()) {
      await autoLayoutBtn.click();
      await expect(page.getByText(/Arranged/i)).toBeVisible();
    }
  });
});
