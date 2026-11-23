# Engineering Guidelines & Development Standards

> **Status**: `IMPLEMENTED`  
> **Version**: `v2.5.0`  
> **Verified Against**: `package.json`, `vite.config.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`, `src/App.tsx`, `src/lib/local/db.ts`

---

## 1. Local Development Setup

### System Prerequisites
- **Node.js**: **v20 LTS** recommended (matches `.github/workflows/ci.yml` `node-version: 20`)
- **Package Manager**: `npm` v10+ (lockfile tracked via `package-lock.json`)
- **Database**: Active Supabase project (URL and publishable anon key configured in `.env.local` or `.env`)

### Initial Environment Setup
```bash
# 1. Install dependencies
npm install

# 2. Configure environment (.env.local is recommended; .env is also supported by Vite)
cp .env.example .env.local
# Edit .env.local and supply the ONLY two frontend environment variables:
# VITE_SUPABASE_URL="https://<project-ref>.supabase.co"
# VITE_SUPABASE_PUBLISHABLE_KEY="<supabase-anon-public-key>"

# 3. Start development server
npm run dev
# Vite server starts at http://localhost:8080 (Service Worker disabled in dev via devOptions.enabled: false)
```

---

## 2. Verification & Build Scripts (`package.json`)

All verification gates executed in `.github/workflows/ci.yml` can be run locally:

```bash
# Static analysis & type-checking
npm run lint          # ESLint flat-config check across TypeScript/React sources
npx tsc --noEmit      # Full TypeScript typecheck

# Layer 1 & 2: Unit, repository, UI, and controllable fake-server fault-injection tests (107 files / 698 tests)
npm run test          # vitest run
npm run test:watch    # Interactive Vitest watch mode

# Layer 3: Real PostgreSQL 17 / PGlite concurrency, CAS, billing & RLS verification (6/6 tests)
# Uses pg.Pool when DATABASE_URL is set (CI postgres:17-alpine), or embedded @electric-sql/pglite locally (zero Docker required)
npm run test:pg       # vitest run src/test/postgres/backendConcurrencyAndRls.pg.test.ts

# Production PWA bundle build & local preview
npm run build         # vite build (outputs dist/ with Workbox sw.js + bundled Monaco + Fontsource assets)
npm run preview       # Serves production dist/ on http://localhost:8080

# Layer 4: Production PWA Playwright E2E suite (18 Chromium specs passing; 2 live-endpoint checks skipped under dummy env)
# Automatically runs `npm run build && npm run preview` on http://localhost:8080 with `serviceWorkers: 'allow'`
npm run test:e2e
```

---

## 3. TypeScript & Architectural Boundary Standards

- **Strict Typing**: Core synchronization, repository, billing policy, and cryptographic modules enforce explicit domain interfaces (`src/lib/local/types.ts`, `src/types/workspace.ts`) without unchecked boundary casts.
- **Runtime Boundary Validation**: IndexedDB deserialization, `localStorage` persistence (`tabPersistence.ts`, `draftCache.ts`, `offlineSession.ts`), and Edge Function payloads are guarded by Zod schemas or explicit runtime type predicates.
- **Zero-Network Workspace UI Guard**: `src/test/architecture/networkBoundary.test.ts` statically verifies that workspace UI components/hooks never bypass Dexie repositories to mutate synced tables (`projects`, `documents`, `system_designs`, `workspace_folders`) and permanently bans legacy `/api/save` or `navigator.sendBeacon` calls.

---

## 4. Crash Containment & Local Database Inspection

### Application Error Boundary (`src/components/ErrorBoundary.tsx`)
- Wraps the `<Suspense><Routes>` tree at the application root in `src/App.tsx`.
- Renders a graceful recovery UI (`Try Again` / `Reload Page`) that resets transient React state without clearing uncommitted records in IndexedDB or `localStorage` crash-recovery drafts.

### Local Database Inspection (Browser DevTools)
- Open **Application -> Storage -> IndexedDB** in Chromium/Firefox DevTools.
- Each authenticated user is isolated inside `ArtixDB_v2_<8-char-fnv1a-hash>` (`ArtixDB` schema `version(3)` in `src/lib/local/db.ts`) containing **8** object stores:
  1. `projects`
  2. `documents`
  3. `system_designs`
  4. `workspace_folders`
  5. `outbox`
  6. `sync_metadata`
  7. `conflicts`
  8. `database_meta` (holds `server_cursor`, `hydration_complete`, `legacy_migration`, `cached_subscription`, and `cached_ai_generations`)

---

## 5. Git Commit Conventions

Commits follow Conventional Commits:
- `feat(sync): ...` / `feat(billing): ...` — Synchronization, CAS, offline, and billing capabilities.
- `fix(workspace): ...` — Bug fixes across editor, canvas, or sync runtime.
- `test(sync): ...` / `test(postgres): ...` — Unit, fault-injection, PostgreSQL, and Playwright E2E suites.
- `docs: ...` — Canonical documentation updates.
- `chore: ...` — Dependency upgrades and CI maintenance.
