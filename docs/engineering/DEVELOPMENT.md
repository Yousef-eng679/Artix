# Engineering Guidelines & Development Standards

> **Status**: `IMPLEMENTED`  
> **Target**: Post-C12 Development Guidelines

---

## 1. Local Development Setup

### System Prerequisites
- **Node.js**: v18.0.0 or higher
- **Package Manager**: npm v9+ (or bun/pnpm for running scripts)
- **Database**: Active Supabase project (URL and Anon key configured in `.env`)

### Initial Environment Setup
```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and supply:
# VITE_SUPABASE_URL=...
# VITE_SUPABASE_PUBLISHABLE_KEY=...

# 3. Start development server
npm run dev
# Vite server starts at http://localhost:8080
```

---

## 2. TypeScript Strictness Standards

Artix strictly enforces full TypeScript typing:
- `strict: true` in `tsconfig.json`.
- Zero unchecked `any` assertions in core synchronization or repository code.
- Runtime data boundaries (IndexedDB deserialization, REST responses, localStorage reads) are guarded by **Zod schemas** or runtime type predicates.

---

## 3. Crash Containment via React Error Boundaries

All critical component trees are wrapped with `src/components/ErrorBoundary.tsx`:
- Monaco Editor crashes (e.g. malformed syntax or worker failures) are contained to the editor pane; the sidebar, tabs, and system design canvas continue running.
- React Flow canvas crashes do not crash the document editor.
- The boundary renders a graceful "Something went wrong" recovery UI with a "Try Again" button that clears volatile buffer state without wiping persisted IndexedDB records.

---

## 4. Git Commit Conventions

Commits follow the Conventional Commits standard:
- `feat(sync/phase-cN): ...` — Protocol and sync feature rollouts.
- `fix(workspace): ...` — Workspace bug fixes.
- `test(sync): ...` — Test additions and updates.
- `docs(architecture): ...` — Canonical documentation updates.
- `chore: ...` — Dependency upgrades and maintenance.
