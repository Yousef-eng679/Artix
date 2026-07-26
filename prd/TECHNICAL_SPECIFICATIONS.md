# Artix — Technical Specifications and Database Schema

Target Release: v1.5.0

---

## 1. Database Schema and Row Level Security (RLS)

All database tables reside in Supabase PostgreSQL (`public` schema) and are protected by Row Level Security policies requiring authenticated JWT sessions (`auth.uid() = user_id`).

```sql
-- 1. Projects Table (20260203132019 & 20260724060000)
CREATE TABLE public.projects (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Untitled Project',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Foreign Key Constraint (added via 20260724060000_add_missing_user_fk_constraints.sql):
-- CONSTRAINT projects_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. Documents Table (20260202130240 & 20260203132019)
CREATE TABLE public.documents (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Untitled Document',
  content TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'xml', 'text')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 3. System Designs Table (20260203132019 & 20260724060000)
CREATE TABLE public.system_designs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'System Design',
  board_state JSONB NOT NULL DEFAULT '{"nodes": [], "edges": []}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Foreign Key Constraint (added via 20260724060000_add_missing_user_fk_constraints.sql):
-- CONSTRAINT system_designs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- 4. Profiles Table (20260205164934)
CREATE TABLE public.profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 5. Subscriptions Table (20260722180000)
CREATE TABLE public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  plan_tier TEXT NOT NULL DEFAULT 'free' CHECK (plan_tier IN ('free', 'pro')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'canceled', 'incomplete')),
  billing_cycle TEXT CHECK (billing_cycle IN ('monthly', 'annual')),
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Stripe Events Table (20260722180000 - Idempotency)
CREATE TABLE public.stripe_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7. PRD Generations Table (20260617215902)
CREATE TABLE public.prd_generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  template TEXT NOT NULL,
  output_markdown TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. Agentic Workflows Table
CREATE TABLE public.agentic_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  pattern TEXT NOT NULL,
  agent_count INTEGER NOT NULL DEFAULT 1,
  output_markdown TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9. Vibe Generations Table
CREATE TABLE public.vibe_generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  target TEXT NOT NULL,
  scope TEXT NOT NULL,
  output_markdown TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 2. Supabase Cloud Edge Functions

Edge Functions run on Deno TypeScript runtime at edge locations:

### 1. `create-checkout-session`
- **Location**: `supabase/functions/create-checkout-session/index.ts`
- **Purpose**: Creates Stripe Checkout Sessions for Pro tier upgrades.
- **Security**: Validates user JWT from `Authorization` header. Imports CORS header utility (`../_shared/cors.ts`).

### 2. `create-portal-session`
- **Location**: `supabase/functions/create-portal-session/index.ts`
- **Purpose**: Generates Stripe Customer Portal URLs.
- **Security**: Validates JWT, queries `subscriptions.stripe_customer_id`, passes `return_url`.

### 3. `stripe-webhook`
- **Location**: `supabase/functions/stripe-webhook/index.ts`
- **Purpose**: Processes Stripe billing webhooks idempotently.
- **Security**: Validates `Stripe-Signature` header against raw request body using `constructEventAsync`. Checks idempotency against `public.stripe_events`.

---

## 3. Frontend Architecture and Code Splitting

- **Vercel SPA Rewrites**: `vercel.json` maps all non-static requests to `/index.html` (`"rewrites": [{"source": "/(.*)", "destination": "/index.html"}]`), resolving Vercel edge `404 NOT_FOUND` errors on direct URL refreshes.
- **Route Code-Splitting**: `App.tsx` imports page routes via `React.lazy()` and wraps them in `<Suspense fallback={<PageFallback />}>`. Monaco Editor and React Flow are isolated in a separate `ProjectWorkspace` bundle (~561 kB), lowering the initial JavaScript entry chunk from 1.47 MB to ~613 kB.

---

## 4. AI Streaming and Refinement Pipeline

```
[ User Input ]
      │
      ▼
[ Prompt Generator (prd.ts / vibe.ts / architecture.ts) ]
      │
      ▼
[ 1st Pass: BYOK Provider Direct Call (registry.ts) ]
      │
      ▼
[ Draft Stream Output ]
      │
      ▼
[ 2nd Pass: Refinement Pass (refine.ts) ]
      │ Purges vague filler ("ensure scalability", "TBD")
      │ Expands concrete specs & verification steps
      ▼
[ Final Clean Response Render ]
```
