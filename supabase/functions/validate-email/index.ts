import { corsHeaders, getCorsHeaders } from '../_shared/cors.ts';

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  'https://artix-mocha.vercel.app',
  'http://localhost:8080',
  'http://localhost:8081',
];

// Common disposable/fake email domains
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'tempmail.com',
  'yopmail.com',
  'guerrillamail.com',
  '10minutemail.com',
  'fake.com',
  'example.com',
  'disposable.com',
  'trashmail.com',
  'throwawaymail.com',
  'fakeinbox.com',
  'sharklasers.com',
  'getnada.com',
  'temp-mail.org',
]);

// Explicit typo map for common domain misspellings
const TYPO_MAP: Record<string, string> = {
  'gmial.com': 'gmail.com',
  'gamil.com': 'gmail.com',
  'gmaill.com': 'gmail.com',
  'hotmial.com': 'hotmail.com',
  'hotamil.com': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'outlook.co': 'outlook.com',
  'yaho.com': 'yahoo.com',
  'yahooo.com': 'yahoo.com',
};

// RFC 5322-ish email regex check
function isValidEmailSyntax(email: string): boolean {
  if (!email || email.length > 254) return false;
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return emailRegex.test(email);
}

// Perform DNS MX record lookup via Cloudflare DNS-over-HTTPS
async function checkDomainMxRecord(domain: string): Promise<boolean> {
  try {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/dns-json',
      },
    });

    if (!response.ok) {
      // Fallback to Google DoH if Cloudflare fails
      const googleUrl = `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`;
      const googleRes = await fetch(googleUrl);
      if (!googleRes.ok) return true; // Graceful fallback on DNS API error
      const googleData = await googleRes.json();
      return googleData.Status === 0 && Array.isArray(googleData.Answer) && googleData.Answer.length > 0;
    }

    const data = await response.json();
    // Status 0 means NOERROR. Status 3 means NXDOMAIN (Domain does not exist).
    if (data.Status === 3) return false;
    
    // Check if MX records (type 15) or A records (fallback) exist
    if (data.Status === 0 && Array.isArray(data.Answer) && data.Answer.length > 0) {
      return true;
    }
    return false;
  } catch (err) {
    console.warn('DNS MX check failed, falling back to valid:', err);
    return true; // Graceful fallback on network error
  }
}

Deno.serve(async (req) => {
  const headers = getCorsHeaders(req, ALLOWED_ORIGINS);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers });
  }

  try {
    const { email } = await req.json();
    const trimmedEmail = (email || '').trim().toLowerCase();

    if (!trimmedEmail || !isValidEmailSyntax(trimmedEmail)) {
      return new Response(
        JSON.stringify({ valid: false, reason: 'syntax_invalid' }),
        { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } }
      );
    }

    const [, domain] = trimmedEmail.split('@');
    if (!domain) {
      return new Response(
        JSON.stringify({ valid: false, reason: 'syntax_invalid' }),
        { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } }
      );
    }

    // 1. Check disposable domain blacklist
    if (DISPOSABLE_DOMAINS.has(domain)) {
      return new Response(
        JSON.stringify({
          valid: false,
          reason: 'disposable',
          message: 'Disposable email addresses are not supported. Please use a permanent email or sign in with Google.',
        }),
        { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } }
      );
    }

    // 2. Check explicit domain typo map
    if (TYPO_MAP[domain]) {
      const suggestionDomain = TYPO_MAP[domain];
      const suggestedEmail = `${trimmedEmail.split('@')[0]}@${suggestionDomain}`;
      return new Response(
        JSON.stringify({
          valid: false,
          reason: 'typo',
          suggestion: suggestionDomain,
          suggestedEmail,
          message: `Did you mean ${suggestionDomain}?`,
        }),
        { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } }
      );
    }

    // 3. Perform DNS MX record lookup
    const hasMxRecord = await checkDomainMxRecord(domain);
    if (!hasMxRecord) {
      return new Response(
        JSON.stringify({
          valid: false,
          reason: 'mx_record_missing',
          message: `The domain "@${domain}" cannot receive emails because it has no active mail servers. Please check for typos.`,
        }),
        { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ valid: true }),
      { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ valid: false, error: (err as Error).message }),
      { status: 500, headers: { ...headers, 'Content-Type': 'application/json' } }
    );
  }
});
