# Artix — Technical Specification and Architecture Document

Artix is a developer workspace platform that combines multi-format technical documentation, interactive system architecture diagrams, algorithm visualization, and structured AI prompt generation into a single web application.

---

## Table of Contents
1. [Product Overview and Features](#1-product-overview-and-features)
2. [System Architecture](#2-system-architecture)
3. [API Reference](#3-api-reference)
4. [Changelog and Release History](#4-changelog-and-release-history)
5. [UI and UX Guidelines](#5-ui-and-ux-guidelines)
6. [Project File Structure](#6-project-file-structure)
7. [Engineering Challenges and Technical Solutions](#7-engineering-challenges-and-technical-solutions)
8. [Testing and Quality Assurance](#8-testing-and-quality-assurance)

---

## 1. Product Overview and Features

### Core Capabilities

- **Document Forge**: Text editor built on Monaco Editor supporting Markdown (`.md`), XML (`.xml`), and Plain Text (`.txt`). Includes live split-pane rendering, a 1000ms debounced auto-save queue, multi-tab state sync via `BroadcastChannel`, and export to PDF, HTML, or raw Markdown.
- **System Architect**: Visual node editor built on `@xyflow/react` (React Flow) for designing microservice systems and state machines. Features Left-to-Right (`LR`) graph layout using `@dagrejs/dagre`, 1-click auto-layout, and freehand drawing overlays.
- **AI Tools**:
  - **PRD Generator**: Mode-based PRD generator (Agile, Technical Spec, Lean MVP, Custom).
  - **Vibe Coding**: Generates file-scoped prompts with `[NEW]` and `[MODIFY]` action tags for Cursor, Artix, and generic LLM targets.
  - **Agentic Workflow Designer**: Visualizer for multi-agent execution patterns (Sequential, Fan-Out, Orchestrator-Workers, Router, Evaluator, Autonomous ReAct).
  - **Refinement Pass (`refine.ts`)**: 2-pass critique flow that cleans up vague phrasing and expands specification drafts.
- **Authentication**: Supports 1-click Google OAuth (`signInWithGoogle`) and standard email/password authentication via Supabase Auth.
- **API Key Storage & Encryption**: Bring-Your-Own-Key (BYOK) setup supporting OpenAI, Anthropic, Gemini, Groq, OpenRouter, and local Ollama instances. Keys are stored in `localStorage` with `obf:` prefix obfuscation and optional `AES-256-GCM` encryption. Since keys stay in the browser, users are prompted to keep external backups.
- **Stripe Billing**: Free vs Pro plans managed via Supabase Edge Functions (`create-checkout-session`, `create-portal-session`, `stripe-webhook`) and PostgreSQL quota triggers.
- **PWA & Offline Support**: Progressive Web App configuration with ServiceWorker caching for offline document viewing and editing.

### Tech Stack
- **Frontend**: React 18, Vite 5, TypeScript, Tailwind CSS, shadcn/ui, Framer Motion
- **Editor & Canvas**: Monaco Editor (`@monaco-editor/react`), React Flow (`@xyflow/react`), `@dagrejs/dagre`
- **Backend & Database**: Supabase (PostgreSQL with Row Level Security, Auth, Triggers)
- **Edge Runtime**: Supabase Edge Functions (Deno / TypeScript)
- **Deployment**: Vercel with SPA rewrite rules in `vercel.json`
- **Testing**: Vitest (78 unit/integration tests), Playwright (E2E & security specs)

---

## 2. System Architecture

### High-Level System Flow
```
[ Browser / Client ]
  │
  ├──► Local Storage Cache (AES-256-GCM / obf: Obfuscation)
  ├──► Monaco Editor & React Flow Canvas Engine
  │
  ├──► Vercel Edge SPA Router (vercel.json -> index.html)
  │
  ├──► Supabase Client (Auth & Postgres RLS Tables)
  │      ├── public.projects (FK -> auth.users)
  │      ├── public.documents
  │      ├── public.system_designs (FK -> auth.users)
  │      ├── public.subscriptions
  │      └── public.stripe_events (Idempotency)
  │
  ├──► Supabase Edge Functions (Deno Runtime)
  │      ├── create-checkout-session (Stripe Checkout)
  │      ├── create-portal-session (Stripe Portal)
  │      └── stripe-webhook (Signature Verification & Idempotency)
  │
  └──► Direct AI Provider APIs (OpenAI / Anthropic / Gemini / Groq / Ollama)
```

### Subsystem Details

1. **Document Forge and Storage Sync**:
   - Monaco Editor dual-view sync.
   - 4-Tier Auto-Save strategy: 1000ms Debounce → Optimistic Lock Queue (`saveQueue.ts`) → `sendBeacon` / `keepalive` Unload Guard (`tabCloseGuard.ts`) → `BroadcastChannel` Multi-Tab Sync (`multiTabSync.ts`).

2. **System Architect and Graph Engine**:
   - React Flow graph with custom node components, connection lines, double-click label editing, and freehand drawing canvas.
   - Graph auto-layout via `@dagrejs/dagre` (Left-to-Right `LR` layout for System Architect; Top-to-Bottom `TB` for Algorithm Visualizer).

3. **Performance and Code-Splitting**:
   - Route-level code splitting using `React.lazy()` and static `<Suspense fallback={<PageFallback />}>` in `src/App.tsx`.
   - Heavy dependencies (Monaco Editor and React Flow) are isolated into a separate `ProjectWorkspace` chunk (~561 kB), reducing initial JS payload from 1.47 MB to ~613 kB.

4. **Security and Key Protection**:
   - Keys written to `localStorage` are prefixed with `obf:`. Optional `AES-256-GCM` encryption derives a key via 100,000 PBKDF2 iterations.
   - Inline alerts and save toasts remind users that keys remain local to their browser cache.

5. **Database & Foreign Key Integrity**:
   - Foreign key constraints `projects_user_id_fkey` and `system_designs_user_id_fkey` enforce `ON DELETE CASCADE` on `auth.users(id)`.
   - Quota limits enforced by PostgreSQL triggers (`enforce_tier_limits_trigger.sql`).

---

## 3. API Reference

### Database Tables (Supabase REST API)

- **`public.projects`**: User workspaces (`id`, `user_id`, `name`, `description`). Foreign key on `user_id` referencing `auth.users(id) ON DELETE CASCADE`. Max 3 on Free plan.
- **`public.documents`**: Technical documents (`id`, `project_id`, `title`, `content`, `format`). Max 10 per user on Free plan.
- **`public.system_designs`**: Architecture graph states (`id`, `project_id`, `name`, `board_state`). Foreign key on `user_id` referencing `auth.users(id) ON DELETE CASCADE`. Max 3 on Free plan.
- **`public.subscriptions`**: Billing state (`user_id`, `plan_tier`, `status`, `billing_cycle`, `current_period_end`).
- **`public.stripe_events`**: Idempotency tracking table (`stripe_event_id`, `event_type`, `processed_at`).

### Supabase Edge Functions

- `POST /functions/v1/create-checkout-session`: Generates Stripe Checkout URLs. Accepts `{ priceId: string, origin: string }`.
- `POST /functions/v1/create-portal-session`: Generates Stripe Customer Portal URLs. Accepts `{ return_url: string }`.
- `POST /functions/v1/stripe-webhook`: Idempotently handles Stripe webhook events (`checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`). Verifies `Stripe-Signature` via `constructEventAsync`.

### Client-Side AI Provider Calls
- OpenAI (`gpt-4o`, `gpt-4o-mini`)
- Anthropic (`claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`)
- Google Gemini (`gemini-1.5-pro`, `gemini-1.5-flash`)
- Groq (`llama-3.3-70b-versatile`)
- OpenRouter & Local keyless Ollama (`http://localhost:11434/api/generate`)

---

## 4. Changelog and Release History

### [v1.5.0] — 2026-07-25
- **Google OAuth**: Integrated 1-click Google OAuth authentication (`signInWithGoogle`) in `useAuth.tsx` and added Google Sign-In button on `Auth.tsx`.
- **Vercel SPA Routing**: Added `vercel.json` containing SPA rewrite rules (`/(.*)` -> `/index.html`) to resolve deep-link 404 errors on Vercel edge deployment.
- **Database Foreign Keys**: Applied migration `20260724060000_add_missing_user_fk_constraints.sql` to enforce `projects_user_id_fkey` and `system_designs_user_id_fkey` constraints referencing `auth.users(id) ON DELETE CASCADE`.
- **Route Code-Splitting**: Updated `App.tsx` with `React.lazy()` and `<Suspense>` route code splitting, reducing initial JavaScript bundle size by over 58%.
- **API Key Storage Warning**: Added clear UX warning notices in `AISettingsCard.tsx` reminding users to maintain external backups of API keys.

### [v1.4.0] — 2026-07-23
- **Hero Layout Clean-up**: Removed sub-hero file format badges from `Index.tsx`.
- **Accessibility & Indexing**: Added `/public/llms.txt` and `/public/llms-full.txt`. Added `<main id="main-content">` landmark and explicit `aria-label` tags on navigation buttons.

### [v1.3.0] — 2026-07-23
- **System Architect Updates**: Changed graph positioning to horizontal Left-to-Right (`LR`) layout. Added 1-click Auto Layout button and increased diagram node capacity to 40 nodes.

### [v1.2.0] — 2026-07-23
- **Prompt Engineering & Reflection**: Added system prompts for PRD and Vibe Coding generators. Added 2-pass critique flow in `refine.ts`.

### [v1.1.0] — 2026-07-23
- **Stripe Billing Integration**: Added Edge Functions for Stripe Checkout, Customer Portal, and Webhook processing. Added PostgreSQL quota triggers.

### [v1.0.0] — 2026-07-22
- **Initial Platform Release**: Rebranded to Artix. Added 4-tier auto-save engine, client-side encryption, and Playwright test suite.

---

## 5. UI and UX Guidelines

- **Theme Aesthetic**: Dark mode across all components using deep slate backgrounds (`hsl(220 14% 8%)`), warm amber accents (`hsl(38 92% 50%)`), and glassmorphism card surfaces (`backdrop-blur-md`).
- **Typography**: `Inter` for general UI text; `JetBrains Mono` for Monaco Editor, code blocks, and prompt outputs.
- **Buttons and Controls**: Primary amber buttons (`bg-primary`), outline controls, and icon buttons with explicit `aria-label` attributes for accessibility and web agent navigation.
- **Lazy Loading Fallback**: Static, hook-free `<PageFallback />` loading spinner rendered during route code-splitting transitions.

---

## 6. Project File Structure

```
c:/Fenix-main/
├── DOCS.md                    # Consolidated Technical Specification
├── vercel.json                # Vercel SPA Routing Configuration
├── docs/                      # Technical documentation suite
│   ├── README.md
│   ├── ARCHITECTURE.md
│   ├── API.md
│   ├── CHANGELOG.md
│   ├── UI_UX_GUIDELINES.md
│   ├── PROJECT_FILE_STRUCTURE.md
│   ├── CHALLENGES_AND_SOLUTIONS.md
│   └── TESTING.md
├── public/                    # Static assets, PWA manifest & llms.txt specs
├── src/                       # Frontend Source Code
│   ├── assets/                # App branding & logo assets
│   ├── components/            # UI components, AI Dialogs & Monaco Editor
│   ├── hooks/                 # Custom React hooks (Auth, Docs, Billing)
│   ├── integrations/          # Supabase client configuration
│   ├── lib/                   # AI Registry, Storage & 4-tier Auto-Save
│   ├── pages/                 # React Router views (Dashboard, Workspace, Pricing)
│   └── test/                  # Vitest unit test suite (78 tests across 11 files)
├── supabase/                  # Database Migrations & Edge Functions
│   ├── functions/             # Cloud Edge Functions (Stripe Checkout & Webhook)
│   └── migrations/            # PostgreSQL migrations & limit triggers
└── tests/                     # Playwright E2E & Security Test Suite
```

---

## 7. Engineering Challenges and Technical Solutions

1. **Auto-Save Data Loss**: Solved using a 4-tier caching engine (1000ms debounce, optimistic lock queue, `sendBeacon`/`keepalive` unload guard, `BroadcastChannel` tab sync).
2. **Plaintext Key Storage**: Solved using `obf:` prefix obfuscation and optional `AES-256-GCM` encryption. Added clear UX warnings since keys stay in local browser storage.
3. **Graph Node Overlapping**: Solved by implementing horizontal Left-to-Right (`LR`) layout with `@dagrejs/dagre` and a 1-click Auto Layout button.
4. **Vercel Deep-Link 404 Errors**: Solved by adding `vercel.json` with rewrite rule `/(.*)` -> `/index.html` to direct deep-link route handling to index.html.
5. **Monolithic Bundle Size**: Solved by implementing route-level code splitting with `React.lazy()` in `App.tsx`, isolating Monaco and React Flow into separate chunks.
6. **Stripe Webhook Retries**: Solved using `stripe.webhooks.constructEventAsync` signature verification and recording event IDs in `public.stripe_events`.

---

## 8. Testing and Quality Assurance

- **Vitest Unit & Integration Suite (`src/test/`)**: 78 passing tests across 11 files covering AI provider registries, 2-pass reflection, 4-tier auto-save, key encryption, DB limits, and DB foreign key constraints (`SEC-08`). Command: `npm run test`.
- **Playwright E2E & Security Suite (`tests/e2e/`)**: E2E specs running on Chromium, Firefox, and WebKit covering auth redirects, editor functionality, system architect auto-layout, XSS injection prevention, and key obfuscation. Command: `npm run test:e2e`.
- **Build & Verification Gate**: All changes must pass `npx tsc --noEmit` (0 errors), `npm run test` (78/78 passing), and `npm run build` cleanly before deployment.
