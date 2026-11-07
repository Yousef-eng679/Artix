/**
 * plans.ts
 * ────────
 * Central configuration for Artix subscription plan limits.
 *
 * Free: 3 projects, 10 docs, 3 designs, 5 AI generations/month
 * Pro:  100 projects (abuse cap), unlimited docs/designs/AI
 *
 * `null` means unlimited — the usage hook skips the check.
 */

export type PlanTier = 'free' | 'pro';

export interface PlanLimits {
  projects: number | null;
  documents: number | null;
  systemDesigns: number | null;
  aiGenerationsPerMonth: number | null;
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    projects: 3,
    documents: 10,
    systemDesigns: 3,
    aiGenerationsPerMonth: 5,
  },
  pro: {
    projects: 100,          // Reasonable cap to prevent abuse
    documents: null,        // Unlimited
    systemDesigns: null,    // Unlimited
    aiGenerationsPerMonth: null, // Unlimited
  },
};

export const PLAN_PRICES = {
  monthly: {
    priceId: 'price_1Tw4QxFhYsZG2pP7gamnWTX6',
    amount: 8,
    label: '$8/mo',
  },
  annual: {
    priceId: 'price_1Tw4RxFhYsZG2pP7MBbos4He',
    amount: 72,
    label: '$72/yr',
    savings: '2 months free',
  },
} as const;

/**
 * Grace period in days after a failed payment before downgrading.
 * Strict fail-closed policy (Decision A1 / B-02): `past_due` downgrades Pro immediately
 * until `invoice.paid` restores `active` status.
 */
export const GRACE_PERIOD_DAYS = 0;

/**
 * Check if a usage count is within the plan limit.
 * Returns true if the user can create more.
 */
export function isWithinLimit(used: number, limit: number | null): boolean {
  if (limit === null) return true; // unlimited
  return used < limit;
}
