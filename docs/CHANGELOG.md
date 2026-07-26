# Changelog — Artix

All notable changes to the Artix platform are documented below.

---

## [v1.5.0] — 2026-07-25

### Authentication and Security
- **Google OAuth Integration**: Added 1-click Google OAuth authentication (`signInWithGoogle`) in `useAuth.tsx` and added the Google Sign-In button to `Auth.tsx`.
- **Database Foreign Key Integrity**: Applied migration `20260724060000_add_missing_user_fk_constraints.sql` adding foreign key constraints `projects_user_id_fkey` and `system_designs_user_id_fkey` on `auth.users(id) ON DELETE CASCADE`.
- **Accessibility Fixes**: Added explicit `aria-label` tags to icon buttons across `Dashboard.tsx`, `ProjectWorkspace.tsx`, and `Settings.tsx`.

### Deployment and Performance
- **Vercel SPA Routing**: Created `vercel.json` with SPA rewrite rules (`/(.*)` -> `/index.html`) to resolve deep-link 404 errors on Vercel edge deployment.
- **Route Code-Splitting**: Implemented route-level code splitting using `React.lazy()` and static `<Suspense>` fallbacks in `App.tsx`, lowering initial entry bundle size from 1.47 MB to ~613 kB.

### UX Updates
- **API Key Storage Warning**: Added clear UX warning notices in `AISettingsCard.tsx` reminding users to maintain external backups of API keys because keys stay in browser storage.

---

## [v1.4.0] — 2026-07-23

### UI and Accessibility
- **Hero Section Clean-up**: Removed sub-hero file format badges from `Index.tsx`.
- **Accessibility Landmarks**: Added `<main id="main-content">` semantic landmark wrapper.
- **AI Crawling Specs**: Added `/public/llms.txt` and `/public/llms-full.txt` for AI web agent indexing.
- **Key Recovery**: Added Reset Vault dialog to locked encryption panel in `AISettingsCard.tsx`.

---

## [v1.3.0] — 2026-07-23

### System Architect and Canvas
- **Horizontal Dagre Layout (`LR`)**: Switched graph positioning to horizontal Left-to-Right layout, routing connections from client nodes on the left to database nodes on the right.
- **Auto Layout Button**: Added 1-click Auto Layout toolbar action on System Architect.
- **Node Capacity**: Expanded diagram token limit and increased maximum node capacity to 40 nodes.

---

## [v1.2.0] — 2026-07-23

### Prompts and Reflection Pass
- **System Prompts**: Integrated prompts for PRD Generator and Vibe Coding (Artix and Cursor targets).
- **Refinement Pass (`refine.ts`)**: Built 2-pass critique flow that cleans up vague phrasing and expands technical details.

---

## [v1.1.0] — 2026-07-23

### Billing and Subscriptions
- **Stripe Edge Functions**: Built `create-checkout-session`, `create-portal-session`, and `stripe-webhook` Edge Functions.
- **Database Quota Triggers**: Applied `enforce_tier_limits_trigger.sql` migration enforcing Free plan limits (3 projects, 10 documents, 3 designs).

---

## [v1.0.0] — 2026-07-22

### Initial Platform Setup
- **Rebranding**: Completed rebrand to Artix.
- **BYOK Protection**: Added `obf:` key obfuscation and `AES-256-GCM` passphrase encryption.
- **Auto-Save Engine**: Built 4-tier auto-save architecture (1000ms debounce, optimistic queue, sendBeacon/keepalive unload guard, BroadcastChannel tab sync).
- **Test Suite**: Added Vitest unit test suite and Playwright E2E testing suite in `tests/e2e/`.
