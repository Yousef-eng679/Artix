# Project File Structure — Artix

This document maps out the repository file organization and component responsibilities across the Artix codebase.

---

## Root Directory Layout

```
c:/Fenix-main/
├── DOCS.md                    # Consolidated Technical Specification
├── vercel.json                # Vercel SPA Routing Rewrite Configuration
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
│   ├── favicon.png
│   ├── pwa-192x192.png
│   ├── pwa-512x512.png
│   ├── robots.txt
│   ├── llms.txt               # AI Web Agent indexing spec (llmstxt.org)
│   └── llms-full.txt          # Full AI Agent technical capabilities spec
├── src/                       # Frontend React Application Source
│   ├── assets/                # App images & branding logos
│   ├── components/            # Reusable UI components & AI Dialogs
│   │   ├── AI/                # PRD, Vibe Coding, Agentic & Arch AI Dialogs
│   │   ├── Editor/            # Monaco Editor & Split-Pane Previewers
│   │   ├── SystemArchitect/   # React Flow Canvas, Auto-Layout & Drawing
│   │   └── ui/                # shadcn/ui primitives
│   ├── hooks/                 # Custom React hooks (Auth, Docs, Billing)
│   ├── integrations/          # Supabase client initialization
│   ├── lib/                   # Core business logic & utilities
│   │   ├── ai/                # BYOK AI Registry, Storage & Prompts
│   │   └── cache/             # 4-tier Auto-Save caching engines
│   ├── pages/                 # React Router page views
│   ├── test/                  # Vitest unit test suite (78 tests across 11 files)
│   ├── App.tsx                # App root router & React.lazy route splitting
│   ├── index.css              # Global Design System tokens & HSL variables
│   └── main.tsx               # React entrypoint
├── supabase/                  # Database & Cloud Architecture
│   ├── functions/             # Cloud Edge Functions (Stripe Checkout & Webhook)
│   └── migrations/            # PostgreSQL schema migrations & FK constraints
├── tests/                     # Playwright E2E & Security Test Suite
│   └── e2e/                   # E2E test specs (auth, features, security)
├── package.json               # Dependencies, scripts, package metadata
├── playwright.config.ts       # Playwright multi-browser test configuration
├── tailwind.config.ts         # Tailwind CSS configuration
├── tsconfig.json              # TypeScript compiler configuration
├── vite.config.ts             # Vite build & PWA configuration
└── vitest.config.ts           # Vitest test runner configuration
```

---

## Key Module Directory Breakdowns

### `src/lib/ai/` — AI Engine & BYOK Core
- `registry.ts`: Direct browser streaming client for OpenAI, Anthropic, Gemini, Groq, OpenRouter, and Ollama.
- `storage.ts`: API Key loading, `obf:` obfuscation, and decryption logic.
- `crypto.ts`: `AES-256-GCM` encryption with `PBKDF2` key derivation.
- `refine.ts`: 2-pass critique engine (`streamRefinement`) purging vague phrasing.
- `prompts/prd.ts`: System prompts for Agile, Technical Spec, Lean MVP, and Custom PRDs.
- `prompts/vibe.ts`: System prompts for Artix and Cursor Vibe Coding.
- `prompts/architecture.ts`: System prompts for Cloud Infrastructure and Algorithm visualizers up to 40 nodes.

### `src/lib/cache/` — Auto-Save Data Resilience
- `debouncedSave.ts`: 1000ms debounced save trigger.
- `saveQueue.ts`: Optimistic locking queue preventing parallel write collisions.
- `tabCloseGuard.ts`: `navigator.sendBeacon` and `keepalive` fetch unload guard.
- `multiTabSync.ts`: `BroadcastChannel` leader election and remote tab sync.

### `src/components/SystemArchitect/` — Visual Graph Engine
- `SystemArchitect.tsx`: React Flow canvas container with Left-to-Right (`LR`) Dagre auto-layout.
- `ArchitectNode.tsx`: Custom React Flow node component with color accents and icons.
- `AlgorithmNodeTemplates.ts`: Pre-defined node templates for systems and algorithms.
- `DrawingCanvas.tsx`: SVG freehand drawing overlay canvas.

### `supabase/` — Database & Cloud Infrastructure
- `migrations/20260723120000_enforce_tier_limits_trigger.sql`: Free tier quota triggers.
- `migrations/20260723130000_grant_admin_pro_tier.sql`: Admin Pro tier migration.
- `migrations/20260724060000_add_missing_user_fk_constraints.sql`: Foreign key constraints (`projects_user_id_fkey`, `system_designs_user_id_fkey`) on `auth.users(id) ON DELETE CASCADE`.
- `functions/_shared/cors.ts`: Dynamic CORS header utility.
- `functions/create-checkout-session/index.ts`: Stripe Checkout session Edge Function.
- `functions/create-portal-session/index.ts`: Stripe Customer Portal Edge Function.
- `functions/stripe-webhook/index.ts`: Idempotent Stripe Webhook Edge Function.
