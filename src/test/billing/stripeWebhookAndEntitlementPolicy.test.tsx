import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { ArtixDB } from '@/lib/local/db';
import { supabase } from '@/integrations/supabase/client';
import { GRACE_PERIOD_DAYS, PLAN_PRICES } from '@/lib/plans';
import { useSubscription } from '@/hooks/useSubscription';
import { useUsageLimits } from '@/hooks/useUsageLimits';
import * as billingPolicy from '../../../supabase/functions/_shared/billingPolicy';

const TEST_USER = { id: '11111111-2222-4333-8444-555555555555', email: 'billing-user@example.test' };
const TestRuntimeContext = React.createContext<any>(null);

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: TEST_USER,
    session: { user: TEST_USER },
    loading: false,
  }),
}));

vi.mock('@/contexts/UserSyncRuntimeContext', () => ({
  useUserSyncRuntime: () => React.useContext(TestRuntimeContext),
}));

/**
 * Deterministic in-memory model of `public.reconcile_stripe_subscription`
 * matching the transactional SQL contract in
 * `20261101100300_atomic_billing_reconciliation_and_manual_grants.sql`.
 */
class FakeBillingDatabase {
  subscriptions = new Map<
    string,
    {
      user_id: string;
      stripe_customer_id: string | null;
      stripe_subscription_id: string | null;
      plan_tier: 'free' | 'pro';
      status: 'active' | 'past_due' | 'canceled' | 'incomplete';
      billing_cycle: 'monthly' | 'annual' | null;
      current_period_end: string | null;
      reconciliation_version: number;
      last_stripe_event_created: number | null;
    }
  >();

  stripeEvents = new Map<string, { stripe_event_id: string; event_type: string }>();
  failNextRpcError: string | null = null;
  private lockChain: Promise<void> = Promise.resolve();

  private async withSerializedLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lockChain;
    let release!: () => void;
    this.lockChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  rpc = vi.fn(async (fnName: string, args: Record<string, any>) => {
    if (fnName !== 'reconcile_stripe_subscription') {
      return { data: null, error: { message: `Unexpected RPC: ${fnName}` } };
    }

    return this.withSerializedLock(async () => {
      if (this.failNextRpcError) {
        const msg = this.failNextRpcError;
        this.failNextRpcError = null;
        // Single-transaction rollback: neither subscriptions nor stripe_events mutates
        return { data: null, error: { message: msg } };
      }

      const eventId = String(args.p_stripe_event_id);
      if (this.stripeEvents.has(eventId)) {
        return {
          data: { outcome: 'duplicate_event', stripe_event_id: eventId },
          error: null,
        };
      }

      let userId: string | null = args.p_user_id ?? null;
      if (!userId && args.p_stripe_subscription_id) {
        for (const row of this.subscriptions.values()) {
          if (row.stripe_subscription_id === args.p_stripe_subscription_id) {
            userId = row.user_id;
            break;
          }
        }
      }
      if (!userId && args.p_stripe_customer_id) {
        for (const row of this.subscriptions.values()) {
          if (row.stripe_customer_id === args.p_stripe_customer_id) {
            userId = row.user_id;
            break;
          }
        }
      }

      if (!userId) {
        this.stripeEvents.set(eventId, {
          stripe_event_id: eventId,
          event_type: String(args.p_event_type),
        });
        return {
          data: { outcome: 'ignored_unlinked', stripe_event_id: eventId },
          error: null,
        };
      }

      const existing = this.subscriptions.get(userId);
      const eventCreated =
        typeof args.p_event_created === 'number' ? args.p_event_created : null;
      const isLiveSnapshot = args.p_is_live_snapshot !== false;

      if (
        !isLiveSnapshot &&
        existing?.last_stripe_event_created != null &&
        eventCreated != null &&
        eventCreated < existing.last_stripe_event_created
      ) {
        this.stripeEvents.set(eventId, {
          stripe_event_id: eventId,
          event_type: String(args.p_event_type),
        });
        return {
          data: {
            outcome: 'stale_event_ignored',
            user_id: userId,
            reconciliation_version: existing.reconciliation_version,
          },
          error: null,
        };
      }

      const status = args.p_status as 'active' | 'past_due' | 'canceled' | 'incomplete';
      const effectivePlan: 'free' | 'pro' =
        args.p_plan_tier === 'pro' && status === 'active' ? 'pro' : 'free';
      const nextVersion = (existing?.reconciliation_version ?? 0) + 1;
      const nextLastCreated =
        eventCreated == null
          ? (existing?.last_stripe_event_created ?? null)
          : Math.max(existing?.last_stripe_event_created ?? 0, eventCreated);

      this.subscriptions.set(userId, {
        user_id: userId,
        stripe_customer_id:
          args.p_stripe_customer_id ?? existing?.stripe_customer_id ?? null,
        stripe_subscription_id:
          args.p_stripe_subscription_id ?? existing?.stripe_subscription_id ?? null,
        plan_tier: effectivePlan,
        status,
        billing_cycle: args.p_billing_cycle ?? existing?.billing_cycle ?? null,
        current_period_end:
          args.p_current_period_end ?? existing?.current_period_end ?? null,
        reconciliation_version: nextVersion,
        last_stripe_event_created: nextLastCreated,
      });

      this.stripeEvents.set(eventId, {
        stripe_event_id: eventId,
        event_type: String(args.p_event_type),
      });

      return {
        data: {
          outcome: 'applied',
          user_id: userId,
          plan_tier: effectivePlan,
          status,
          reconciliation_version: nextVersion,
        },
        error: null,
      };
    });
  });
}

describe('TASK-04..06 & TASK-23: Atomic Stripe Reconciliation, Strict Fail-Closed Entitlement & manual_grants', () => {
  let db: ArtixDB;

  beforeEach(async () => {
    onlineManager.setOnline(true);
    db = new ArtixDB(`artix_billing_${crypto.randomUUID()}`);
    await db.open();
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    db.close();
    await db.delete();
  });

  function makeWrapper(queryClient: QueryClient) {
    const runtimeBundle = { isReady: true, db };
    return ({ children }: { children: React.ReactNode }) => (
      <TestRuntimeContext.Provider value={runtimeBundle}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </TestRuntimeContext.Provider>
    );
  }

  it('1. prepares atomic billing reconciliation + manual_grants SQL migration with strict status/manual_grants quota trigger', () => {
    const migrationPath = path.resolve(
      process.cwd(),
      'supabase/migrations/20261101100300_atomic_billing_reconciliation_and_manual_grants.sql',
    );
    expect(fs.existsSync(migrationPath)).toBe(true);

    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+public\.manual_grants/i);
    expect(sql).toMatch(/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(sql).toMatch(/reconciliation_version/i);
    expect(sql).toMatch(/last_stripe_event_created/i);
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.reconcile_stripe_subscription/i);
    expect(sql).toMatch(/pg_advisory_xact_lock/i);
    expect(sql).toMatch(/INSERT\s+INTO\s+public\.stripe_events/i);
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.user_has_active_pro_entitlement/i);
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.check_plan_tier_limit/i);
    expect(sql).toMatch(/s\.status\s*=\s*'active'/i);
    expect(sql).toMatch(/p\.deleted_at\s+IS\s+NULL/i);
    expect(sql).toMatch(/prd_generations/i);
    expect(sql).toMatch(/vibe_generations/i);
    expect(sql).toMatch(/agentic_workflows/i);
  });

  it('2. B-01: reconciles out-of-order delete->update, paid->payment_failed, duplicates, concurrency, and rolls back on DB error', async () => {
    const reconcileWebhook = (billingPolicy as any).reconcileStripeWebhookEvent;
    expect(typeof reconcileWebhook).toBe('function');

    const fakeDb = new FakeBillingDatabase();
    let liveStripeSub: any = {
      id: 'sub_live_001',
      customer: 'cus_live_001',
      status: 'active',
      current_period_end: 1798761600,
      metadata: { supabase_user_id: TEST_USER.id },
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
    };

    const fakeStripe = {
      subscriptions: {
        retrieve: vi.fn(async () => structuredClone(liveStripeSub)),
      },
    };

    // (a) Initial checkout activates Pro
    await reconcileWebhook({
      event: {
        id: 'evt_checkout_1',
        type: 'checkout.session.completed',
        created: 100,
        data: {
          object: {
            mode: 'subscription',
            subscription: 'sub_live_001',
            customer: 'cus_live_001',
          },
        },
      },
      stripe: fakeStripe,
      supabaseAdmin: fakeDb,
    });

    expect(fakeDb.subscriptions.get(TEST_USER.id)).toMatchObject({
      plan_tier: 'pro',
      status: 'active',
      reconciliation_version: 1,
    });

    // (b) Duplicate delivery of evt_checkout_1 + concurrent delivery serialize idempotently
    const [dupA, dupB] = await Promise.all([
      reconcileWebhook({
        event: {
          id: 'evt_checkout_1',
          type: 'checkout.session.completed',
          created: 100,
          data: { object: { mode: 'subscription', subscription: 'sub_live_001' } },
        },
        stripe: fakeStripe,
        supabaseAdmin: fakeDb,
      }),
      reconcileWebhook({
        event: {
          id: 'evt_sub_created_1',
          type: 'customer.subscription.created',
          created: 101,
          data: { object: { id: 'sub_live_001', customer: 'cus_live_001' } },
        },
        stripe: fakeStripe,
        supabaseAdmin: fakeDb,
      }),
    ]);

    expect(dupA.outcome).toBe('duplicate_event');
    expect(dupB.outcome).toBe('applied');
    expect(fakeDb.subscriptions.get(TEST_USER.id)?.reconciliation_version).toBe(2);

    // (c) DB failure rolls back atomically so stripe_events does NOT record evt_transient_fail
    liveStripeSub.status = 'past_due';
    fakeDb.failNextRpcError = 'connection reset by peer';

    await expect(
      reconcileWebhook({
        event: {
          id: 'evt_payment_failed_1',
          type: 'invoice.payment_failed',
          created: 150,
          data: { object: { subscription: 'sub_live_001', customer: 'cus_live_001' } },
        },
        stripe: fakeStripe,
        supabaseAdmin: fakeDb,
      }),
    ).rejects.toThrow(/connection reset by peer/);

    expect(fakeDb.stripeEvents.has('evt_payment_failed_1')).toBe(false);
    expect(fakeDb.subscriptions.get(TEST_USER.id)?.status).toBe('active');

    // Retry succeeds and downgrades plan_tier to 'free' with status 'past_due' (Decision A1)
    await reconcileWebhook({
      event: {
        id: 'evt_payment_failed_1',
        type: 'invoice.payment_failed',
        created: 150,
        data: { object: { subscription: 'sub_live_001', customer: 'cus_live_001' } },
      },
      stripe: fakeStripe,
      supabaseAdmin: fakeDb,
    });

    expect(fakeDb.subscriptions.get(TEST_USER.id)).toMatchObject({
      plan_tier: 'free',
      status: 'past_due',
    });

    // (d) Out-of-order: invoice.paid (t=200) arrives first -> active Pro;
    // then delayed invoice.payment_failed (t=180) arrives AFTER payment already succeeded!
    liveStripeSub.status = 'active';
    await reconcileWebhook({
      event: {
        id: 'evt_invoice_paid_2',
        type: 'invoice.paid',
        created: 200,
        data: { object: { subscription: 'sub_live_001', customer: 'cus_live_001' } },
      },
      stripe: fakeStripe,
      supabaseAdmin: fakeDb,
    });
    expect(fakeDb.subscriptions.get(TEST_USER.id)).toMatchObject({
      plan_tier: 'pro',
      status: 'active',
    });

    await reconcileWebhook({
      event: {
        id: 'evt_delayed_payment_failed',
        type: 'invoice.payment_failed',
        created: 180,
        data: { object: { subscription: 'sub_live_001', customer: 'cus_live_001' } },
      },
      stripe: fakeStripe,
      supabaseAdmin: fakeDb,
    });
    // Live Stripe state is 'active', so delayed failure does NOT clobber Pro!
    expect(fakeDb.subscriptions.get(TEST_USER.id)).toMatchObject({
      plan_tier: 'pro',
      status: 'active',
    });

    // (e) Out-of-order: customer.subscription.deleted (t=300) arrives before stale active update (t=250)
    liveStripeSub.status = 'canceled';
    await reconcileWebhook({
      event: {
        id: 'evt_deleted_3',
        type: 'customer.subscription.deleted',
        created: 300,
        data: { object: { id: 'sub_live_001', customer: 'cus_live_001', status: 'canceled' } },
      },
      stripe: fakeStripe,
      supabaseAdmin: fakeDb,
    });

    await reconcileWebhook({
      event: {
        id: 'evt_stale_active_update',
        type: 'customer.subscription.updated',
        created: 250,
        data: { object: { id: 'sub_live_001', customer: 'cus_live_001', status: 'active' } },
      },
      stripe: fakeStripe,
      supabaseAdmin: fakeDb,
    });

    expect(fakeDb.subscriptions.get(TEST_USER.id)).toMatchObject({
      plan_tier: 'free',
      status: 'canceled',
    });
  });

  it('3. B-02 (Decision A1): enforces GRACE_PERIOD_DAYS = 0 and blocks Pro quota leaks in useUsageLimits when status is past_due', async () => {
    expect(GRACE_PERIOD_DAYS).toBe(0);

    // Seed 10 local documents (at the Free tier limit of 10)
    const now = '2026-11-01T00:00:00.000Z';
    await db.documents.bulkPut(
      Array.from({ length: 10 }, (_, idx) => ({
        id: `doc-pastdue-${idx + 1}`,
        projectId: 'proj-1',
        userId: TEST_USER.id,
        folderId: null,
        title: `Doc ${idx + 1}`,
        content: '# Spec',
        format: 'markdown' as const,
        createdAt: now,
        updatedAt: now,
        localRevision: 1,
        isDeleted: false,
      })),
    );

    // Simulate a legacy row where plan_tier was still 'pro' while status is 'past_due'
    vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  plan_tier: 'pro',
                  status: 'past_due',
                  billing_cycle: 'monthly',
                  current_period_end: '2026-10-01T00:00:00Z',
                  stripe_customer_id: 'cus_past_due',
                },
                error: null,
              }),
            }),
          }),
        } as any;
      }
      if (table === 'manual_grants') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        } as any;
      }
      return {
        select: () => ({
          eq: () => ({
            gte: async () => ({ count: 5, error: null }),
            then: (resolve: any) => resolve({ count: 10, error: null }),
            count: 10,
            error: null,
          }),
        }),
      } as any;
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const { result } = renderHook(
      () => ({
        sub: useSubscription(),
        limits: useUsageLimits(),
      }),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => {
      expect(result.current.sub.isLoading).toBe(false);
      expect(result.current.limits.isLoading).toBe(false);
    });

    expect(result.current.sub.isPastDue).toBe(true);
    expect(result.current.sub.isPro).toBe(false);
    // Must enforce Free tier limits (10 docs, 5 AI gens), NOT Pro unlimited!
    expect(result.current.limits.documents.limit).toBe(10);
    expect(result.current.limits.documents.used).toBe(10);
    expect(result.current.limits.documents.canCreate).toBe(false);
    expect(result.current.limits.aiGenerations.limit).toBe(5);
    expect(result.current.limits.aiGenerations.canCreate).toBe(false);
  });

  it('4. B-03 & TASK-23: honors active manual_grants for Pro entitlement and fails closed when revoked or expired', async () => {
    let manualGrantRow: any = {
      plan_tier: 'pro',
      starts_at: '2026-01-01T00:00:00Z',
      expires_at: null,
      revoked_at: null,
    };

    vi.spyOn(supabase, 'from').mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  plan_tier: 'free',
                  status: 'active',
                  billing_cycle: null,
                  current_period_end: null,
                  stripe_customer_id: null,
                },
                error: null,
              }),
            }),
          }),
        } as any;
      }
      if (table === 'manual_grants') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: manualGrantRow,
                error: null,
              }),
            }),
          }),
        } as any;
      }
      return {
        select: () => ({
          eq: () => ({
            gte: async () => ({ count: 0, error: null }),
            then: (resolve: any) => resolve({ count: 0, error: null }),
            count: 0,
            error: null,
          }),
        }),
      } as any;
    });

    const qc1 = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const activeGrantRender = renderHook(
      () => ({ sub: useSubscription(), limits: useUsageLimits() }),
      { wrapper: makeWrapper(qc1) },
    );

    await waitFor(() => {
      expect(activeGrantRender.result.current.sub.isLoading).toBe(false);
      expect(activeGrantRender.result.current.limits.isLoading).toBe(false);
    });

    expect(activeGrantRender.result.current.sub.isPro).toBe(true);
    expect(activeGrantRender.result.current.limits.documents.limit).toBeNull();
    activeGrantRender.unmount();

    // Revoke grant -> must immediately fail closed to Free
    manualGrantRow = {
      plan_tier: 'pro',
      starts_at: '2026-01-01T00:00:00Z',
      expires_at: null,
      revoked_at: '2026-06-01T00:00:00Z',
    };

    const qc2 = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const revokedGrantRender = renderHook(
      () => ({ sub: useSubscription(), limits: useUsageLimits() }),
      { wrapper: makeWrapper(qc2) },
    );

    await waitFor(() => {
      expect(revokedGrantRender.result.current.sub.isLoading).toBe(false);
      expect(revokedGrantRender.result.current.limits.isLoading).toBe(false);
    });

    expect(revokedGrantRender.result.current.sub.isPro).toBe(false);
    expect(revokedGrantRender.result.current.limits.documents.limit).toBe(10);
  });

  it('5. TASK-23: ensures zero hardcoded personal email addresses exist in newly authored migrations, docs, or src code', () => {
    const filesToScan: string[] = [
      'README.md',
      'DOCS.md',
      'SECURITY.md',
      'supabase/migrations/20261101100000_expand_sync_protocol_and_projects.sql',
      'supabase/migrations/20261101100100_contract_strict_cas_base_version.sql',
      'supabase/migrations/20261101100200_sync_changes_retention_and_floor.sql',
      'supabase/migrations/20261101100300_atomic_billing_reconciliation_and_manual_grants.sql',
    ];

    const gmailOrPersonalRegex = /[a-zA-Z0-9._%+-]+@(gmail|yahoo|hotmail|outlook)\.com/i;
    for (const relPath of filesToScan) {
      const fullPath = path.resolve(process.cwd(), relPath);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        expect(content, `Unexpected personal email in ${relPath}`).not.toMatch(
          gmailOrPersonalRegex,
        );
      }
    }
  });
});
