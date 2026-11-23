# Testing Architecture & Verification Protocols

> **Status**: `IMPLEMENTED`  
> **Version**: `v2.5.0`  
> **Test Suite Counts**: **107 Vitest files / 698 unit & fault-injection tests passing**, **6/6 PostgreSQL concurrency & RLS tests passing**, **18 Playwright Chromium E2E specs passing** (`2` live-endpoint checks skipped under dummy env)

---

## 1. 4-Layer Verification Architecture

In a local-first distributed workspace with Stripe entitlements and offline PWA caching, isolated unit tests alone cannot prove end-to-end correctness. Artix enforces a **4-layer verification matrix** in `.github/workflows/ci.yml` (`lint`, `typecheck`, `test`, `postgres-concurrency`, `build`, `e2e`):

1. **Layer 1 — Unit, Repository, Crypto & Component Suite (`npm run test`)**  
   Executes pure algorithm suites (`diff3` 3-way merge, FNV-1a scoping, outbox compaction algebra, `errorTaxonomy`, `billingPolicy`, `PBKDF2` `v: 2` / `v: 1` compatibility, `sanitizeMarkdownUrl`), multi-table Dexie repository transactions on `fake-indexeddb`, React component/hook suites, and static architectural boundary guards (`src/test/architecture/networkBoundary.test.ts`).
2. **Layer 2 — Controllable Fake-Server Distributed Fault Injection (`npm run test`)**  
   Deterministic multi-client / multi-tab fault-injection harnesses (`src/test/sync/controllableFakeServerFaultInjection.test.ts` and `src/test/sync/correctnessMatrix.test.ts`) simulating dropped responses after server commit, duplicate replays, mid-flight crashes & Web Lock lease steals, per-entity causal barriers, HTTP `429` `Retry-After` backoff, and `sync_changes` retention-floor re-snapshots.
3. **Layer 3 — Real PostgreSQL 17 Concurrency, CAS, Billing & RLS (`npm run test:pg`)**  
   `src/test/postgres/backendConcurrencyAndRls.pg.test.ts` (`6/6` passing) boots a clean schema by applying all **25** SQL migrations in `supabase/migrations/` and executes concurrent barriers against real `postgres:17-alpine` via `pg.Pool` when `DATABASE_URL` is provided in CI, or embedded `@electric-sql/pglite` locally with zero external dependencies.
4. **Layer 4 — Production PWA Playwright E2E (`npm run test:e2e`)**  
   `playwright.config.ts` builds and serves the real production bundle (`npm run build && npm run preview` on `http://localhost:8080` with `serviceWorkers: 'allow'`), executing `tests/e2e/{auth,features,security,offlineColdStartAndSyncMatrix}.spec.ts` (`18` Chromium specs passing; `2` live-Supabase checks skipped when running against the hermetic dummy env).

---

## 2. Test Execution Commands

```bash
# Layer 1 & Layer 2: Full Vitest suite (107 files / 698 tests)
npm run test

# Run a targeted fault-injection or sync matrix file
npx vitest run src/test/sync/controllableFakeServerFaultInjection.test.ts
npx vitest run src/test/sync/correctnessMatrix.test.ts

# Layer 3: Real PostgreSQL / PGlite SQL migration, concurrency, CAS, billing & RLS suite (6/6 tests)
npm run test:pg

# Layer 4: Production build + Workbox PWA + Playwright Chromium E2E suite
npm run test:e2e

# Static analysis & TypeScript checks
npm run lint
npx tsc --noEmit
```

---

## 3. Test Infrastructure Guidelines (`src/test/setup.ts`)

- **Isolated In-Memory IndexedDB**: `fake-indexeddb/auto` backs `ArtixDB` (`version(3)`) in Node.js without disk leakage between test cases.
- **Hermetic Edge Function Guard**: `FunctionsClient.prototype.invoke` is intercepted in `src/test/setup.ts` so unit tests never leak live OS DNS/HTTP requests.
- **Dual-Backend SQL Harness (`backendConcurrencyAndRls.pg.test.ts`)**: Uses `pg.Pool` with multi-connection barriers when `DATABASE_URL` is configured (CI `postgres:17-alpine` service container), and transparently falls back to `@electric-sql/pglite` for instant local developer runs.

---

## 4. Key Distributed & Backend Invariants Verified

| Verification Area | Scenarios Covered | Core Invariant Proven |
|---|---|---|
| **Idempotent Atomic CAS (`apply_sync_mutation`)** | Lost HTTP response after server commit; concurrent stale `p_base_version`; missing/invalid CAS baseline (`22023`) | Duplicate `mutationId` returns cached outcome without double-incrementing `version`; stale updates return structured `version_mismatch` / `remote_deleted` / `already_exists` conflicts. |
| **Self-Echo & Revision Safety** | Local edit $N+1$ typed while push $N$ is in flight; subsequent `sync_changes` pull carrying own `mutation_id` | Push acknowledgement updates `serverVersion` while keeping `syncState = 'pending'`; `PullEngine` suppresses self-echoes via `lastAckedMutationId`. |
| **Causal Barrier & Offline Project Graph** | Offline `create project` -> `create folder` -> `create document` + `create design` -> reconnect | `OutboxRepository.getPending({ readyOnly: true })` + topological ordering pushes parent `project` and `folder` before dependent children without FK violations. |
| **Lease Fencing & Tab Crash Recovery** | Tab A crashes mid-push; Tab B acquires Web Lock / recovers stale lease; delayed Tab A promise resolves | `leaseToken` fencing prevents a stale tab from mutating `outbox` or `sync_metadata` after losing ownership. |
| **Change-Feed Pruning & Re-Snapshot** | `prune_sync_changes()` advances `min_retained_sequence` past an offline client's `server_cursor` | `PullEngine.syncPull()` detects `cursor < minRetainedSequence` via `get_sync_feed_bounds()` and runs `resnapshotAll()` without resurrecting pending local deletes or clobbering dirty drafts. |
| **Billing Reconciliation & Quota Triggers** | Out-of-order Stripe webhooks (`payment_failed` vs `invoice.paid`), duplicate `stripe_event_id`, `past_due` status, concurrent Free-tier inserts | `reconcile_stripe_subscription()` serializes updates, enforces `GRACE_PERIOD_DAYS = 0` (`past_due` -> `'free'`), honors `manual_grants`, and `check_plan_tier_limit()` enforces `3` projects / `10` docs / `3` designs / `5` monthly AI runs on Free (`100` projects on Pro). |
| **PWA Offline Cold-Start Continuity** | Hard reload (`page.reload()`) with `context.setOffline(true)` and an expired cached JWT | Service Worker serves precached shell + bundled Monaco + local fonts (`0` external CDN requests), `recoverOfflineSessionFromStorage()` restores user workspace access, and edits queue cleanly until reconnect. |
