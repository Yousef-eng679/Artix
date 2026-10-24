import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno'
import { validateSubscriptionEntitlement } from '../_shared/billingPolicy.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
})

Deno.serve(async (req) => {
  // We don't verify JWT here, as this is called by Stripe

  // 1. Verify webhook signature
  const signature = req.headers.get('Stripe-Signature')
  if (!signature) {
    return new Response('No signature', { status: 400 })
  }

  let event: Stripe.Event
  try {
    const body = await req.text()
    const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') as string

    // This is NON-NEGOTIABLE
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

    // 2. Check idempotency
    const { data: existingEvent, error: lookupError } = await supabaseAdmin
      .from('stripe_events')
      .select('id')
      .eq('stripe_event_id', event.id)
      .maybeSingle()

    if (lookupError) {
      throw new Error(`Failed to check stripe_events ledger: ${lookupError.message}`)
    }

    if (existingEvent) {
      console.log(`Event ${event.id} already processed.`)
      return new Response('Event already processed', { status: 200 })
    }

    // 3. Handle events with authoritative server price & status validation (Audit F-002 + R7)
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        if (session.mode === 'subscription' && session.subscription) {
          const subscriptionId =
            typeof session.subscription === 'string'
              ? session.subscription
              : session.subscription.id
          const subscription = await stripe.subscriptions.retrieve(subscriptionId)
          const userId = subscription.metadata?.supabase_user_id

          if (userId) {
            const decision = validateSubscriptionEntitlement(subscription)
            if (!decision.entitled) {
              console.warn(
                `[stripe-webhook] Refusing Pro entitlement on checkout.session.completed for user ${userId}: ${decision.reason}`
              )
            }

            const { error: upsertError } = await supabaseAdmin
              .from('subscriptions')
              .upsert(
                {
                  user_id: userId,
                  stripe_customer_id:
                    typeof session.customer === 'string'
                      ? session.customer
                      : (session.customer?.id ?? null),
                  stripe_subscription_id: subscriptionId,
                  plan_tier: decision.planTier,
                  status: decision.dbStatus,
                  billing_cycle: decision.billingCycle,
                  current_period_end: new Date(
                    subscription.current_period_end * 1000
                  ).toISOString(),
                },
                { onConflict: 'user_id' }
              )

            if (upsertError) {
              throw new Error(
                `Failed to upsert subscription on checkout.session.completed: ${upsertError.message}`
              )
            }
          }
        }
        break
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription
        const decision = validateSubscriptionEntitlement(subscription)
        if (!decision.entitled && subscription.status === 'active') {
          console.warn(
            `[stripe-webhook] Refusing Pro entitlement on customer.subscription.updated (${subscription.id}): ${decision.reason}`
          )
        }

        const { error: updateError } = await supabaseAdmin
          .from('subscriptions')
          .update({
            plan_tier: decision.planTier,
            status: decision.dbStatus,
            current_period_end: new Date(
              subscription.current_period_end * 1000
            ).toISOString(),
            billing_cycle: decision.billingCycle,
          })
          .eq('stripe_subscription_id', subscription.id)

        if (updateError) {
          throw new Error(
            `Failed to update subscription (${subscription.id}): ${updateError.message}`
          )
        }
        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription
        const { error: deleteError } = await supabaseAdmin
          .from('subscriptions')
          .update({
            plan_tier: 'free',
            status: 'canceled',
          })
          .eq('stripe_subscription_id', subscription.id)

        if (deleteError) {
          throw new Error(
            `Failed to mark subscription canceled (${subscription.id}): ${deleteError.message}`
          )
        }
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        if (invoice.subscription) {
          const subscriptionId =
            typeof invoice.subscription === 'string'
              ? invoice.subscription
              : invoice.subscription.id
          const { error: paymentFailedError } = await supabaseAdmin
            .from('subscriptions')
            .update({ status: 'past_due' })
            .eq('stripe_subscription_id', subscriptionId)

          if (paymentFailedError) {
            throw new Error(
              `Failed to mark subscription past_due (${subscriptionId}): ${paymentFailedError.message}`
            )
          }
        }
        break
      }
    }

    // 4. Record event with conflict-safe upsert only AFTER state writes succeed
    const { error: recordEventError } = await supabaseAdmin
      .from('stripe_events')
      .upsert(
        {
          stripe_event_id: event.id,
          event_type: event.type,
        },
        { onConflict: 'stripe_event_id', ignoreDuplicates: true }
      )

    if (recordEventError) {
      throw new Error(`Failed to record stripe_event (${event.id}): ${recordEventError.message}`)
    }

    // 5. Return 200
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal webhook processing error'
    console.error(`Webhook processing failure: ${message}`)
    // Return 500 on downstream Stripe/DB errors so Stripe retries delivery
    return new Response(`Webhook Processing Error: ${message}`, { status: 500 })
  }
})
