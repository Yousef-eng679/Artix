import { describe, it, expect } from 'vitest';
import { isWithinLimit, PLAN_LIMITS } from '../lib/plans';
import { obfuscateApiKey, deobfuscateApiKey } from '../lib/ai/storage';
import { sanitizeRedirectUrl } from '../lib/utils';
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

  describe('Database Foreign Key Constraint Audit (SEC-08)', () => {
    it('should verify foreign key constraints reference auth.users for all user tables', async () => {
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
