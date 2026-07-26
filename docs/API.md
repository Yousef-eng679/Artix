# API Specification — Artix

This document details all Supabase database tables (REST API), Cloud Edge Functions, and client-side AI provider integrations.

---

## Database Tables (Supabase REST API)

All REST endpoints require `apikey: VITE_SUPABASE_PUBLISHABLE_KEY` and are protected by Supabase Row Level Security (RLS) policies.

### 1. `public.projects`
Represents user workspaces.

- **GET `/rest/v1/projects?select=*`**
  - *Auth*: Required (JWT)
  - *Response*: `Array<{ id: string, user_id: string, name: string, created_at: string, updated_at: string }>`
- **POST `/rest/v1/projects`**
  - *Auth*: Required (JWT)
  - *Body*: `{ name: string }`
  - *Limits*: Max 3 for Free plan users (enforced by DB trigger). Foreign key on `user_id` referencing `auth.users(id) ON DELETE CASCADE`.
- **PATCH `/rest/v1/projects?id=eq.{id}`**
  - *Auth*: Required (JWT)
  - *Body*: `{ name?: string }`
- **DELETE `/rest/v1/projects?id=eq.{id}`**
  - *Auth*: Required (JWT)

---

### 2. `public.documents`
Represents Markdown, XML, and Plain Text specs inside projects.

- **GET `/rest/v1/documents?project_id=eq.{projectId}&select=*`**
  - *Auth*: Required (JWT)
  - *Response*: `Array<{ id: string, project_id: string, title: string, content: string, format: 'markdown' | 'xml' | 'text', updated_at: string }>`
- **POST `/rest/v1/documents`**
  - *Auth*: Required (JWT)
  - *Body*: `{ project_id: string, title: string, content?: string, format?: string }`
  - *Limits*: Max 10 per user on Free plan.
- **PATCH `/rest/v1/documents?id=eq.{id}`**
  - *Auth*: Required (JWT)
  - *Body*: `{ title?: string, content?: string, format?: string }`

---

### 3. `public.system_designs`
Represents React Flow architecture board states.

- **GET `/rest/v1/system_designs?project_id=eq.{projectId}&select=*`**
  - *Auth*: Required (JWT)
  - *Response*: `Array<{ id: string, project_id: string, name: string, board_state: BoardState, updated_at: string }>`
- **POST `/rest/v1/system_designs`**
  - *Auth*: Required (JWT)
  - *Body*: `{ project_id: string, name: string, board_state: { nodes: [], edges: [], strokes: [] } }`
  - *Limits*: Max 3 per user on Free plan. Foreign key on `user_id` referencing `auth.users(id) ON DELETE CASCADE`.

---

### 4. `public.subscriptions`
Represents user subscription and plan state.

- **GET `/rest/v1/subscriptions?select=*`**
  - *Auth*: Required (JWT)
  - *Response*: `{ user_id: string, plan_tier: 'free' | 'pro', status: 'active' | 'past_due' | 'canceled', billing_cycle: 'monthly' | 'annual', current_period_end: string }`

---

### 5. `public.stripe_events`
Tracks Stripe webhook event IDs for idempotency.

- **GET `/rest/v1/stripe_events?select=*`**
  - *Auth*: Service Role key
  - *Response*: `Array<{ id: string, stripe_event_id: string, event_type: string, processed_at: string }>`

---

## Supabase Edge Functions

### 1. `POST /functions/v1/create-checkout-session`
Generates Stripe Checkout URLs for upgrades.

- **Auth**: Required (`Authorization: Bearer <user_jwt>`)
- **Body**: `{ priceId: string, origin: string }`
- **Response**: `{ url: string }`

### 2. `POST /functions/v1/create-portal-session`
Generates Stripe Customer Portal URLs.

- **Auth**: Required (`Authorization: Bearer <user_jwt>`)
- **Body**: `{ return_url: string }`
- **Response**: `{ url: string }`

### 3. `POST /functions/v1/stripe-webhook`
Handles incoming Stripe billing webhooks idempotently.

- **Auth**: Verified via `Stripe-Signature` header (`constructEventAsync`).
- **Events Handled**:
  - `checkout.session.completed` -> Sets `plan_tier = 'pro'`, `status = 'active'`.
  - `customer.subscription.updated` -> Updates plan tier, status, billing cycle, and period end.
  - `customer.subscription.deleted` -> Reverts `plan_tier = 'free'`, `status = 'canceled'`.
  - `invoice.payment_failed` -> Sets `status = 'past_due'`.

---

## Client-Side AI Provider Integrations

All AI calls execute directly from the client browser to provider endpoints (BYOK architecture):

- **OpenAI**: `https://api.openai.com/v1/chat/completions` (`gpt-4o`, `gpt-4o-mini`)
- **Anthropic**: `https://api.anthropic.com/v1/messages` (`claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`)
- **Google Gemini**: `https://generativelanguage.googleapis.com/v1beta/models/...:streamGenerateContent` (`gemini-1.5-pro`, `gemini-1.5-flash`)
- **Groq**: `https://api.groq.com/openai/v1/chat/completions` (`llama-3.3-70b-versatile`)
- **OpenRouter**: `https://openrouter.ai/api/v1/chat/completions`
- **Ollama**: `http://localhost:11434/api/generate` (Local keyless server, requires `OLLAMA_ORIGINS=*`)
