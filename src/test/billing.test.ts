import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { PLAN_LIMITS, PLAN_PRICES, GRACE_PERIOD_DAYS, isWithinLimit } from '../lib/plans';
import {
  DEFAULT_PRO_ANNUAL_PRICE_ID,
  DEFAULT_PRO_MONTHLY_PRICE_ID,
  mapStripeStatusToDbStatus,
  resolveAllowedCheckoutPrice,
  validateSubscriptionEntitlement,
} from '../../supabase/functions/_shared/billingPolicy';

describe('Stripe Billing & Plan Limits Configuration', () => {
  it('should define correct limits for Free tier', () => {
    expect(PLAN_LIMITS.free.projects).toBe(3);
    expect(PLAN_LIMITS.free.documents).toBe(10);
    expect(PLAN_LIMITS.free.systemDesigns).toBe(3);
    expect(PLAN_LIMITS.free.aiGenerationsPerMonth).toBe(5);
  });

  it('should define unlimited (null) limits for Pro tier (with abuse cap on projects)', () => {
    expect(PLAN_LIMITS.pro.projects).toBe(100);
    expect(PLAN_LIMITS.pro.documents).toBeNull();
    expect(PLAN_LIMITS.pro.systemDesigns).toBeNull();
    expect(PLAN_LIMITS.pro.aiGenerationsPerMonth).toBeNull();
  });

  it('should correctly evaluate isWithinLimit for numeric limits', () => {
    // Free document limit is 10
    expect(isWithinLimit(0, 10)).toBe(true);
    expect(isWithinLimit(9, 10)).toBe(true);
    expect(isWithinLimit(10, 10)).toBe(false);
    expect(isWithinLimit(15, 10)).toBe(false);
  });

  it('should always return true for unlimited (null) limits', () => {
    expect(isWithinLimit(0, null)).toBe(true);
    expect(isWithinLimit(999, null)).toBe(true);
    expect(isWithinLimit(100000, null)).toBe(true);
  });

  it('should configure correct Stripe price IDs and details', () => {
    expect(PLAN_PRICES.monthly.priceId).toBe('price_1Tw4QxFhYsZG2pP7gamnWTX6');
    expect(PLAN_PRICES.monthly.amount).toBe(8);

    expect(PLAN_PRICES.annual.priceId).toBe('price_1Tw4RxFhYsZG2pP7MBbos4He');
    expect(PLAN_PRICES.annual.amount).toBe(72);
  });

  it('should specify a 7-day grace period for past due subscriptions', () => {
    expect(GRACE_PERIOD_DAYS).toBe(7);
  });

  describe('Audit F-002: Server-Side Stripe Price Allowlist & Webhook Entitlement Policy', () => {
    it('keeps client PLAN_PRICES aligned with default server allowlist IDs', () => {
      expect(PLAN_PRICES.monthly.priceId).toBe(DEFAULT_PRO_MONTHLY_PRICE_ID);
      expect(PLAN_PRICES.annual.priceId).toBe(DEFAULT_PRO_ANNUAL_PRICE_ID);
    });

    it('accepts canonical monthly and annual Pro checkout prices and matching billingCycles', () => {
      const monthly = resolveAllowedCheckoutPrice({
        priceId: PLAN_PRICES.monthly.priceId,
        billingCycle: 'monthly',
      });
      expect(monthly).toEqual({
        ok: true,
        spec: {
          planTier: 'pro',
          billingCycle: 'monthly',
          priceId: PLAN_PRICES.monthly.priceId,
          interval: 'month',
          amountUsd: 8,
        },
      });

      const annual = resolveAllowedCheckoutPrice({
        priceId: PLAN_PRICES.annual.priceId,
        billingCycle: 'annual',
      });
      expect(annual).toEqual({
        ok: true,
        spec: {
          planTier: 'pro',
          billingCycle: 'annual',
          priceId: PLAN_PRICES.annual.priceId,
          interval: 'year',
          amountUsd: 72,
        },
      });
    });

    it('rejects caller-tampered, empty, or mismatched Stripe priceIds at checkout', () => {
      expect(
        resolveAllowedCheckoutPrice({ priceId: 'price_free_tier_spoof_000' })
      ).toEqual({
        ok: false,
        error: 'Unauthorized or unrecognized Stripe priceId',
      });

      expect(
        resolveAllowedCheckoutPrice({
          priceId: PLAN_PRICES.monthly.priceId,
          billingCycle: 'annual',
        })
      ).toEqual({
        ok: false,
        error: 'Provided priceId does not match requested billingCycle',
      });

      expect(resolveAllowedCheckoutPrice({})).toEqual({
        ok: false,
        error: 'Either a valid priceId or billingCycle is required',
      });
    });

    it('honors server environment overrides for deployment-specific Stripe Price IDs', () => {
      const env = (key: string) => {
        if (key === 'STRIPE_PRO_MONTHLY_PRICE_ID') return 'price_live_monthly_999';
        if (key === 'STRIPE_PRO_ANNUAL_PRICE_ID') return 'price_live_annual_999';
        return undefined;
      };

      expect(
        resolveAllowedCheckoutPrice({ priceId: PLAN_PRICES.monthly.priceId }, env).ok
      ).toBe(false);

      const liveMonthly = resolveAllowedCheckoutPrice(
        { priceId: 'price_live_monthly_999' },
        env
      );
      expect(liveMonthly.ok).toBe(true);
      if (liveMonthly.ok) {
        expect(liveMonthly.spec.billingCycle).toBe('monthly');
      }
    });

    it('maps all Stripe subscription statuses onto PostgreSQL CHECK-valid values (R7)', () => {
      const allowedDbStatuses = new Set(['active', 'past_due', 'canceled', 'incomplete']);
      const samples: Array<[string, string]> = [
        ['active', 'active'],
        ['trialing', 'active'],
        ['past_due', 'past_due'],
        ['unpaid', 'past_due'],
        ['paused', 'past_due'],
        ['canceled', 'canceled'],
        ['incomplete_expired', 'canceled'],
        ['incomplete', 'incomplete'],
        ['unexpected_future_status', 'incomplete'],
      ];

      for (const [stripeStatus, expectedDbStatus] of samples) {
        const mapped = mapStripeStatusToDbStatus(stripeStatus);
        expect(allowedDbStatuses.has(mapped)).toBe(true);
        expect(mapped).toBe(expectedDbStatus);
      }
    });

    it('grants Pro entitlement in webhook ONLY when priceId, interval, and status are all valid', () => {
      // Valid active monthly Pro
      const validMonthly = validateSubscriptionEntitlement({
        id: 'sub_1',
        status: 'active',
        items: {
          data: [
            {
              price: {
                id: PLAN_PRICES.monthly.priceId,
                recurring: { interval: 'month' },
              },
            },
          ],
        },
      });
      expect(validMonthly).toMatchObject({
        entitled: true,
        planTier: 'pro',
        dbStatus: 'active',
        billingCycle: 'monthly',
      });

      // Valid trialing annual Pro
      const validTrialingAnnual = validateSubscriptionEntitlement({
        id: 'sub_2',
        status: 'trialing',
        items: {
          data: [
            {
              price: {
                id: PLAN_PRICES.annual.priceId,
                recurring: { interval: 'year' },
              },
            },
          ],
        },
      });
      expect(validTrialingAnnual).toMatchObject({
        entitled: true,
        planTier: 'pro',
        dbStatus: 'active',
        billingCycle: 'annual',
      });

      // Attack: active subscription on an unauthorized cheap/test priceId -> denied ('free')
      const unapprovedPrice = validateSubscriptionEntitlement({
        id: 'sub_spoof',
        status: 'active',
        items: {
          data: [
            {
              price: {
                id: 'price_1CentTestPrice',
                recurring: { interval: 'month' },
              },
            },
          ],
        },
      });
      expect(unapprovedPrice.entitled).toBe(false);
      expect(unapprovedPrice.planTier).toBe('free');

      // Interval mismatch -> denied ('free')
      const mismatchedInterval = validateSubscriptionEntitlement({
        id: 'sub_bad_interval',
        status: 'active',
        items: {
          data: [
            {
              price: {
                id: PLAN_PRICES.annual.priceId,
                recurring: { interval: 'month' },
              },
            },
          ],
        },
      });
      expect(mismatchedInterval.entitled).toBe(false);
      expect(mismatchedInterval.planTier).toBe('free');

      // Non-entitled statuses (unpaid / incomplete / canceled) -> denied ('free') with safe DB status
      const unpaidSub = validateSubscriptionEntitlement({
        id: 'sub_unpaid',
        status: 'unpaid',
        items: {
          data: [
            {
              price: {
                id: PLAN_PRICES.monthly.priceId,
                recurring: { interval: 'month' },
              },
            },
          ],
        },
      });
      expect(unpaidSub.entitled).toBe(false);
      expect(unpaidSub.planTier).toBe('free');
      expect(unpaidSub.dbStatus).toBe('past_due');
    });

    it('verifies Edge Functions wire server-side billingPolicy and conflict-safe webhook deduplication', () => {
      const checkoutFn = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/functions/create-checkout-session/index.ts'),
        'utf8'
      );
      expect(checkoutFn).toContain('resolveAllowedCheckoutPrice');
      expect(checkoutFn).toContain('line_items: [{ price: approvedPlan.priceId, quantity: 1 }]');
      expect(checkoutFn).not.toContain('line_items: [{ price: priceId');

      const webhookFn = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/functions/stripe-webhook/index.ts'),
        'utf8'
      );
      expect(webhookFn).toContain('validateSubscriptionEntitlement');
      expect(webhookFn).toContain("onConflict: 'stripe_event_id', ignoreDuplicates: true");
      expect(webhookFn).toContain('status: 500');
    });
  });
});
