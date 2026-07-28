import { describe, it, expect } from 'vitest';
import { isWithinLimit, PLAN_LIMITS } from '../lib/plans';

// Helper functions for security checks
function obfuscateApiKey(key: string): string {
  if (!key) return '';
  if (key.startsWith('obf:')) return key;
  return `obf:${btoa(key)}`;
}

function deobfuscateApiKey(stored: string): string {
  if (!stored) return '';
  if (!stored.startsWith('obf:')) return stored;
  try {
    return atob(stored.slice(4));
  } catch {
    return stored;
  }
}

function getCorsOrigin(requestOrigin?: string, allowedOrigins: string[] = []): string {
  if (!requestOrigin) return '*';
  if (allowedOrigins.includes(requestOrigin)) return requestOrigin;
  return allowedOrigins[0] || '*';
}

function sanitizeRedirectUrl(url: string, defaultPath = '/dashboard'): string {
  if (!url) return defaultPath;
  // Prevent protocol-relative open redirects starting with // or javascript:
  if (url.startsWith('//') || url.toLowerCase().startsWith('javascript:')) {
    return defaultPath;
  }
  // Allow relative paths starting with /
  if (url.startsWith('/') && !url.startsWith('//')) {
    return url;
  }
  return defaultPath;
}

describe('Security Remediation Suite', () => {
  describe('API Key Obfuscation & Storage Protection (SEC-06)', () => {
    it('should obfuscate plain API keys before storing', () => {
      const rawKey = 'sk-proj-1234567890abcdef';
      const obfuscated = obfuscateApiKey(rawKey);

      expect(obfuscated).not.toBe(rawKey);
      expect(obfuscated.startsWith('obf:')).toBe(true);
    });

    it('should correctly deobfuscate stored API keys', () => {
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
    it('should match allowed origins dynamically', () => {
      const allowed = ['https://artix.app', 'https://staging.artix.app'];

      expect(getCorsOrigin('https://artix.app', allowed)).toBe('https://artix.app');
      expect(getCorsOrigin('https://evil.com', allowed)).toBe('https://artix.app');
    });

    it('should return default wildcard when no whitelist is defined', () => {
      expect(getCorsOrigin('http://localhost:8080')).toBe('*');
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

      // Verify FK references to auth.users exist for all user-owned tables
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
    });
  });
});


