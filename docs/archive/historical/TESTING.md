# Testing and Quality Assurance Guide — Artix

This document details the testing architecture, test suites, execution commands, security tests, and Playwright E2E coverage for Artix.

---

## Testing Architecture Overview

Artix uses a dual-layer testing setup to verify business logic, security constraints, and user flows before deployment:

```
                      [ Artix Test Pipeline ]
                                │
        ┌───────────────────────┴───────────────────────┐
        ▼                                               ▼
[ Vitest Unit & Integration ]                [ Playwright E2E & Security ]
  • 78 Tests Across 11 Files                   • Multi-Browser Execution
  • Fast In-Memory Runner (~4s)                • Real Chromium, Firefox, WebKit
  • AI Prompts, Crypto, Auto-Save              • Auth, Dashboards, XSS & Security
```

---

## 1. Vitest Unit and Integration Suite (`src/test/`)

The Vitest suite verifies core business logic, encryption, prompt generation, auto-save queues, DB limits, and schema integrity.

### Test Files Breakdown (`src/test/`)
- `security.test.ts`: Key obfuscation (`obf:` prefix), CORS header validation, open redirect checks, DB tier limits, and DB foreign key constraint audit (`SEC-08`).
- `ai.test.ts`: BYOK provider registry (OpenAI, Anthropic, Gemini, Groq, Ollama), token pricing estimation, storage key migration.
- `ai-architecture.test.ts`: Context window limits, sibling project context injection, 2-pass reflection critique engine (`refine.ts`).
- `edge-cases.test.ts`: 4-tier auto-save engine (1000ms debounce, `saveQueue.ts` optimistic locking, `tabCloseGuard.ts` unload beacon, `multiTabSync.ts` BroadcastChannel leader election).
- `api-saving.test.ts`: Passphrase `AES-256-GCM` encryption, lock/unlock state transitions, and setting clearing.
- `billing.test.ts`: Stripe price IDs, Free vs Pro plan limits, 7-day grace period for past-due subscriptions.
- `ux-feedback.test.ts`: Optimistic UI cache mutation, Google OAuth config helper verification.
- `branding.test.ts`: Verification of Artix logo assets, dark theme canvas wrappers, and removal of legacy references.
- `remediation.test.ts`: Error boundary behavior and fallback handling.
- `ux.test.ts`: Navigation routing helper validation.
- `example.test.ts`: Environment sanity check.

### Running Vitest Commands
```bash
# Run all 78 unit tests once
npm run test

# Run tests in watch mode
npx vitest

# Run tests with verbose output
npx vitest run --reporter=verbose
```

---

## 2. Playwright E2E and Security Test Suite (`tests/e2e/`)

The Playwright suite executes browser end-to-end user journeys and security penetration checks across Chromium, Firefox, and WebKit.

### Test Suites Breakdown (`tests/e2e/`)

#### 1. `tests/e2e/auth.spec.ts` — Authentication and Routing
- **Unauthenticated Access**: Verifies unauthenticated users navigating to protected routes (`/dashboard`, `/settings`) are redirected to `/auth`.
- **Public Routes**: Verifies public access to landing page (`/`) and pricing page (`/pricing`).
- **REST Security**: Validates that direct API calls to Supabase REST endpoints without a JWT return `401 Unauthorized`.

#### 2. `tests/e2e/features.spec.ts` — Core User Journeys
- **Dashboard & Workspaces**: Verifies project creation, workspace navigation, and dark theme rendering.
- **Document Forge**: Verifies Monaco editor loading, text input, split-pane preview rendering, and format switching.
- **System Architect**: Verifies node graph canvas rendering, node creation, double-click label editing, and **Auto Layout** toolbar action.
- **AI Generators**: Verifies PRD modal, Vibe Coding target selection (Cursor / Artix), and prompt copy action.

#### 3. `tests/e2e/security.spec.ts` — Security and Penetration Testing
- **XSS Vector Injection**: Injects `<script>alert('xss')</script>` and `javascript:` payloads into input fields, verifying inputs are sanitized and escaped.
- **API Key Storage Protection**: Verifies that API keys stored in `localStorage` carry the `obf:` prefix and are never exposed in DOM attributes or logs.
- **Double-Click Protection**: Simulates rapid double-clicks on upgrade buttons to verify request debouncing and idempotency.

---

## Running Playwright Tests

### Prerequisites
Install Playwright browser binaries (one-time setup):
```bash
npx playwright install --with-deps
```

### Execution Commands
```bash
# Run all E2E tests headless across Chromium, Firefox, and WebKit
npm run test:e2e

# Run E2E tests in interactive UI mode
npm run test:e2e:ui

# View HTML Test Report after a run
npm run test:e2e:report
```

---

## Deployment Gate Standards

Before pushing code to production, all changes must pass:
1. `npx tsc --noEmit` — 0 TypeScript compilation errors.
2. `npm run test` — 78/78 Vitest unit tests passing.
3. `npm run build` — Clean production build.
