export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

const ALLOWED_ORIGINS = [
  'https://artix-mocha.vercel.app',
  'http://localhost:8080',
  'http://localhost:5173',
  'http://localhost:8081',
];

/**
 * Single source of truth for "is this origin/URL allowed?"
 * Used by both getCorsHeaders (for CORS) and Edge Functions (for redirect validation).
 * Matches exact origins from the allowlist, plus Artix Vercel preview deployments
 * (hostname starts with 'artix-mocha-' and ends with '.vercel.app').
 * Does NOT trust arbitrary *.vercel.app domains — only the Artix project's deployments.
 */
export function isOriginAllowed(candidateUrl: string): boolean {
  try {
    const parsed = new URL(candidateUrl);
    const origin = parsed.origin;
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    if (parsed.hostname.endsWith('.vercel.app') && parsed.hostname.startsWith('artix-mocha-')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function getCorsHeaders(req?: Request): Record<string, string> {
  const reqOrigin = req?.headers.get('origin') || '';
  const allowOrigin = isOriginAllowed(reqOrigin) ? reqOrigin : ALLOWED_ORIGINS[0];
  return {
    ...corsHeaders,
    'Access-Control-Allow-Origin': allowOrigin,
  };
}
