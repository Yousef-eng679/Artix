# System Architecture — Artix

This document details the system design, component interactions, data persistence models, and security boundaries governing Artix.

---

## High-Level Architecture

```
[ Browser / Client ]
  │
  ├──► Local Storage Cache (AES-256-GCM / obf: Obfuscation)
  ├──► Monaco Editor & React Flow Canvas Engine
  │
  ├──► Vercel Edge Router (vercel.json SPA rewrite -> index.html)
  │
  ├──► Supabase Client (Auth & Postgres RLS Tables)
  │      ├── public.projects (FK -> auth.users)
  │      ├── public.documents
  │      ├── public.system_designs (FK -> auth.users)
  │      ├── public.subscriptions
  │      └── public.stripe_events (Webhook Idempotency)
  │
  ├──► Supabase Edge Functions (Deno Runtime)
  │      ├── create-checkout-session (Stripe Checkout)
  │      ├── create-portal-session (Stripe Customer Portal)
  │      └── stripe-webhook (Signature Verification & Idempotency)
  │
  └──► Direct AI Provider APIs (OpenAI / Anthropic / Gemini / Groq / Ollama)
```

---

## Core Subsystems

### 1. Document Forge & Storage Resilience
- **Monaco Editor Integration**: Embedded Monaco editor with synchronized Markdown and XML preview panels.
- **4-Tier Auto-Save Strategy**:
  1. *Debounced Storage*: 1000ms debounced save trigger (`debouncedSave.ts`).
  2. *Optimistic Lock Queue*: Version-tracked queue preventing parallel write collisions (`saveQueue.ts`).
  3. *Unload Protection*: Flushes unsaved edits via `navigator.sendBeacon` or `fetch({ keepalive: true })` on `beforeunload` (`tabCloseGuard.ts`).
  4. *Multi-Tab Sync*: `BroadcastChannel` leader election and remote tab updates (`multiTabSync.ts`).

### 2. System Architect & Graph Engine
- **React Flow (`@xyflow/react`)**: Graph canvas supporting custom nodes, double-click label editing, and freehand drawing overlays.
- **Topological Layout Engine (`@dagrejs/dagre`)**:
  - System Architect diagrams use horizontal Left-to-Right (`LR`) layout, routing flow from ingress/client nodes on the left to database nodes on the right.
  - Algorithm diagrams use Top-to-Bottom (`TB`) layout.
  - Includes a 1-click **Auto Layout** action on the canvas toolbar.

### 3. Performance & Route Code-Splitting
- **Lazy Route Loading**: Route-level code splitting using `React.lazy()` and `<Suspense fallback={<PageFallback />}>` in `src/App.tsx`.
- **Chunk Isolation**: Heavy editor packages (Monaco Editor and React Flow) are isolated into a separate `ProjectWorkspace` bundle (~561 kB), lowering the initial JavaScript entry chunk from 1.47 MB to ~613 kB.

### 4. AI Provider Integration & Refinement
- **BYOK Streaming Client (`registry.ts`)**: Direct browser-to-provider API client supporting OpenAI, Anthropic, Gemini, Groq, OpenRouter, and local Ollama servers.
- **Prompts**:
  - *PRD*: Agile, Technical Spec, Lean MVP, and Custom modes.
  - *Vibe Coding*: Artix and Cursor prompts enforcing relative paths (`[NEW]`, `[MODIFY]`) and validation checks.
  - *Architecture*: System and Algorithm visualizer prompts up to 40 nodes.
- **Reflection Pass (`refine.ts`)**: 2-pass critique flow that cleans up vague text and expands technical details.

### 5. Security & Key Storage
- **Key Obfuscation (`storage.ts`)**: API keys are saved to `localStorage` with an `obf:` prefix.
- **Optional Encryption (`crypto.ts`)**: `AES-256-GCM` encryption with `PBKDF2` key derivation (100,000 iterations). Decrypted keys reside only in volatile JavaScript memory during an active session. Includes a Reset Vault option if the passphrase is lost.
- **Browser Cache Warning**: UI alerts remind users to keep an external backup of their API keys because keys remain local to browser storage.

### 6. Billing & Tier Enforcement
- **Database Limits**: PostgreSQL trigger (`enforce_tier_limits_trigger.sql`) enforces Free tier quotas (3 projects, 10 documents, 3 system designs).
- **Foreign Keys**: `projects_user_id_fkey` and `system_designs_user_id_fkey` enforce `ON DELETE CASCADE` on `auth.users(id)` via migration `20260724060000`.
- **Stripe Edge Functions**:
  - `create-checkout-session`: Creates Stripe Checkout sessions.
  - `create-portal-session`: Generates Stripe Customer Portal URLs.
  - `stripe-webhook`: Verifies `Stripe-Signature` (`constructEventAsync`) and logs event IDs to `public.stripe_events` for idempotency.
