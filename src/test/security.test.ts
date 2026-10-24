import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { isWithinLimit, PLAN_LIMITS } from '../lib/plans';
import { obfuscateApiKey, deobfuscateApiKey } from '../lib/ai/storage';
import { sanitizeRedirectUrl } from '../lib/utils';
import { clearSensitiveBrowserCaches } from '../lib/sync/userSyncRuntime';
import { MarkdownPreview, sanitizeMarkdownUrl } from '../components/Editor/MarkdownPreview';
import { isOriginAllowed, getCorsHeaders } from '../../supabase/functions/_shared/cors';

describe('Security Remediation Suite', () => {
  describe('API Key Obfuscation & Storage Protection (SEC-06)', () => {
    it('should obfuscate plain API keys before storing using real storage module', () => {
      const rawKey = 'sk-proj-1234567890abcdef';
      const obfuscated = obfuscateApiKey(rawKey);

      expect(obfuscated).not.toBe(rawKey);
      expect(obfuscated?.startsWith('obf:')).toBe(true);
    });

    it('should correctly deobfuscate stored API keys using real storage module', () => {
      const rawKey = 'sk-proj-1234567890abcdef';
      const obfuscated = obfuscateApiKey(rawKey);
      const restored = deobfuscateApiKey(obfuscated);

      expect(restored).toBe(rawKey);
    });

    it('should handle un-obfuscated legacy keys gracefully', () => {
      const legacyKey = 'sk-legacy-key';
      expect(deobfuscateApiKey(legacyKey)).toBe(legacyKey);
    });
  });

  describe('CORS Header Origin Protection (SEC-05)', () => {
    it('should allow whitelisted localhost and production origins', () => {
      expect(isOriginAllowed('http://localhost:8080')).toBe(true);
      expect(isOriginAllowed('http://localhost:5173')).toBe(true);
      expect(isOriginAllowed('https://artix-mocha.vercel.app')).toBe(true);
    });

    it('should allow authentic Artix Vercel preview branches', () => {
      expect(isOriginAllowed('https://artix-mocha-git-feature.vercel.app')).toBe(true);
    });

    it('should reject arbitrary untrusted vercel deployments and attacker origins', () => {
      expect(isOriginAllowed('https://evil.vercel.app')).toBe(false);
      expect(isOriginAllowed('https://phishing-artix.com')).toBe(false);
      expect(isOriginAllowed('not-a-valid-url')).toBe(false);
    });

    it('should dynamically set Access-Control-Allow-Origin from request headers', () => {
      const validReq = new Request('http://localhost:8080/api', {
        headers: { origin: 'http://localhost:8080' },
      });
      const headers = getCorsHeaders(validReq);
      expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:8080');

      const invalidReq = new Request('http://localhost:8080/api', {
        headers: { origin: 'https://evil.com' },
      });
      const fallbackHeaders = getCorsHeaders(invalidReq);
      expect(fallbackHeaders['Access-Control-Allow-Origin']).toBe('https://artix-mocha.vercel.app');
    });
  });

  describe('Open Redirect Prevention (SEC-03)', () => {
    it('should reject protocol-relative URLs (//evil.com)', () => {
      expect(sanitizeRedirectUrl('//evil.com')).toBe('/dashboard');
      expect(sanitizeRedirectUrl('//phishing.org/login')).toBe('/dashboard');
    });

    it('should reject javascript: scheme URLs', () => {
      expect(sanitizeRedirectUrl('javascript:alert(1)')).toBe('/dashboard');
    });

    it('should allow valid relative paths', () => {
      expect(sanitizeRedirectUrl('/pricing')).toBe('/pricing');
      expect(sanitizeRedirectUrl('/settings')).toBe('/settings');
    });

    it('should handle null, undefined, or empty inputs gracefully', () => {
      expect(sanitizeRedirectUrl(null)).toBe('/dashboard');
      expect(sanitizeRedirectUrl(undefined)).toBe('/dashboard');
      expect(sanitizeRedirectUrl('')).toBe('/dashboard');
    });
  });

  describe('Database Tier Limit Guard Rules (SEC-07)', () => {
    it('should enforce Free tier document limit (10 max)', () => {
      expect(isWithinLimit(9, PLAN_LIMITS.free.documents)).toBe(true);
      expect(isWithinLimit(10, PLAN_LIMITS.free.documents)).toBe(false);
    });

    it('should enforce Free tier project limit (3 max)', () => {
      expect(isWithinLimit(2, PLAN_LIMITS.free.projects)).toBe(true);
      expect(isWithinLimit(3, PLAN_LIMITS.free.projects)).toBe(false);
    });

    it('should enforce Free tier system design limit (3 max)', () => {
      expect(isWithinLimit(2, PLAN_LIMITS.free.systemDesigns)).toBe(true);
      expect(isWithinLimit(3, PLAN_LIMITS.free.systemDesigns)).toBe(false);
    });
  });

  describe('Static Migration Source Audit (SEC-08)', () => {
    // NOTE: This test performs a static filesystem source audit verifying the presence of
    // foreign key constraint definitions in migration files. It does not execute live PostgreSQL
    // runtime constraint enforcement because a local/isolated database test runner is not configured.
    it('should verify foreign key constraints reference auth.users for all user tables in migration source text', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations');
      const files = fs.readdirSync(migrationsDir);
      const allSql = files.map((f: string) => fs.readFileSync(path.join(migrationsDir, f), 'utf-8')).join('\n');

      expect(allSql).toContain('REFERENCES auth.users(id)');
      expect(allSql).toContain('projects_user_id_fkey');
      expect(allSql).toContain('system_designs_user_id_fkey');
      expect(allSql).toContain('ON DELETE CASCADE');
    });

    it('audits 20261020120000_serialize_tier_limits_trigger.sql for per-user advisory lock before count (F-005)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const sql = fs.readFileSync(
        path.join(process.cwd(), 'supabase', 'migrations', '20261020120000_serialize_tier_limits_trigger.sql'),
        'utf-8'
      );

      const fnBodyIdx = sql.indexOf('CREATE OR REPLACE FUNCTION public.check_plan_tier_limit()');
      expect(fnBodyIdx).toBeGreaterThan(-1);
      const fnBody = sql.slice(fnBodyIdx);
      const lockIdx = fnBody.indexOf('PERFORM pg_advisory_xact_lock(');
      const firstCountIdx = fnBody.indexOf('SELECT COUNT(*)');
      expect(lockIdx).toBeGreaterThan(-1);
      expect(firstCountIdx).toBeGreaterThan(lockIdx);
      expect(sql).toContain('SET search_path = public');
      expect(sql).toContain('d.deleted_at IS NULL');
      expect(sql).toContain('sd.deleted_at IS NULL');
      expect(sql).toContain('REVOKE ALL ON FUNCTION public.check_plan_tier_limit() FROM PUBLIC');
    });

    it('prevents concurrent inserts at limit - 1 from exceeding quota when serialized per user (F-005)', async () => {
      // In-memory concurrency model of PostgreSQL READ COMMITTED + per-user xact advisory lock
      const createQuotaStore = (useAdvisoryLock: boolean) => {
        const committedProjects: Array<{ id: string; userId: string }> = [];
        const userLocks = new Map<string, Promise<void>>();

        const withUserXactLock = async <T>(userId: string, fn: () => Promise<T>): Promise<T> => {
          if (!useAdvisoryLock) return fn();
          const prev = userLocks.get(userId) ?? Promise.resolve();
          let release!: () => void;
          const gate = new Promise<void>((res) => {
            release = res;
          });
          const chain = prev.then(() => gate);
          userLocks.set(userId, chain);
          await prev;
          try {
            return await fn();
          } finally {
            release();
            if (userLocks.get(userId) === chain) {
              userLocks.delete(userId);
            }
          }
        };

        const insertProject = (userId: string, projectId: string, limit = 3) =>
          withUserXactLock(userId, async () => {
            // Snapshot count inside transaction before insert commits
            const currentCount = committedProjects.filter((p) => p.userId === userId).length;
            await Promise.resolve(); // Yield so overlapping unlocked transactions race
            if (currentCount >= limit) {
              throw new Error(`Free tier project limit (${limit}) reached.`);
            }
            committedProjects.push({ id: projectId, userId });
          });

        return { committedProjects, insertProject };
      };

      // 1. Unlocked model reproduces F-005: two concurrent inserts at 2/3 both pass -> 4/3
      const unlocked = createQuotaStore(false);
      await unlocked.insertProject('u-free', 'p1');
      await unlocked.insertProject('u-free', 'p2');
      await Promise.all([
        unlocked.insertProject('u-free', 'p3'),
        unlocked.insertProject('u-free', 'p4'),
      ]);
      expect(unlocked.committedProjects.filter((p) => p.userId === 'u-free')).toHaveLength(4);

      // 2. Per-user xact advisory lock enforces exact cap (3/3) while allowing other users concurrently
      const locked = createQuotaStore(true);
      await locked.insertProject('u-free', 'p1');
      await locked.insertProject('u-free', 'p2');

      const outcomes = await Promise.allSettled([
        locked.insertProject('u-free', 'p3'),
        locked.insertProject('u-free', 'p4'),
        locked.insertProject('u-other', 'other-p1'),
      ]);

      const freeSucceeded = outcomes.slice(0, 2).filter((o) => o.status === 'fulfilled');
      const freeRejected = outcomes.slice(0, 2).filter((o) => o.status === 'rejected');
      expect(freeSucceeded).toHaveLength(1);
      expect(freeRejected).toHaveLength(1);
      expect(outcomes[2].status).toBe('fulfilled');
      expect(locked.committedProjects.filter((p) => p.userId === 'u-free')).toHaveLength(3);
    });
  });

  describe('Markdown Preview URI Sanitization & Raw HTML Escaping (Audit SS-08)', () => {
    it('allows only http:, https:, mailto:, and relative references in sanitizeMarkdownUrl', () => {
      expect(sanitizeMarkdownUrl('https://artix-mocha.vercel.app/docs')).toBe(
        'https://artix-mocha.vercel.app/docs'
      );
      expect(sanitizeMarkdownUrl('http://localhost:8080/guide')).toBe('http://localhost:8080/guide');
      expect(sanitizeMarkdownUrl('mailto:security@artix.dev')).toBe('mailto:security@artix.dev');
      expect(sanitizeMarkdownUrl('#section-1')).toBe('#section-1');
      expect(sanitizeMarkdownUrl('/dashboard')).toBe('/dashboard');
      expect(sanitizeMarkdownUrl('./architecture.md')).toBe('./architecture.md');

      expect(sanitizeMarkdownUrl('javascript:alert(1)')).toBe('');
      expect(sanitizeMarkdownUrl('JAVASCRIPT:alert(document.cookie)')).toBe('');
      expect(sanitizeMarkdownUrl('java\n\tscript:alert(1)')).toBe('');
      expect(sanitizeMarkdownUrl('vbscript:msgbox(1)')).toBe('');
      expect(sanitizeMarkdownUrl('data:text/html,<script>alert(1)</script>')).toBe('');
      expect(sanitizeMarkdownUrl('//evil.example/phish')).toBe('');
    });

    it('renders MarkdownPreview without executing raw HTML or leaving javascript: hrefs', () => {
      const maliciousMarkdown = [
        '# Spec',
        '[Bad JS](javascript:alert(1))',
        '[Bad Data](data:text/html,<script>alert(1)</script>)',
        '[Good Link](https://artix-mocha.vercel.app)',
        '<script>window.__artix_xss = true;</script>',
        '<img src="x" onerror="alert(1)" />',
      ].join('\n\n');

      const { container } = render(
        React.createElement(MarkdownPreview, { content: maliciousMarkdown })
      );

      expect(container.querySelector('script')).toBeNull();
      expect(container.querySelector('img')).toBeNull();

      const anchors = Array.from(container.querySelectorAll('a'));
      const badJsAnchor = anchors.find((a) => a.textContent === 'Bad JS');
      const badDataAnchor = anchors.find((a) => a.textContent === 'Bad Data');
      const goodAnchor = anchors.find((a) => a.textContent === 'Good Link');

      expect(badJsAnchor?.getAttribute('href')).toBe('');
      expect(badDataAnchor?.getAttribute('href')).toBe('');
      expect(goodAnchor?.getAttribute('href')).toBe('https://artix-mocha.vercel.app');
    });
  });

  describe('PWA Service-Worker Cache Isolation (Audit F-004)', () => {
    it('prohibits broad supabase.co runtime caching in vite.config.ts', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const viteConfig = fs.readFileSync(path.join(process.cwd(), 'vite.config.ts'), 'utf-8');
      expect(viteConfig).not.toContain('supabase-api-cache');
      expect(viteConfig).not.toMatch(/supabase\\\.co/i);
    });

    it('purges legacy supabase-api-cache entries while preserving static font caches', async () => {
      const store = new Set(['google-fonts-cache', 'gstatic-fonts-cache', 'supabase-api-cache']);
      const mockCacheStorage = {
        keys: async () => Array.from(store),
        delete: async (name: string) => store.delete(name),
      };

      const deleted = await clearSensitiveBrowserCaches(mockCacheStorage);
      expect(deleted).toEqual(['supabase-api-cache']);
      expect(store.has('supabase-api-cache')).toBe(false);
      expect(store.has('google-fonts-cache')).toBe(true);
      expect(store.has('gstatic-fonts-cache')).toBe(true);
    });
  });

  describe('Real-Time Email Validation & Deliverability (Option B)', () => {
    it('should identify disposable email domains correctly', async () => {
      const { validateEmailDeliverability } = await import('@/lib/emailValidation');
      const disposableResult = await validateEmailDeliverability('testuser@mailinator.com');
      expect(disposableResult.valid).toBe(false);
      expect(disposableResult.reason).toBe('disposable');
    });

    it('should detect domain typos and return suggestions', async () => {
      const { validateEmailDeliverability } = await import('@/lib/emailValidation');
      const typoResult = await validateEmailDeliverability('user@gmial.com');
      expect(typoResult.valid).toBe(false);
      expect(typoResult.reason).toBe('typo');
      expect(typoResult.suggestion).toBe('gmail.com');
    });

    it('should allow valid email domains to proceed', async () => {
      const { validateEmailDeliverability } = await import('@/lib/emailValidation');
      const validResult = await validateEmailDeliverability('developer@gmail.com');
      expect(validResult.valid).toBe(true);
    }, 15000);
  });
});
