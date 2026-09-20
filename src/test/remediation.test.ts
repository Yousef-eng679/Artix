import { describe, it, expect, beforeEach } from 'vitest';
import { isOriginAllowed, getCorsHeaders, corsHeaders } from '../../supabase/functions/_shared/cors';
import {
  saveSettings,
  loadSettings,
  enableEncryption,
  disableEncryption,
  isEncrypted,
  isUnlocked,
  lock,
} from '../lib/ai/storage';

describe('Remediation Plan Verification Suite', () => {
  beforeEach(() => {
    localStorage.clear();
    lock();
  });

  describe('2.1 Billing Portal Fix (return_url payload & origin validation)', () => {
    it('should validate return_url origin for billing portal sessions', () => {
      const validOrigin = 'http://localhost:8080';
      const portalPayload = { return_url: `${validOrigin}/settings` };

      expect(portalPayload.return_url).toMatch(/\/settings$/);
      expect(isOriginAllowed(portalPayload.return_url)).toBe(true);
    });

    it('should reject untrusted return_url origins', () => {
      const maliciousReturnUrl = 'https://phishing-portal.com/steal-session';
      expect(isOriginAllowed(maliciousReturnUrl)).toBe(false);
    });
  });

  describe('2.2 Mandatory AI Key Encryption (SEC-06)', () => {
    it('should enforce encrypted storage and prevent plaintext key leakage', async () => {
      const rawKey = 'sk-prod-super-secret-key-12345';
      await saveSettings({
        primary: { provider: 'openai', model: 'gpt-4o', apiKey: rawKey },
      });

      // Enable encryption
      await enableEncryption('strong-passphrase-2026');
      expect(isEncrypted()).toBe(true);
      expect(isUnlocked()).toBe(true);

      // Verify that localStorage contains the encrypted blob and never the raw key
      const storedEnc = localStorage.getItem('artix.ai.settings.enc.v1');
      expect(storedEnc).not.toBeNull();
      expect(storedEnc).not.toContain(rawKey);

      // Raw settings key should be empty / null
      const storedPlain = localStorage.getItem('artix.ai.settings.v1');
      expect(storedPlain).toBeNull();
    });

    it('should lock memory cache and clear decrypted keys on lock()', async () => {
      await saveSettings({
        primary: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-secret' },
      });
      await enableEncryption('pass-123');

      expect(isUnlocked()).toBe(true);
      expect(loadSettings().primary?.apiKey).toBe('sk-secret');

      lock();

      expect(isUnlocked()).toBe(false);
      expect(loadSettings()).toEqual({}); // Locked state yields empty settings
    });
  });

  describe('2.3 Dynamic CORS Hardening (SEC-05)', () => {
    it('should include required security headers in all CORS responses', () => {
      const req = new Request('http://localhost:8080', {
        headers: { origin: 'http://localhost:8080' },
      });
      const headers = getCorsHeaders(req);

      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['X-Frame-Options']).toBe('DENY');
      expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:8080');
    });

    it('should default to primary allowed origin when request origin is missing or untrusted', () => {
      const untrustedReq = new Request('http://localhost:8080', {
        headers: { origin: 'https://malicious-site.example' },
      });
      const headers = getCorsHeaders(untrustedReq);

      expect(headers['Access-Control-Allow-Origin']).toBe('https://artix-mocha.vercel.app');
    });
  });
});
