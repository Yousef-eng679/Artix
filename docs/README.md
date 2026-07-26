# Artix — The Developer's Command Center

Artix is a developer workspace platform that combines multi-format technical documentation, visual system design diagrams, algorithm state mapping, and structured AI prompt engineering.

---

## Core Capabilities

### Document Forge
- **Multi-Format Editor**: Technical text editor built on Monaco Editor supporting Markdown (`.md`), XML (`.xml`), and Plain Text (`.txt`).
- **Live Preview**: Split-pane preview rendering for Markdown and XML documents.
- **Auto-Save Engine**: 1000ms debounced storage, versioned queueing (`saveQueue.ts`), `sendBeacon`/`keepalive` unload protection (`tabCloseGuard.ts`), and multi-tab state synchronization (`multiTabSync.ts`).
- **Multi-Format Export**: Export options for PDF, standalone HTML, and raw Markdown files.

### System Architect
- **Visual Node Canvas**: Drag-and-drop architecture diagram editor built on `@xyflow/react` (React Flow).
- **Node Component Templates**: Pre-configured nodes for Microservices, API Gateways, PostgreSQL Databases, Message Queues, and Caches.
- **Horizontal Graph Layout (`LR`)**: Left-to-Right layout using `@dagrejs/dagre`, placing client nodes on the left and database/storage nodes on the right.
- **Auto Layout and Drawing**: 1-click auto-layout button to format nodes without overlap, plus an SVG freehand drawing overlay.

### AI Capabilities
- **PRD Generator**: Mode-based PRD generator supporting Agile, Technical Spec, Lean MVP, and Custom formats.
- **Vibe Coding Generator**: File-scoped prompt builder for Cursor, Artix, and generic AI coders with explicit `[NEW]` and `[MODIFY]` action tags and validation steps.
- **Agentic Workflow Designer**: Architecture visualizer for multi-agent execution patterns (Sequential, Parallel Fan-Out, Orchestrator-Workers, Router, Evaluator, Autonomous ReAct).
- **Refinement Pass**: Built-in 2-pass critique flow (`refine.ts`) that purges vague filler phrasing and expands specifications.

### Security and Key Storage
- **Bring-Your-Own-Key (BYOK)**: Supports OpenAI, Anthropic, Gemini, Groq, OpenRouter, and local Ollama instances.
- **Browser-Local Protection**: API keys are stored in `localStorage` with `obf:` prefix obfuscation and optional `AES-256-GCM` encryption. Since keys remain in the browser, users are advised to store backups externally.

### Authentication and Billing
- **Authentication**: Supports 1-click Google OAuth and email/password authentication via Supabase Auth.
- **Stripe Subscriptions**: Free plan quotas enforced by database triggers; Pro upgrades handled via Supabase Edge Functions (`create-checkout-session`, `create-portal-session`, `stripe-webhook`).

---

## Tech Stack

- **Frontend**: React 18, Vite 5, TypeScript, Tailwind CSS, shadcn/ui, Framer Motion
- **Editor and Canvas**: Monaco Editor (`@monaco-editor/react`), `@xyflow/react` (React Flow), `@dagrejs/dagre`
- **Backend & Database**: Supabase PostgreSQL with Row Level Security, Auth, Triggers
- **Routing & Edge**: Vercel SPA rewrites (`vercel.json`), Supabase Cloud Edge Functions (Deno / TypeScript)
- **Testing**: Vitest (78 unit/integration tests), Playwright (E2E & security specs)
