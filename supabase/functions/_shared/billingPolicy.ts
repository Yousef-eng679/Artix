/**
 * Authoritative Server-Side Billing Plan & Price Policy (Audit F-002)
 *
 * Shared between `create-checkout-session` and `stripe-webhook` Edge Functions,
 * and imported directly by Vitest unit tests (no unguarded top-level `Deno`
 * reference, matching `_shared/cors.ts`).
 */

export type BillingCycle = 'monthly' | 'annual';
export type RecurringInterval = 'month' | 'year';
export type PlanTier = 'free' | 'pro';
export type DbSubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'incomplete';

export type EnvGetter = (key: string) => string | undefined;

export interface AllowedProPriceSpec {
  planTier: 'pro';
  billingCycle: BillingCycle;
  priceId: string;
  interval: RecurringInterval;
  amountUsd: number;
}

export type CheckoutPriceResolution =
  | { ok: true; spec: AllowedProPriceSpec }
  | { ok: false; error: string };

export interface StripeSubscriptionItemLike {
  price?: {
    id?: string | null;
    recurring?: {
      interval?: string | null;
    } | null;
  } | null;
}

export interface StripeSubscriptionLike {
  id?: string;
  status: string;
  customer?: string | { id?: string | null } | null;
  current_period_end?: number | null;
  metadata?: Record<string, string | undefined> | null;
  items?: {
    data?: StripeSubscriptionItemLike[];
  } | null;
}

export interface StripeWebhookEventLike {
  id: string;
  type: string;
  created?: number;
  data: {
    object: Record<string, any>;
  };
}

export interface StripeSubscriptionsClientLike {
  subscriptions: {
    retrieve: (subscriptionId: string) => Promise<StripeSubscriptionLike>;
  };
}

export interface SupabaseAdminRpcLike {
  rpc: (
    fnName: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: any; error: { message: string } | null }>;
}

export interface WebhookReconciliationResult {
  outcome:
    | 'applied'
    | 'duplicate_event'
    | 'ignored_unlinked'
    | 'ignored_event_type'
    | 'stale_event_ignored';
  userId?: string | null;
  planTier?: PlanTier;
  status?: DbSubscriptionStatus;
  reconciliationVersion?: number;
}

export interface SubscriptionEntitlementDecision {
  entitled: boolean;
  planTier: PlanTier;
  dbStatus: DbSubscriptionStatus;
  billingCycle: BillingCycle | null;
  matchedPriceId: string | null;
  reason: string;
}

export const DEFAULT_PRO_MONTHLY_PRICE_ID = 'price_1Tw4QxFhYsZG2pP7gamnWTX6';
export const DEFAULT_PRO_ANNUAL_PRICE_ID = 'price_1Tw4RxFhYsZG2pP7MBbos4He';

function defaultEnvGetter(key: string): string | undefined {
  const denoLike = (
    globalThis as unknown as {
      Deno?: { env?: { get?: (envKey: string) => string | undefined } };
    }
  ).Deno;
  if (typeof denoLike?.env?.get === 'function') {
    return denoLike.env.get(key);
  }
  return undefined;
}

/**
 * Returns the server-owned allowlist of Stripe Price IDs eligible for Artix Pro.
 * Allows deployment-specific overrides via `STRIPE_PRO_MONTHLY_PRICE_ID` and
 * `STRIPE_PRO_ANNUAL_PRICE_ID` secrets while defaulting to canonical Pro prices.
 */
export function getAllowedProPrices(
  envGetter: EnvGetter = defaultEnvGetter
): Record<BillingCycle, AllowedProPriceSpec> {
  const monthlyPriceId =
    envGetter('STRIPE_PRO_MONTHLY_PRICE_ID')?.trim() || DEFAULT_PRO_MONTHLY_PRICE_ID;
  const annualPriceId =
    envGetter('STRIPE_PRO_ANNUAL_PRICE_ID')?.trim() || DEFAULT_PRO_ANNUAL_PRICE_ID;

  return {
    monthly: {
      planTier: 'pro',
      billingCycle: 'monthly',
      priceId: monthlyPriceId,
      interval: 'month',
      amountUsd: 8,
    },
    annual: {
      planTier: 'pro',
      billingCycle: 'annual',
      priceId: annualPriceId,
      interval: 'year',
      amountUsd: 72,
    },
  };
}

/**
 * Resolves and validates a checkout request against the server-owned Pro price
 * allowlist. Rejects arbitrary caller-supplied Stripe Price IDs before any
 * Stripe API call is made.
 */
export function resolveAllowedCheckoutPrice(
  input: { priceId?: unknown; billingCycle?: unknown },
  envGetter: EnvGetter = defaultEnvGetter
): CheckoutPriceResolution {
  const allowlist = getAllowedProPrices(envGetter);
  const rawPriceId = typeof input.priceId === 'string' ? input.priceId.trim() : '';
  const rawCycle = typeof input.billingCycle === 'string' ? input.billingCycle.trim() : '';

  if (input.priceId !== undefined && typeof input.priceId !== 'string') {
    return { ok: false, error: 'Invalid priceId type' };
  }

  if (input.billingCycle !== undefined && typeof input.billingCycle !== 'string') {
    return { ok: false, error: 'Invalid billingCycle type' };
  }

  let byCycle: AllowedProPriceSpec | null = null;
  if (rawCycle.length > 0) {
    if (rawCycle !== 'monthly' && rawCycle !== 'annual') {
      return { ok: false, error: `Unsupported billingCycle: ${rawCycle}` };
    }
    byCycle = allowlist[rawCycle];
  }

  let byPriceId: AllowedProPriceSpec | null = null;
  if (rawPriceId.length > 0) {
    byPriceId =
      Object.values(allowlist).find((spec) => spec.priceId === rawPriceId) ?? null;
    if (!byPriceId) {
      return { ok: false, error: 'Unauthorized or unrecognized Stripe priceId' };
    }
  }

  if (!byPriceId && !byCycle) {
    return { ok: false, error: 'Either a valid priceId or billingCycle is required' };
  }

  if (byPriceId && byCycle && byPriceId.priceId !== byCycle.priceId) {
    return {
      ok: false,
      error: 'Provided priceId does not match requested billingCycle',
    };
  }

  return { ok: true, spec: (byPriceId ?? byCycle)! };
}

/**
 * Maps all Stripe `Subscription.Status` values onto PostgreSQL's constrained
 * `public.subscriptions.status` domain (`active | past_due | canceled | incomplete`).
 */
export function mapStripeStatusToDbStatus(stripeStatus: string): DbSubscriptionStatus {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
    case 'paused':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    case 'incomplete':
    default:
      return 'incomplete';
  }
}

/**
 * Verifies a Stripe Subscription object retrieved by `stripe-webhook` before
 * granting `plan_tier = 'pro'`. Fails closed to `'free'` if the purchased price
 * is not in the server allowlist, the recurring interval mismatches, or the
 * subscription status is not actively entitled.
 */
export function validateSubscriptionEntitlement(
  subscription: StripeSubscriptionLike,
  envGetter: EnvGetter = defaultEnvGetter
): SubscriptionEntitlementDecision {
  const dbStatus = mapStripeStatusToDbStatus(subscription?.status ?? '');
  const items = subscription?.items?.data ?? [];

  if (items.length === 0) {
    return {
      entitled: false,
      planTier: 'free',
      dbStatus,
      billingCycle: null,
      matchedPriceId: null,
      reason: 'Subscription has no line items',
    };
  }

  const allowlist = getAllowedProPrices(envGetter);
  const primaryItem = items[0];
  const priceId = primaryItem?.price?.id?.trim() ?? '';

  const matchedSpec =
    Object.values(allowlist).find((spec) => spec.priceId === priceId) ?? null;

  if (!matchedSpec) {
    return {
      entitled: false,
      planTier: 'free',
      dbStatus,
      billingCycle: null,
      matchedPriceId: null,
      reason: `Unapproved Stripe priceId '${priceId || 'missing'}'`,
    };
  }

  const actualInterval = primaryItem?.price?.recurring?.interval ?? null;
  if (actualInterval !== null && actualInterval !== matchedSpec.interval) {
    return {
      entitled: false,
      planTier: 'free',
      dbStatus,
      billingCycle: null,
      matchedPriceId: matchedSpec.priceId,
      reason: `Recurring interval '${actualInterval}' does not match expected '${matchedSpec.interval}'`,
    };
  }

  const isEntitledStatus =
    subscription.status === 'active' || subscription.status === 'trialing';

  if (!isEntitledStatus) {
    return {
      entitled: false,
      planTier: 'free',
      dbStatus,
      billingCycle: matchedSpec.billingCycle,
      matchedPriceId: matchedSpec.priceId,
      reason: `Subscription status '${subscription.status}' is not entitled to Pro`,
    };
  }

  return {
    entitled: true,
    planTier: 'pro',
    dbStatus,
    billingCycle: matchedSpec.billingCycle,
    matchedPriceId: matchedSpec.priceId,
    reason: 'Verified Pro subscription price and active status',
  };
}

function extractId(ref: unknown): string | null {
  if (typeof ref === 'string' && ref.trim().length > 0) {
    return ref.trim();
  }
  if (ref && typeof ref === 'object' && typeof (ref as { id?: unknown }).id === 'string') {
    const id = ((ref as { id: string }).id || '').trim();
    return id.length > 0 ? id : null;
  }
  return null;
}

/**
 * Extracts `(subscriptionId, customerId, fallbackUserId)` from supported Stripe
 * webhook events so `reconcileStripeWebhookEvent` can always retrieve the
 * authoritative live subscription from Stripe rather than trusting out-of-order
 * event snapshots (`B-01`, `B-02`).
 */
export function extractSubscriptionContextFromWebhookEvent(event: StripeWebhookEventLike): {
  handled: boolean;
  subscriptionId: string | null;
  customerId: string | null;
  fallbackUserId: string | null;
} {
  const obj = event?.data?.object ?? {};

  switch (event.type) {
    case 'checkout.session.completed': {
      if (obj.mode !== 'subscription') {
        return {
          handled: false,
          subscriptionId: null,
          customerId: extractId(obj.customer),
          fallbackUserId: null,
        };
      }
      return {
        handled: true,
        subscriptionId: extractId(obj.subscription),
        customerId: extractId(obj.customer),
        fallbackUserId:
          (typeof obj.metadata?.supabase_user_id === 'string' &&
            obj.metadata.supabase_user_id.trim()) ||
          (typeof obj.client_reference_id === 'string' && obj.client_reference_id.trim()) ||
          null,
      };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      return {
        handled: true,
        subscriptionId: extractId(obj.id),
        customerId: extractId(obj.customer),
        fallbackUserId:
          (typeof obj.metadata?.supabase_user_id === 'string' &&
            obj.metadata.supabase_user_id.trim()) ||
          null,
      };
    }

    case 'invoice.paid':
    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed': {
      const subId =
        extractId(obj.subscription) ??
        extractId(obj.parent?.subscription_details?.subscription);
      return {
        handled: Boolean(subId),
        subscriptionId: subId,
        customerId: extractId(obj.customer),
        fallbackUserId:
          (typeof obj.subscription_details?.metadata?.supabase_user_id === 'string' &&
            obj.subscription_details.metadata.supabase_user_id.trim()) ||
          null,
      };
    }

    default:
      return {
        handled: false,
        subscriptionId: null,
        customerId: extractId(obj.customer),
        fallbackUserId: null,
      };
  }
}

/**
 * Reconciles a verified Stripe webhook event atomically:
 *   1. Fetches the authoritative live `Subscription` from Stripe (`stripe.subscriptions.retrieve`)
 *      so delayed/out-of-order events (`payment_failed` arriving after `paid`, or stale `updated`
 *      arriving after `deleted`) converge to the real current state (`B-01`).
 *   2. Evaluates `validateSubscriptionEntitlement` under strict fail-closed policy (`B-02` / Decision A1:
 *      `past_due` downgrades `plan_tier` to `'free'` until `invoice.paid` restores `'active'`).
 *   3. Executes `public.reconcile_stripe_subscription` so advisory-locked deduplication,
 *      `public.subscriptions` upsert, and `public.stripe_events` ledger write commit or
 *      roll back in ONE PostgreSQL transaction.
 */
export async function reconcileStripeWebhookEvent(params: {
  event: StripeWebhookEventLike;
  stripe: StripeSubscriptionsClientLike;
  supabaseAdmin: SupabaseAdminRpcLike;
  envGetter?: EnvGetter;
}): Promise<WebhookReconciliationResult> {
  const { event, stripe, supabaseAdmin, envGetter = defaultEnvGetter } = params;
  const ctx = extractSubscriptionContextFromWebhookEvent(event);

  if (!ctx.handled || !ctx.subscriptionId) {
    return { outcome: 'ignored_event_type' };
  }

  const liveSubscription = await stripe.subscriptions.retrieve(ctx.subscriptionId);
  const decision = validateSubscriptionEntitlement(liveSubscription, envGetter);

  const userId =
    (typeof liveSubscription.metadata?.supabase_user_id === 'string' &&
      liveSubscription.metadata.supabase_user_id.trim()) ||
    ctx.fallbackUserId ||
    null;

  const customerId = extractId(liveSubscription.customer) ?? ctx.customerId ?? null;
  const currentPeriodEnd =
    typeof liveSubscription.current_period_end === 'number' &&
    Number.isFinite(liveSubscription.current_period_end)
      ? new Date(liveSubscription.current_period_end * 1000).toISOString()
      : null;

  const { data, error } = await supabaseAdmin.rpc('reconcile_stripe_subscription', {
    p_stripe_event_id: event.id,
    p_event_type: event.type,
    p_event_created:
      typeof event.created === 'number' ? event.created : Math.floor(Date.now() / 1000),
    p_user_id: userId,
    p_stripe_customer_id: customerId,
    p_stripe_subscription_id: ctx.subscriptionId,
    p_plan_tier: decision.planTier,
    p_status: decision.dbStatus,
    p_billing_cycle: decision.billingCycle,
    p_current_period_end: currentPeriodEnd,
    p_is_live_snapshot: true,
  });

  if (error) {
    throw new Error(
      `Failed to reconcile Stripe subscription (${ctx.subscriptionId}) for event ${event.id}: ${error.message}`,
    );
  }

  return {
    outcome: (data?.outcome ?? 'applied') as WebhookReconciliationResult['outcome'],
    userId: data?.user_id ?? userId,
    planTier: data?.plan_tier ?? decision.planTier,
    status: data?.status ?? decision.dbStatus,
    reconciliationVersion:
      typeof data?.reconciliation_version === 'number'
        ? data.reconciliation_version
        : undefined,
  };
}
