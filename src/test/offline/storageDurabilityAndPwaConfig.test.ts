import 'fake-indexeddb/auto';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UserSyncRuntime } from '@/lib/sync/userSyncRuntime';
import { resetTabCoordinatorsForTesting } from '@/lib/sync/tabCoordinator';
import { ArtixDB, deleteArtixDB } from '@/lib/local/db';

describe('OF-08 & OF-13 / TASK-28: PWA Cold-Start Self-Containment, Self-Hosted Fonts, sw.js Headers & storage.persist()', () => {
  const rootDir = process.cwd();

  beforeEach(async () => {
    resetTabCoordinatorsForTesting();
    await deleteArtixDB();
  });

  afterEach(async () => {
    resetTabCoordinatorsForTesting();
    await deleteArtixDB();
  });

  it('eliminates render-blocking Google Fonts @import from src/index.css and bundles @fontsource locally', () => {
    const css = fs.readFileSync(path.join(rootDir, 'src/index.css'), 'utf-8');
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
    };

    expect(css).not.toMatch(/fonts\.googleapis\.com/i);
    expect(css).not.toMatch(/fonts\.gstatic\.com/i);
    expect(pkg.dependencies?.['@fontsource/inter']).toBeTruthy();
    expect(pkg.dependencies?.['@fontsource/jetbrains-mono']).toBeTruthy();
    expect(css).toContain('@fontsource/inter');
    expect(css).toContain('@fontsource/jetbrains-mono');
  });

  it('configures Workbox with clientsClaim, skipWaiting, cleanupOutdatedCaches, navigateFallback, ttf/woff2 globPatterns, and 5 MiB limit', () => {
    const viteConfig = fs.readFileSync(path.join(rootDir, 'vite.config.ts'), 'utf-8');

    expect(viteConfig).toMatch(/clientsClaim:\s*true/);
    expect(viteConfig).toMatch(/skipWaiting:\s*true/);
    expect(viteConfig).toMatch(/cleanupOutdatedCaches:\s*true/);
    expect(viteConfig).toMatch(/navigateFallback:\s*["']\/index\.html["']/);
    expect(viteConfig).toMatch(/woff2/);
    expect(viteConfig).toMatch(/ttf/);
    expect(viteConfig).toMatch(/maximumFileSizeToCacheInBytes:\s*5\s*\*\s*1024\s*\*\s*1024/);
  });

  it('sets must-revalidate Cache-Control headers on /sw.js and /manifest.webmanifest and removes Google Fonts from CSP in vercel.json', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(rootDir, 'vercel.json'), 'utf-8')) as {
      headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    };

    const swHeaderRule = vercel.headers.find((h) => h.source === '/sw.js');
    expect(swHeaderRule).toBeDefined();
    expect(swHeaderRule?.headers).toContainEqual({
      key: 'Cache-Control',
      value: 'public, max-age=0, must-revalidate',
    });

    const manifestHeaderRule = vercel.headers.find((h) => h.source === '/manifest.webmanifest');
    expect(manifestHeaderRule).toBeDefined();
    expect(manifestHeaderRule?.headers).toContainEqual({
      key: 'Cache-Control',
      value: 'public, max-age=0, must-revalidate',
    });

    const globalRule = vercel.headers.find((h) => h.source === '/(.*)');
    const csp = globalRule?.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
    expect(csp).not.toContain('fonts.googleapis.com');
    expect(csp).not.toContain('fonts.gstatic.com');
  });

  it('requests navigator.storage.persist() and estimate() during UserSyncRuntime.start() and exposes durability metrics on RuntimeStatus', async () => {
    const persistMock = vi.fn().mockResolvedValue(true);
    const estimateMock = vi.fn().mockResolvedValue({
      usage: 4_194_304,
      quota: 1_073_741_824,
    });

    const originalStorageDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'storage');
    Object.defineProperty(window.navigator, 'storage', {
      configurable: true,
      value: {
        persist: persistMock,
        estimate: estimateMock,
      },
    });

    try {
      const testDb = new ArtixDB('ArtixDB_test_persist');
      const runtime = new UserSyncRuntime('user-persist-1', {
        db: testDb,
        cloudSyncPaused: true,
      });

      await runtime.start();
      const status = runtime.getStatus();

      expect(persistMock).toHaveBeenCalledTimes(1);
      expect(estimateMock).toHaveBeenCalledTimes(1);
      expect(status.storagePersisted).toBe(true);
      expect(status.usageBytes).toBe(4_194_304);
      expect(status.quotaBytes).toBe(1_073_741_824);

      await runtime.stop();
      await deleteArtixDB('ArtixDB_test_persist');
    } finally {
      if (originalStorageDescriptor) {
        Object.defineProperty(window.navigator, 'storage', originalStorageDescriptor);
      } else {
        delete (window.navigator as { storage?: unknown }).storage;
      }
    }
  });
});
