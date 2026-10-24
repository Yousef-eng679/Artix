import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno'
import { getCorsHeaders, isOriginAllowed } from '../_shared/cors.ts'
import { resolveAllowedCheckoutPrice } from '../_shared/billingPolicy.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
})

Deno.serve(async (req) => {
  const headers = getCorsHeaders(req)

  // Handle CORS preflight request
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers })
  }

  try {
    // 1. Verify JWT from Authorization header
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      throw new Error('No authorization header')
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser()
    if (userError || !user) throw new Error('Error getting user')

    // 2. Validate { priceId, billingCycle, origin } against authoritative server policy (Audit F-002)
    const body = await req.json()
    const { priceId, billingCycle, origin } = body ?? {}
    if (!origin || typeof origin !== 'string') {
      throw new Error('origin is required')
    }

    if (!isOriginAllowed(origin)) {
      throw new Error('Invalid origin')
    }

    const priceResolution = resolveAllowedCheckoutPrice({ priceId, billingCycle })
    if (!priceResolution.ok) {
      throw new Error(priceResolution.error)
    }

    const approvedPlan = priceResolution.spec

    // Use service role for database operations
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 3. Look up user's existing stripe_customer_id
    const { data: subscription, error: lookupError } = await supabaseAdmin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (lookupError) {
      throw new Error(`Failed to read subscription record: ${lookupError.message}`)
    }

    let customerId = subscription?.stripe_customer_id

    // 4 & 5. Create Stripe customer if none exists and store in db
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          supabase_user_id: user.id,
        },
      })
      customerId = customer.id

      const { error: upsertError } = await supabaseAdmin
        .from('subscriptions')
        .upsert(
          { user_id: user.id, stripe_customer_id: customerId },
          { onConflict: 'user_id' }
        )

      if (upsertError) {
        throw new Error(`Failed to persist Stripe customer ID: ${upsertError.message}`)
      }
    }

    // 6. Create Checkout Session using ONLY the server-approved Price ID
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: approvedPlan.priceId, quantity: 1 }],
      success_url: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/dashboard`,
      subscription_data: {
        metadata: {
          supabase_user_id: user.id,
          plan_tier: approvedPlan.planTier,
          billing_cycle: approvedPlan.billingCycle,
        },
      },
    })

    // 7. Return url
    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Checkout session error'
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
