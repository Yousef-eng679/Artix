# AI Intelligence Suite & Prompt Engineering Pipeline

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/lib/ai/`, `src/pages/PRDGenerator.tsx`, `src/pages/VibeCoding.tsx`, `src/pages/AgenticWorkflow.tsx`

---

## 1. Overview

Artix includes an engineering-grade AI prompt compilation pipeline. Rather than outputting conversational responses, Artix treats AI as a **specification generator**: producing sprint-ready PRDs, executable SQL migrations, architectural blueprints, and file-precise prompts for agentic coding tools (Cursor, Claude Code, Antigravity, Bolt.new).

---

## 2. Multi-Provider Architecture (`src/lib/ai/`)

Artix decouples prompt generation from specific AI providers:

```text
┌────────────────────────────────────────────────────────┐
│                   Prompt Generators                    │
│      (PRD Generator, Vibe Coding, Agentic Workflow)    │
└───────────────────────────┬────────────────────────────┘
                            │ Structured Prompt Request
                            ▼
┌────────────────────────────────────────────────────────┐
│               AI Service Gateway (`service.ts`)        │
│          - Model routing                               │
│          - Rate-limiting & timeout control             │
│          - Token streaming reader                      │
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

## 3. Streaming Pipeline (`streaming.ts`)

AI generation streams tokens progressively to the client using Server-Sent Events (SSE):

- **Delta Parser**: Splits raw byte streams into UTF-8 chunks, parsing standard `data: {"choices": [{"delta": {"content": "..."}}]}` payloads.
- **Connection Timeout Guard**: Automatically detects stalled sockets (30-second inactivity timeout) and gracefully preserves the partially generated draft.
- **AbortController**: Users can halt generation instantly with a "Stop Generating" action, canceling the active HTTP fetch request without UI freeze.

---

## 4. The 2-Pass Reflection Engine (`refine.ts`)

A key differentiator of Artix is the **Automated Critique & Refinement Pass**:

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

## 5. Domain Prompt Compilers

### 5.1 PRD Generator (`src/pages/PRDGenerator.tsx`)
Generates structured product requirements across 4 operational modes:
- **Agile Sprint Mode**: Behaviorally complete user stories, Given/When/Then acceptance criteria, T-shirt sizing with complexity justifications.
- **Technical Spec Mode**: Full PostgreSQL database DDL schemas, typed API endpoint contracts with request/response payloads, and security requirements.
- **Lean MVP Mode**: Riskiest hypothesis mapping, explicit non-goals (scope cuts), and falsifiable validation metrics.
- **Custom Mode**: User-directed structure and custom organizational standards.

### 5.2 Vibe Coding Prompt Compiler (`src/pages/VibeCoding.tsx`)
Designed to output prompts that external coding agents execute with surgical precision:
- Maps the project's folder layout into the system prompt.
- Emits explicit action tags: `[NEW] src/components/NewFeature.tsx`, `[MODIFY] src/hooks/useData.ts`.
- Mandates TypeScript interfaces and prohibits placeholders (`// TODO: implement later`).
- Generates post-implementation verification commands.

### 5.3 Agentic Workflow Designer (`src/pages/AgenticWorkflow.tsx`)
Blueprints multi-agent autonomous systems across 6 architectural patterns:
1. **Sequential Pipeline**: Linear chain of specialized agents.
2. **Parallel Fan-Out / Fan-In**: Concurrent task execution with aggregator.
3. **Orchestrator-Workers**: Dynamic delegate assignment.
4. **Router Pattern**: Intent classification and conditional branching.
5. **Evaluator-Optimizer**: Generator agent paired with critique loop.
6. **Autonomous ReAct**: Reasoning + Action loop with tool use.
