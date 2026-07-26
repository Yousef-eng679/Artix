# Challenges Faced and Technical Solutions — Artix

This document logs major engineering challenges, security vulnerabilities, edge cases, and performance bottlenecks encountered during the development of Artix, along with their implemented technical solutions.

---

## Challenge 1: Auto-Save Data Loss & Race Conditions

### Problem
Rapid typing in Monaco Editor or quick edits on the System Architect canvas triggered concurrent auto-save requests. This caused out-of-order database writes (stale content overwriting newer edits) and data loss when closing browser tabs.

### Technical Solution
Built a **4-Tier Auto-Save Engine**:
1. **Debounce Engine (`debouncedSave.ts`)**: 1000ms debounce trigger to batch rapid keystrokes.
2. **Optimistic Locking Queue (`saveQueue.ts`)**: Version counter (`version`) and serial queue ensure write operations execute sequentially and stale updates are rejected.
3. **Unload Protection (`tabCloseGuard.ts`)**: Flushes unsaved drafts via `navigator.sendBeacon` or `fetch({ keepalive: true })` on `beforeunload`.
4. **Multi-Tab Sync (`multiTabSync.ts`)**: `BroadcastChannel` leader election ensures only one tab issues network save requests while secondary tabs receive state updates via broadcast.

---

## Challenge 2: API Key Storage and User Cache Loss

### Problem
Storing raw API keys in browser `localStorage` created security risks. In addition, because keys stay in browser storage, clearing browser data removes stored keys.

### Technical Solution
1. **Automated Obfuscation**: Keys are stored in `localStorage` with an `obf:` prefix prior to writing.
2. **AES-256-GCM Encryption**: Optional passphrase encryption using `AES-256-GCM` with a 100,000-iteration `PBKDF2` derived key. Decrypted keys reside only in volatile JavaScript memory during active sessions.
3. **Reset Key Vault Action**: Added a Reset Vault option to the locked settings panel in `AISettingsCard.tsx` so users can clear encrypted blobs if they forget their passphrase.
4. **UX Backup Notice**: Added an inline warning alert and save toast notice informing users that keys stay local to browser storage, encouraging them to keep an external backup.

---

## Challenge 3: Node Overlapping in System Architect

### Problem
Auto-generating graph diagrams with 15–40 nodes using basic grid positioning caused connection lines to cross sibling node boxes, obscuring labels.

### Technical Solution
Integrated a **Topological Rank-Based Layout Engine (`@dagrejs/dagre`)**:
1. **Horizontal Layout (`LR`)**: Set `rankdir: 'LR'` for System Architect diagrams, routing connections cleanly from client nodes on the left to database nodes on the right.
2. **Spacing Configuration**: Set `ranksep: 200` and `nodesep: 110` with rounded smoothstep connectors (`borderRadius: 16`).
3. **Auto Layout Button**: Added a 1-click **Auto Layout** action on the canvas toolbar to format nodes automatically.

---

## Challenge 4: Vercel Edge Deep-Link 404 Errors

### Problem
Directly navigating to sub-routes (such as `/dashboard` or `/projects/:id`) or refreshing deep links on Vercel deployments returned edge-network `404 NOT_FOUND` errors (`fra1::...` header format) because Vercel looked for static file routes instead of delegating to client-side React Router.

### Technical Solution
Added `vercel.json` to the project root with SPA rewrite rules:
```json
{
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "/index.html"
    }
  ]
}
```
This routes all non-static asset paths back to `/index.html`, allowing React Router to handle deep-link routing.

---

## Challenge 5: Monolithic Bundle Size & Initial Render Delays

### Problem
Static imports of heavy libraries (Monaco Editor `@monaco-editor/react` and React Flow `@xyflow/react`) inside main entry files inflated the production JavaScript bundle to 1.47 MB, dragging down First Contentful Paint (FCP) and Largest Contentful Paint (LCP) performance metrics.

### Technical Solution
Implemented **Route-Level Code Splitting (`React.lazy` & `Suspense`)**:
1. Lazy-loaded page routes in `src/App.tsx` (`ProjectWorkspace`, `Dashboard`, `Settings`, `Pricing`, etc.).
2. Wrapped routes in `<Suspense fallback={<PageFallback />}>` using a static, hook-free spinner component.
3. Isolated Monaco and React Flow into a dedicated `ProjectWorkspace` bundle (~561 kB), shrinking the main entry bundle from 1.47 MB to ~613 kB (~58% payload reduction).

---

## Challenge 6: User Foreign Key Integrity in PostgreSQL

### Problem
Original database schemas lacked explicit foreign key constraints on `projects.user_id` and `system_designs.user_id` referencing `auth.users(id)`. This created risks of orphaned rows if a user account was deleted.

### Technical Solution
Created migration `supabase/migrations/20260724060000_add_missing_user_fk_constraints.sql`:
1. Wrapped constraint creation in idempotent `DO $$ BEGIN IF NOT EXISTS ... END $$;` blocks.
2. Added `projects_user_id_fkey` and `system_designs_user_id_fkey` foreign key constraints referencing `auth.users(id) ON DELETE CASCADE`.
3. Added automated Vitest test (`SEC-08` in `src/test/security.test.ts`) to verify foreign key constraint definitions.

---

## Challenge 7: Stripe Webhook Idempotency & Signature Forgery

### Problem
Handling serverless Stripe webhooks can lead to duplicate processing if Stripe retries event delivery, or unauthorized calls if webhooks aren't verified.

### Technical Solution
Built **Supabase Edge Functions (`supabase/functions/stripe-webhook/`)**:
1. **Signature Verification**: Validates incoming POST requests against raw request bodies using `stripe.webhooks.constructEventAsync`.
2. **Idempotency Tracking**: Records processed webhook event IDs in `public.stripe_events`. Duplicate event IDs return an immediate `200 OK` without repeating database operations.
