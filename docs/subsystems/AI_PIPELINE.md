# AI Intelligence Suite & Prompt Engineering Pipeline

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/ai/`, `src/components/AI/PRDGeneratorDialog.tsx`, `src/components/AI/VibeCodingDialog.tsx`, `src/components/AI/AgenticWorkflowDialog.tsx`, `src/components/AI/ArchitectureGeneratorDialog.tsx`

---

## 1. Overview

Artix includes an engineering-grade AI prompt compilation pipeline. Rather than outputting conversational responses, Artix treats AI as a **specification generator**: producing sprint-ready PRDs, executable SQL migrations, architectural blueprints, and file-precise prompts for agentic coding tools (Cursor, Claude Code, Antigravity, Bolt.new).

---

## 2. Multi-Provider Architecture (`src/lib/ai/`)

Artix decouples prompt generation from specific AI providers via `src/lib/ai/registry.ts`:

```text
┌────────────────────────────────────────────────────────┐
│               Prompt Generator Dialogs                 │
│  (PRDGeneratorDialog, VibeCodingDialog,                │
│   AgenticWorkflowDialog, ArchitectureGeneratorDialog)  │
└───────────────────────────┬────────────────────────────┘
                            │ Structured Prompt Request
                            ▼
┌────────────────────────────────────────────────────────┐
│            AI Provider Gateway (`registry.ts`)         │
│          - Model routing (`callAI`, `streamAI`)        │
│          - Primary -> Backup automatic failover        │
│          - SSE token streaming reader (`streaming.ts`) │
└───────────────────────────┬────────────────────────────┘
                            │ BYOK API Call
                            ▼
┌────────────────────────────────────────────────────────┐
│               Frontier AI Providers                    │
│                                                        │
│  - OpenAI (GPT-4o, GPT-4o-mini)                        │
│  - Anthropic (Claude 3.5 Sonnet, Claude 3 Opus)        │
│  - Google Gemini (Gemini 1.5 Pro, Flash)               │
│  - Groq (Llama-3.3-70B high-throughput inference)      │
│  - OpenRouter (Unified multi-model aggregator)         │
│  - Ollama (Local offline inference via localhost:11434)│
└────────────────────────────────────────────────────────┘
```

---

## 3. Streaming Pipeline (`streaming.ts`) & Failover (`registry.ts`)

AI generation streams tokens progressively to the client using Server-Sent Events (SSE):

- **Delta Parser (`parseSSE`)**: Splits raw byte streams into UTF-8 lines, parsing `data:` JSON frames and `[DONE]` sentinels via `ReadableStreamDefaultReader`.
- **Automatic Backup Failover**: If the user configures both `primary` and `backup` provider credentials in `AISettingsCard.tsx`, `callAI` and `streamAI` in `src/lib/ai/registry.ts` automatically fail over to the backup provider if the primary provider throws a network or rate-limit error.
- **Quota Enforcement**: Free tier accounts are capped at **5 AI generations/month**, enforced client-side (`useUsageLimits.tsx`, with offline monthly count cached in `ArtixDB.database_meta['cached_ai_generations']`) and server-side by the `check_plan_tier_limit()` trigger across `prd_generations`, `vibe_generations`, and `agentic_workflows`.

---

## 4. The 2-Pass Reflection Engine (`refine.ts`)

A key differentiator of Artix is the **Automated Critique & Refinement Pass** (`streamRefinement`):

```text
Pass 1: Initial Generation
User Prompt ──► Frontier LLM ──► Raw Draft
                                    │
                                    ▼
Pass 2: The Refinement Pass (`refine.ts`)
Critique Rules Engine:
- Purge generic filler phrases ("ensure scalability", "TBD", "clean code")
- Demand concrete PostgreSQL table definitions with primary/foreign keys
- Require explicit HTTP status codes on every API endpoint (200, 201, 400, 404, 409)
- Specify exact file actions (`[NEW]`, `[MODIFY]`) with relative paths
- Include runnable verification commands (`npm test`, `tsc --noEmit`)
                                    │
                                    ▼
Frontier LLM ◄── Critique Injected ─┘
                                    │
                                    ▼
Final Engineering Specification Output
```

---

## 5. Domain Prompt Compilers (`src/components/AI/` & `src/lib/ai/prompts/`)

### 5.1 PRD Generator (`src/components/AI/PRDGeneratorDialog.tsx` + `prompts/prd.ts`)
Generates structured product requirements across 4 operational modes:
- **Agile Sprint Mode**: Behaviorally complete user stories, Given/When/Then acceptance criteria, T-shirt sizing with complexity justifications.
- **Technical Spec Mode**: Full PostgreSQL database DDL schemas, typed API endpoint contracts with request/response payloads, and security requirements.
- **Lean MVP Mode**: Riskiest hypothesis mapping, explicit non-goals (scope cuts), and falsifiable validation metrics.
- **Custom Mode**: User-directed structure and custom organizational standards.

### 5.2 Vibe Coding Prompt Compiler (`src/components/AI/VibeCodingDialog.tsx` + `prompts/vibe.ts`)
Designed to output prompts that external coding agents execute with surgical precision:
- Maps the project's folder layout into the system prompt.
- Emits explicit action tags: `[NEW] src/components/NewFeature.tsx`, `[MODIFY] src/hooks/useData.ts`.
- Mandates TypeScript interfaces and prohibits placeholders (`// TODO: implement later`).
- Generates post-implementation verification commands.

### 5.3 Agentic Workflow Designer (`src/components/AI/AgenticWorkflowDialog.tsx` + `prompts/agentic.ts`)
Blueprints multi-agent autonomous systems across 6 architectural patterns:
1. **Sequential Pipeline**: Linear chain of specialized agents.
2. **Parallel Fan-Out / Fan-In**: Concurrent task execution with aggregator.
3. **Orchestrator-Workers**: Dynamic delegate assignment.
4. **Router Pattern**: Intent classification and conditional branching.
5. **Evaluator-Optimizer**: Generator agent paired with critique loop.
6. **Autonomous ReAct**: Reasoning + Action loop with tool use.

### 5.4 System & Algorithm Architecture Generator (`src/components/AI/ArchitectureGeneratorDialog.tsx` + `prompts/architecture.ts`)
Generates structured JSON `BoardState` node-and-edge graphs directly onto the `SystemArchitect` canvas, automatically laid out via `@dagrejs/dagre` (`LR` for System architectures, `TB` for Algorithm flows).
