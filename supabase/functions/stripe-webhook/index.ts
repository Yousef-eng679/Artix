import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno'
import {
  reconcileStripeWebhookEvent,
  validateSubscriptionEntitlement,
} from '../_shared/billingPolicy.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
})

Deno.serve(async (req) => {
  // 1. Verify webhook signature (NON-NEGOTIABLE)
  const signature = req.headers.get('Stripe-Signature')
  if (!signature) {
    return new Response('No signature', { status: 400 })
  }

  let event: Stripe.Event
  try {
    const body = await req.text()
    const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') as string
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid signature'
    console.error(`Webhook signature verification failed: ${message}`)
    return new Response(`Webhook Error: ${message}`, { status: 400 })
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 2. Authoritative live Stripe retrieve + validateSubscriptionEntitlement +
    //    single-transaction atomic RPC (`public.reconcile_stripe_subscription`)
    void validateSubscriptionEntitlement
    const result = await reconcileStripeWebhookEvent({
      event: {
        id: event.id,
        type: event.type,
        created: event.created,
        data: {
          object: (event.data?.object ?? {}) as Record<string, unknown>,
        },
      },
      stripe: stripe as unknown as Parameters<typeof reconcileStripeWebhookEvent>[0]['stripe'],
      supabaseAdmin: supabaseAdmin as unknown as Parameters<
        typeof reconcileStripeWebhookEvent
      >[0]['supabaseAdmin'],
    })

    return new Response(
      JSON.stringify({
        received: true,
        outcome: result.outcome,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal webhook processing error'
    console.error(`Webhook processing failure: ${message}`)
    // Return 500 on downstream Stripe/DB errors so Stripe retries delivery
    return new Response(`Webhook Processing Error: ${message}`, { status: 500 })
  }
})
