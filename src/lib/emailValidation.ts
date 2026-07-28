import { supabase } from '@/integrations/supabase/client';

export interface EmailValidationResult {
  valid: boolean;
  reason?: 'syntax_invalid' | 'disposable' | 'typo' | 'mx_record_missing' | 'unknown';
  suggestion?: string;
  suggestedEmail?: string;
  message?: string;
}

const OFFLINE_DISPOSABLE_DOMAINS = new Set([
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
]);

const OFFLINE_TYPO_MAP: Record<string, string> = {
  'gmial.com': 'gmail.com',
  'gamil.com': 'gmail.com',
  'hotmial.com': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'yaho.com': 'yahoo.com',
};

/**
 * Validates an email address deliverability before manual signup.
 * Calls the `validate-email` Supabase Edge Function for server-side DNS MX record & disposable check.
 * Includes a graceful local fallback if the Edge Function is unreachable.
 */
export async function validateEmailDeliverability(email: string): Promise<EmailValidationResult> {
  const trimmed = email.trim().toLowerCase();
  const domain = trimmed.split('@')[1] || '';

  // Quick client-side pre-check for offline disposable & typos
  if (OFFLINE_DISPOSABLE_DOMAINS.has(domain)) {
    return {
      valid: false,
      reason: 'disposable',
      message: 'Disposable email addresses are not supported. Please use a permanent email or sign in with Google.',
    };
  }

  if (OFFLINE_TYPO_MAP[domain]) {
    const suggestion = OFFLINE_TYPO_MAP[domain];
    return {
      valid: false,
      reason: 'typo',
      suggestion,
      suggestedEmail: `${trimmed.split('@')[0]}@${suggestion}`,
      message: `Did you mean ${suggestion}?`,
    };
  }

  try {
    const { data, error } = await supabase.functions.invoke('validate-email', {
      body: { email: trimmed },
    });

    if (error || !data) {
      console.warn('Edge Function validate-email unavailable, proceeding with client fallback:', error);
      return { valid: true };
    }

    return data as EmailValidationResult;
  } catch (err) {
    console.warn('Network error during email validation, falling back to valid:', err);
    return { valid: true };
  }
}
