import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:8080';
const useLiveSupabase = process.env.PLAYWRIGHT_LIVE_SUPABASE === '1';

/**
 * Playwright E2E, PWA Offline Cold-Start & Security Test Suite Configuration.
 * Builds and serves the real production bundle (`npm run build && npm run preview`)
 * so Workbox `sw.js` precaching, offline hard reloads, and local Monaco workers
 * are verified end-to-end in a real browser context (TASK-14 / S-07 / OF-16).
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL,
    serviceWorkers: 'allow',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: process.env.CI
    ? [
        {
          name: 'chromium',
          use: { ...devices['Desktop Chrome'] },
        },
      ]
    : [
        {
          name: 'chromium',
          use: { ...devices['Desktop Chrome'] },
        },
        {
          name: 'firefox',
          use: { ...devices['Desktop Firefox'] },
        },
        {
          name: 'webkit',
          use: { ...devices['Desktop Safari'] },
        },
      ],
  webServer: {
    command: 'npm run build && npm run preview',
    url: baseURL,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === '1',
    timeout: 180 * 1000,
    env: {
      ...process.env,
      VITE_SUPABASE_URL:
        useLiveSupabase && process.env.VITE_SUPABASE_URL
          ? process.env.VITE_SUPABASE_URL
          : 'https://dummy.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY:
        useLiveSupabase && process.env.VITE_SUPABASE_PUBLISHABLE_KEY
          ? process.env.VITE_SUPABASE_PUBLISHABLE_KEY
          : 'dummy-anon-key',
    },
  },
});
