# Artix — The Developer's Command Center

<p align="center">
  <img src="public/artix-logo-banner.png" alt="Artix Logo" width="300" />
</p>

Artix is a modern, unified SaaS platform designed for software engineers, product leads, and architects. It combines multi-format technical documentation, visual system design, algorithm mapping, and high-signal AI prompt engineering into a single high-performance workspace.

---

## Core Capabilities

### 📄 Document Forge
- **Multi-Format Technical Editor**: Rich editor powered by Monaco Editor supporting Markdown, XML, and Plain Text formats.
- **Split-Pane Live Preview**: Synchronized Markdown and XML rendering with high-contrast syntax highlighting.
- **Resilient Auto-Save Engine**: Debounced background persistence, multi-tab sync via BroadcastChannel, and optimistic lock queueing.
- **Multi-Format Export**: One-click export to PDF, standalone HTML, and raw Markdown.

### 📐 System Architect
- **Interactive Visual Canvas**: Drag-and-drop node graph canvas powered by React Flow.
- **Architectural Node Library**: Specialized nodes for Microservices, API Gateways, PostgreSQL Databases, Message Queues, and Cache layers.
- **Curved Connections & Freehand Drawing**: Custom edge routing and freehand sketch overlays for rapid whiteboarding.
- **Canvas Export**: High-resolution PNG, SVG, and structured JSON diagram export.

### 🧠 AI Intelligence Suite
- **PRD Generator**: Generates sprint-ready Product Requirements Documents across 4 specialized modes:
  - **Agile Mode**: Behaviorally complete user stories, Given/When/Then Definition of Done, and T-shirt sizing with complexity justifications.
  - **Technical Spec Mode**: Executable PostgreSQL schemas, fully typed API endpoint specs with HTTP status codes, edge cases, and security rules.
  - **Lean MVP Mode**: Riskiest hypothesis identification, explicit scope cuts, and falsifiable validation metrics.
  - **Custom Mode**: Strictly honors custom user instructions and structural preferences.
- **Vibe Coding Prompt Generator**: Generates surgical, file-precise prompts for Cursor, Artix, Bolt.new, v0, and generic AI coders with explicit file actions (`[NEW]`, `[MODIFY]`), exact function signatures, and post-change verification commands.
- **Agentic Workflow Designer**: Blueprints multi-agent systems across 6 architectural patterns (Sequential, Parallel Fan-Out, Orchestrator-Workers, Router, Evaluator-Optimizer, Autonomous ReAct).
- **Reflection & Refinement Pass**: Built-in 2-pass critique engine (`refine.ts`) that purges generic filler prose ("ensure scalability", "TBD") and expands technical specifications.

### 🔐 BYOK Security & Key Obfuscation
- **Bring-Your-Own-Key (BYOK)**: Supports OpenAI, Anthropic Claude, Google Gemini, Groq, OpenRouter, and local Ollama servers.
- **Client-Side Encryption**: Optional AES-256-GCM encryption with PBKDF2 passphrase derivation, paired with automated client-side key obfuscation to prevent plaintext exposure in local storage.

### ⚡ Authoritative Local-First Sync & Offline Support
- **User-Partitioned IndexedDB**: Complete local authority with `ArtixDB_v2_<hash>` storage, enabling 100% offline creation, edits, and deletions without UI blocking.
- **Atomic 3-Table Mutations**: Every local action executes within a Dexie transaction across `[entity, outbox, sync_metadata]`.
- **Durable Background Sync**: Outbox queue with CAS version concurrency guards, crash recovery leases, and dependency-ordered topological cloud draining.
- **Change Feed & 3-Way Merge**: Remote changes stream through durable cursors; conflicts resolve via deterministic 3-way line diff3 merging.
- **Multi-Tab Leader Coordination**: Single-leader draining across open tabs via `BroadcastChannel` with duplicate broadcast suppression.
- **Progressive Web App**: ServiceWorker precaching for native installability and zero-network resilience.

## Documentation

For full platform specifications, API reference, architecture details, and changelog, see [DOCS.md](./DOCS.md).
