# Artix — Product Requirements Document (PRD)

Target Release: v1.5.0 (Reconciled with v2.5.0 Local-First Architecture — see [`docs/README.md`](../docs/README.md) for Tier 2 Canonical Specifications)

---

## 1. Product Vision and Overview

Artix is a SaaS developer workspace designed to combine technical documentation, visual system architecture diagrams, algorithm mapping, and structured AI prompt generation into a single web application.

Developers often switch between different apps — writing Markdown specs in one tool, drawing architecture diagrams in another, and generating code prompts in a third. Artix brings these together:
- **Document Forge**: Multi-format text editor (Markdown, XML, Plain Text) with Monaco Editor and live split-pane preview.
- **System Architect**: Interactive React Flow diagram canvas with Left-to-Right (`LR`) Dagre auto-layout.
- **AI Tools**: PRD Generator, file-precise Vibe Coding prompts (Cursor and Artix targets), and Agentic Workflow visualizer.
- **BYOK Key Model**: Bring-Your-Own-Key model with client-side `AES-256-GCM` encryption and optional passphrase protection.

---

## 2. Target Audience and Core Use Cases

### 1. The Full-Stack Developer
- **Needs**: Write feature specs, generate file-precise Vibe Coding prompts with explicit action tags (`[NEW]`, `[MODIFY]`), and verify code against `npx tsc --noEmit`.
- **Pain Points**: Vague AI code output that hallucinates non-existent imports or breaks type contracts.

### 2. The System Architect
- **Needs**: Visual canvas to map microservices, databases, and message queues with Left-to-Right data flow and 1-click auto-layout.
- **Pain Points**: Overlapping nodes and messy connector lines in traditional drawing tools.

### 3. The Technical Product Lead
- **Needs**: Generate sprint-ready PRDs with user stories, acceptance criteria, and technical specs without generic filler phrasing.
- **Pain Points**: Spending hours writing manual documentation templates.

---

## 3. Functional Requirements

### FR-1: Document Forge (Spec Editor)
- **FR-1.1 Multi-Format Support**: Monaco editor instance supporting `.md` (Markdown), `.xml` (XML), and `.txt` (Plain Text).
- **FR-1.2 Live Preview**: Synchronized split-pane HTML rendering for Markdown and XML documents.
- **FR-1.3 Auto-Save & Local-First Engine**: 1000ms debounced persistence into user-scoped Dexie IndexedDB (`ArtixDB_v2_<hash>`) + `expectedLocalRevision` stale-buffer guard (`StaleBufferError`) + local-only `tabCloseGuard.ts` draft flush to user-scoped `localStorage` + `BroadcastChannel` multi-tab sync (`TabCoordinator`).
- **FR-1.4 Multi-Format Export**: Export options for raw `.md`/`.xml`/`.txt` (all tiers) and standalone `.html` / print-ready `.pdf` (Pro tier).

### FR-2: System Architect (Visual Graph Engine)
- **FR-2.1 Graph Canvas**: React Flow graph canvas with custom nodes for Microservices, Databases, Message Queues, API Gateways, and Caches.
- **FR-2.2 Horizontal Auto-Layout**: 1-click **Auto Layout** action arranging graph nodes with Left-to-Right layout (`rankdir: 'LR'`) and generous spacing (`nodesep: 110`, `ranksep: 200`).
- **FR-2.3 Freehand Sketch Overlay**: SVG drawing canvas for quick annotations and sketching.

### FR-3: AI Capabilities
- **FR-3.1 PRD Generator**: Mode-based PRD generator supporting Agile, Technical Spec, Lean MVP, and Custom formats.
- **FR-3.2 Vibe Coding Prompt Generator**: Generates file-scoped prompts for Artix and Cursor IDE targets.
- **FR-3.3 Refinement Pass (`refine.ts`)**: 2-pass critique flow that cleans up vague phrasing and expands concrete specs.
- **FR-3.4 Agentic Workflow Designer**: Architecture visualizer for 6 multi-agent patterns (Sequential, Fan-Out, Orchestrator-Workers, Router, Evaluator, ReAct).

### FR-4: Security and Key Storage
- **FR-4.1 Key Obfuscation**: Stored keys automatically receive `obf:` prefix prior to `localStorage` write.
- **FR-4.2 AES-256-GCM Encryption**: Optional `PBKDF2-SHA256` passphrase-derived encryption (600,000 iterations for `v: 2` saves; legacy `v: 1` 250,000 iterations supported for decryption), keeping decrypted keys in volatile JS memory during active sessions.
- **FR-4.3 Reset Key Vault Recovery**: Allows users who lost their passphrase to reset the encrypted vault and enter fresh keys.
- **FR-4.4 Backup Warnings**: UI alert notices and save toasts remind users to store external backups of their API keys since keys remain local to browser storage.

### FR-5: Authentication and Billing
- **FR-5.1 Authentication**: 1-click Google OAuth (`signInWithGoogle`) and email/password authentication via Supabase Auth.
- **FR-5.2 Free Tier Quotas**: Max 3 active projects, 10 documents, 3 system designs, and 5 AI generations/month (enforced by serialized PostgreSQL trigger `check_plan_tier_limit()` and offline Dexie counts). Foreign key constraints enforce `ON DELETE CASCADE` on `auth.users(id)`.
- **FR-5.3 Pro Tier (\$8/mo or \$72/yr)**: Up to 100 active projects and unlimited documents, designs, and AI generations. Managed via Stripe Checkout, Customer Portal, and atomic `reconcile_stripe_subscription` webhook Edge Functions (strict `past_due -> free` fail-closed policy, `GRACE_PERIOD_DAYS = 0`), plus RLS-protected `public.manual_grants`.

---

## 4. Non-Functional Requirements (NFRs)

- **NFR-1 Security**: Zero plaintext API keys on GitHub or server logs; dynamic CORS origin protection; signature verification on Stripe webhooks.
- **NFR-2 Performance**: Route-level code splitting using `React.lazy()` in `App.tsx` isolates Monaco and React Flow into separate chunks (~561 kB), shrinking initial JS bundle size from 1.47 MB to ~613 kB (~58% reduction). Production build finishes in under 10 seconds.
- **NFR-3 Routing Reliability**: Vercel SPA rewrite configuration in `vercel.json` (`/(.*)` -> `/index.html`) prevents edge `404 NOT_FOUND` errors on direct URL refreshes.
- **NFR-4 Accessibility**: W3C semantic landmarks (`<main id="main-content">`) and explicit `aria-label` attributes on navigation buttons.
- **NFR-5 Agentic Indexing**: `/public/llms.txt` and `/public/llms-full.txt` spec compliance for AI web search indexing.
- **NFR-6 Testing Coverage**: 107 passing Vitest unit/integration/fault-injection test files (698 tests), Layer 3 real PostgreSQL 17 / PGlite concurrency & RLS suite (6/6 tests), and Layer 4 Playwright production PWA E2E browser tests (18 Chromium specs).
