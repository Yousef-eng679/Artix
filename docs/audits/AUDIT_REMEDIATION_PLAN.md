# Artix — Engineering Audit Remediation & Atomic Implementation Plan

**Source Audit:** [`2026-10-12_REPOSITORY_AUDIT.md`](./2026-10-12_REPOSITORY_AUDIT.md) (Reviewed revision: `main` at `0e5ab3549ef26ef34b1ffdff4b937378d2b1afdb`)  
**Target Branch:** `fix/audit-remediation-plan` (branched directly from `origin/main` without modifying `main`)  
**Execution Strategy:** Step-by-step atomic tasks with isolated verification and granular local commits before pushing to a new Pull Request.

---

## 0. Plan Review Corrections (applied before execution)

The first draft of this plan was reviewed against the code before any file was edited. The corrections below supersede the original task text where they conflict.

| # | Area | Correction | Evidence |
|---|---|---|---|
| R1 | Plan location | Plan and audit live in `docs/audits/`, not the repository root (documentation governance: no planning documents in root). | `docs/README.md` governance rules |
| R2 | TASK-01 | Drop the proposed `user_sync_cursors` table. A transaction-scoped per-user advisory lock taken in `record_sync_change()` before the identity value is allocated is sufficient: the lock is held until commit, so for a given user, allocation order equals commit order. Caveat: a single transaction that touches rows in an order that conflicts with another transaction can now deadlock; PostgreSQL detects it and aborts one side, which the client retries. | `pg_advisory_xact_lock` semantics; PullEngine always filters by `user_id` |
| R3 | TASK-04 | No migration creates `workspace_folders.parent_folder_id`, yet `WorkspaceFolderPushAdapter` writes it. The RPC migration adds it idempotently (`ADD COLUMN IF NOT EXISTS`, nullable, no FK) so the RPC cannot fail at runtime. | `20260923213000_workspace_folders.sql`; `folderPushAdapter.ts` L23, L44–45 |
| R4 | TASK-04 | RPC is `SECURITY INVOKER` so existing RLS policies on entity tables and `processed_mutations` remain the authorization boundary. A `create` whose row already exists without a matching ledger record returns `conflict` (never silently overwrites or silently acknowledges divergent content). | RLS migrations |
| R5 | TASK-05/06 | If the RPC is not yet deployed (PostgREST `PGRST202` / "Could not find the function"), the client falls back to the legacy request path so rollout order does not break sync. The legacy fallback is documented as degraded mode; the proposed read-before-upsert guard is dropped because it is not atomic and would only mask the defect. | — |
| R6 | TASK-08 | `billingPolicy.ts` must not reference `Deno` at module scope so Vitest/tsc can import it (same pattern as `_shared/cors.ts`, already imported by `security.test.ts`). Env lookup is injected. | `src/test/security.test.ts` L5 |
| R7 | TASK-10 | Additional webhook defects: raw Stripe statuses (`trialing`, `unpaid`, `incomplete_expired`) violate the `subscriptions.status` CHECK constraint; DB write errors are ignored and the event is still recorded, so Stripe never retries. Map statuses and return 500 on write failure. | `20260722180000_stripe_billing.sql` L15–16 |
| R8 | TASK-16 | `react-markdown@10.1.0` already applies `defaultUrlTransform` (allows only `http(s)`, `irc(s)`, `mailto`, `xmpp`, relative URLs). The real defect is documentation claiming DOMPurify (README, `SECURITY_MODEL.md`, `WORKSPACE_AND_EDITOR.md`, `PROJECT_STATUS.md`). Code change is limited to making the transform explicit and adding a regression test. | `node_modules/react-markdown/lib/index.js` L124, L320, L421 |
| R9 | TASK-14 | Workbox does not delete runtime caches when a rule is removed, so the legacy `supabase-api-cache` is also purged once at application boot, not only on sign-out. | Workbox runtime cache lifecycle |
| R10 | Verification | No local PostgreSQL/Supabase instance is available. SQL changes are verified with static migration audits (existing `security.test.ts` pattern) plus in-memory concurrency models; live two-transaction reproduction remains a documented follow-up. | — |

---

## 1. Audit Findings vs. Codebase Verification Matrix

| Finding / Section | Audit Claim | Codebase Verification Status | Exact Code Evidence & Technical Blast-Radius Notes |
| :--- | :--- | :--- | :--- |
| **F-001** (High / P1)<br>Change-feed cursor skips late-committing lower sequences | `sync_changes.sequence` uses `GENERATED ALWAYS AS IDENTITY`, which is allocated before commit; `PullEngine` advances `server_cursor` to `maxAppliedSequence`, skipping earlier-allocated sequences that commit later. | **Confirmed** | - `supabase/migrations/20260928130000_durable_sync_changes.sql` (lines 6–20, 45–109) defines `sequence BIGINT GENERATED ALWAYS AS IDENTITY` without per-user commit serialization in `record_sync_change()`.<br>- `src/lib/sync/pullEngine.ts` (lines 101–125, 311–321) filters `.eq('user_id', userId).gt('sequence', currentCursor)` and commits `maxAppliedSequence`.<br>- **Resolution:** Serialize per-user sequence allocation using a transaction-duration exclusive per-user lock (`user_sync_cursors` row lock + `pg_advisory_xact_lock`) inside `record_sync_change()` before sequence allocation so two transactions for the same user can never allocate sequences and commit out of order. |
| **F-002** (Medium / P1)<br>Caller-controlled Stripe `priceId` & unvalidated webhook entitlement | Checkout Edge Function passes client `priceId` directly to Stripe; webhook grants `plan_tier: 'pro'` without checking the purchased price ID, interval, or status. | **Confirmed** | - `src/pages/Pricing.tsx` (lines 18–28) and `src/components/UpgradePrompt.tsx` (lines 21–27) send `{ priceId, origin }` from browser state.<br>- `supabase/functions/create-checkout-session/index.ts` (lines 35–86) does not validate `priceId` against a server-owned allowlist.<br>- `supabase/functions/stripe-webhook/index.ts` (lines 44–80) upserts `plan_tier: 'pro'` on `checkout.session.completed` without checking `subscription.items.data[0]?.price.id`. Also `stripe_events` recording (lines 107–112) uses plain `.insert()` rather than conflict-safe deduplication. |
| **F-003** (Medium / P1)<br>Remote mutation and idempotency ledger are non-atomic | `checkIdempotency`, entity mutation, and `recordIdempotency` run in separate HTTP requests; lost response after mutation commit causes duplicate execution on retry. | **Confirmed** | - `src/lib/sync/adapters/idempotency.ts` (lines 8–62) performs separate `.select()` and `.upsert()` calls and ignores `{ error }` on `.upsert()`.<br>- `DocumentPushAdapter`, `SystemDesignPushAdapter`, and `WorkspaceFolderPushAdapter` use `.upsert()` on `create` before calling `recordIdempotency`.<br>- **Blast-Radius Note:** `src/test/architecture/networkBoundary.test.ts` statically asserts `.from('documents')` etc. in adapter files, and 15+ sync unit tests pass lightweight `.from()` mocks without `.rpc()`. Adapters must dispatch via atomic server RPC (`apply_sync_mutation`) when `supabase.rpc` is present while preserving a hardened fallback for lightweight `.from()` test mocks. |
| **F-004** (Medium / P1)<br>Broad Workbox caching of `*.supabase.co` responses | `vite.config.ts` caches `^https:\/\/.*\.supabase\.co\/.*` with `NetworkFirst`, making authenticated API responses eligible for shared browser Cache Storage. | **Confirmed** | - `vite.config.ts` (lines 44–53) configures `supabase-api-cache` across all `*.supabase.co` URLs.<br>- Workspace offline persistence is already served by account-scoped IndexedDB (`ArtixDB_v2_<hash>`). Removing authenticated Supabase API caching from Workbox and purging legacy API caches on sign-out/account switch eliminates cross-session cache reuse risk. |
| **F-005** (Medium / P2)<br>Concurrent inserts can race database tier limits | `check_plan_tier_limit()` runs `SELECT COUNT(*)` without per-user serialization before insert. | **Confirmed** | - `supabase/migrations/20260723120000_enforce_tier_limits_trigger.sql` (lines 14–48) counts rows without locking.<br>- Must serialize per user via `pg_advisory_xact_lock` inside `check_plan_tier_limit()` and exclude soft-deleted rows (`deleted_at IS NULL`) on `documents` and `system_designs`. |
| **F-006** (Low / P2)<br>Playwright missing from `package.json` & CI | `package.json` has `test:e2e` and `playwright.config.ts` imports `@playwright/test`, but `@playwright/test` is absent from `package.json` and CI does not run E2E. | **Confirmed** | - `package.json` lacks `@playwright/test`; `.github/workflows/ci.yml` has no E2E job.<br>- `tests/e2e/auth.spec.ts`, `features.spec.ts`, and `security.spec.ts` also require deterministic offline/CI-safe mocks when `VITE_SUPABASE_URL` is `https://dummy.supabase.co`. |
| **F-007** (Low / P3)<br>`PullEngine` `continue` branches skip cursor update | Two `continue` statements in `pullBatch` jump past `maxAppliedSequence` update, causing repeated pulls of already-handled events. | **Confirmed** | - `src/lib/sync/pullEngine.ts` lines 166–186 (concurrent delete convergence) and lines 257–266 (tombstone non-resurrection guard) execute `continue` before lines 311–313 (`if (change.sequence > maxAppliedSequence)`). |
| **SS-01 & SS-08**<br>Runtime open failure state & Markdown sanitization docs | 1. `UserSyncRuntimeProvider` swallows `openUserRuntime` failure into `isDegraded: false, runtimeError: null`.<br>2. `useAuth` initial `getSession()` can race with `onAuthStateChange`.<br>3. `MarkdownPreview.tsx` uses `react-markdown` without `javascript:` URL guard while docs claim `DOMPurify`. | **Confirmed** | - `src/contexts/UserSyncRuntimeContext.tsx` (lines 71–76, 99–116) resets `isDegraded: false` when `runtime === null`.<br>- `src/hooks/useAuth.tsx` (lines 81–100) unconditionally overwrites session state when `getSession()` resolves.<br>- `src/components/Editor/MarkdownPreview.tsx` (lines 86–90) needs explicit safe-URI protocol filtering and documentation alignment. |

---

## 2. Atomic Tasks & Commit Plan

### Phase 1: Sync Change-Feed & Cursor Correctness (`F-001`, `F-007`)

#### `TASK-01` — Per-User Commit-Ordered Sequence Allocation Migration
- **Addresses:** `F-001` (High / P1)
- **Files:**
  - `[CREATE]` `supabase/migrations/20261020100000_commit_ordered_sync_changes.sql`
- **Changes:**
  - Create `public.user_sync_cursors` table (`user_id UUID PRIMARY KEY`, `last_sequence BIGINT NOT NULL DEFAULT 0`, `updated_at TIMESTAMPTZ`) with RLS enabled.
  - Backfill `public.user_sync_cursors` from existing `public.sync_changes`.
  - Update `public.record_sync_change()` to acquire a transaction-duration exclusive per-user lock (`pg_advisory_xact_lock(hashtext('sync_changes_seq:' || v_user_id::text))` and `user_sync_cursors` upsert lock) *before* sequence allocation and insert into `public.sync_changes`.
- **Commit:** `fix(sync/f-001): serialize per-user change-feed sequence allocation with commit order`

#### `TASK-02` — Unconditional Per-Row Cursor Advancement in `PullEngine.pullBatch`
- **Addresses:** `F-007` (Low / P3), `F-001`
- **Files:**
  - `[MODIFY]` `src/lib/sync/pullEngine.ts`
- **Changes:**
  - Extract single-row application in `PullEngine.pullBatch` into `applySingleChange` or wrap in `try ... finally` so that every processed, converged, or intentionally ignored row (including concurrent delete convergence and stale update on tombstone) unconditionally updates `maxAppliedSequence = Math.max(maxAppliedSequence, change.sequence)`.
- **Commit:** `fix(sync/f-007): advance pull cursor unconditionally across all continue branches`

#### `TASK-03` — Regression Tests for Commit-Order Serialization & `PullEngine` Cursor Branches
- **Addresses:** `F-001`, `F-007`
- **Files:**
  - `[MODIFY]` `src/test/sync/pullEngine.test.ts`
- **Changes:**
  - Add unit tests proving cursor advancement when a pull batch contains only a concurrent delete convergence event or only a stale update on a local tombstone.
  - Add concurrency simulation test proving that per-user lock serialization prevents out-of-order sequence visibility from skipping late-committing transactions.
- **Commit:** `test(sync/f-001,f-007): add pull cursor branch advancement and commit-order regression tests`

---

### Phase 2: Atomic Server-Side Mutation Idempotency (`F-003`)

#### `TASK-04` — Atomic Server-Side Sync Mutation & Idempotency RPC Migration
- **Addresses:** `F-003` (Medium / P1)
- **Files:**
  - `[CREATE]` `supabase/migrations/20261020110000_atomic_idempotent_mutation_rpc.sql`
- **Changes:**
  - Define `public.apply_sync_mutation(p_mutation_id UUID, p_user_id UUID, p_entity_type TEXT, p_entity_id UUID, p_operation TEXT, p_payload JSONB, p_base_version INTEGER)` in PostgreSQL.
  - Verify `auth.uid() = p_user_id`, acquire transaction advisory lock on `p_mutation_id`, check `public.processed_mutations` for an existing record, execute entity `create` (safe `ON CONFLICT (id) DO NOTHING` to prevent overwriting newer edits on replay), `update` (CAS version guard), or `delete` (CAS version guard), and write `public.processed_mutations` atomically in the same transaction.
- **Commit:** `feat(sync/f-003): add atomic apply_sync_mutation rpc with transactional idempotency ledger`

#### `TASK-05` — Upgrade `idempotency.ts` with Atomic RPC Dispatcher & Error-Checked Fallback
- **Addresses:** `F-003`
- **Files:**
  - `[MODIFY]` `src/lib/sync/adapters/idempotency.ts`
- **Changes:**
  - Add `executeAtomicMutation(entry, supabase)` that dispatches `supabase.rpc('apply_sync_mutation', ...)` wrapped in `withTimeout` when `typeof supabase?.rpc === 'function'`, translating `{ status: 'conflict' }` into a 409 `CONFLICT` error.
  - Harden `recordIdempotency` fallback to inspect `{ error }` returned by `.upsert()` and throw/handle errors properly.
- **Commit:** `fix(sync/f-003): add atomic rpc dispatcher and check ledger upsert errors in idempotency helper`

#### `TASK-06` — Integrate Atomic RPC & Non-Overwriting Create Guard Across Push Adapters
- **Addresses:** `F-003`
- **Files:**
  - `[MODIFY]` `src/lib/sync/adapters/documentPushAdapter.ts`
  - `[MODIFY]` `src/lib/sync/adapters/systemDesignPushAdapter.ts`
  - `[MODIFY]` `src/lib/sync/adapters/folderPushAdapter.ts`
  - `[MODIFY]` `src/test/architecture/networkBoundary.test.ts`
- **Changes:**
  - Wire `executeAtomicMutation` as the primary path in all three entity push adapters while retaining the `.from(...)` fallback for unit tests using lightweight `.from()` mocks.
  - Guard the fallback `create` path against overwriting an already-modified remote entity on retry after a lost response.
- **Commit:** `fix(sync/f-003): wire atomic mutation rpc and safe create replay across entity push adapters`

#### `TASK-07` — Fault-Injection Tests for Lost-Response & Post-Create Edit Replay
- **Addresses:** `F-003`
- **Files:**
  - `[MODIFY]` `src/test/sync/idempotentMutation.test.ts`
- **Changes:**
  - Add fault-injection test simulating response loss after server commit (both via atomic RPC and fallback path) verifying zero duplicate execution on retry.
  - Add fault-injection test verifying that a retried `create` after a lost response never overwrites a subsequent `version = 2` remote update.
- **Commit:** `test(sync/f-003): add lost-response and post-create update fault-injection tests`

---

### Phase 3: Billing Trust-Boundary & Quota Serialization (`F-002`, `F-005`)

#### `TASK-08` — Shared Authoritative Server-Side Billing Plan & Price Policy
- **Addresses:** `F-002` (Medium / P1)
- **Files:**
  - `[CREATE]` `supabase/functions/_shared/billingPolicy.ts`
- **Changes:**
  - Create server-owned price allowlist mapping (`monthly` and `annual` Stripe Price IDs, intervals, and amounts) and export pure validation functions `resolveAllowedCheckoutPrice` and `validateSubscriptionEntitlement`.
- **Commit:** `feat(billing/f-002): add authoritative server-side stripe price allowlist and entitlement policy`

#### `TASK-09` — Enforce Server Price Allowlist in `create-checkout-session`
- **Addresses:** `F-002`
- **Files:**
  - `[MODIFY]` `supabase/functions/create-checkout-session/index.ts`
  - `[MODIFY]` `src/pages/Pricing.tsx`
  - `[MODIFY]` `src/components/UpgradePrompt.tsx`
- **Changes:**
  - Validate caller-supplied `priceId` / `billingCycle` against `resolveAllowedCheckoutPrice` in `create-checkout-session/index.ts`, rejecting unknown or unauthorized Price IDs with HTTP 400 before calling Stripe.
  - Attach `plan_tier: 'pro'` and `billing_cycle` to Stripe subscription metadata.
- **Commit:** `fix(billing/f-002): enforce server-side price allowlist in create-checkout-session`

#### `TASK-10` — Validate Purchased Price in `stripe-webhook` & Harden Event Deduplication
- **Addresses:** `F-002`
- **Files:**
  - `[MODIFY]` `supabase/functions/stripe-webhook/index.ts`
- **Changes:**
  - Verify subscription price ID, billing interval, and status via `validateSubscriptionEntitlement` before granting `plan_tier: 'pro'` in `checkout.session.completed` and `customer.subscription.updated`.
  - Use conflict-safe `.upsert(..., { onConflict: 'stripe_event_id', ignoreDuplicates: true })` when recording processed `stripe_events`.
- **Commit:** `fix(billing/f-002): validate purchased price in stripe-webhook and harden event deduplication`

#### `TASK-11` — Serialize Per-User Database Tier-Limit Trigger Migration
- **Addresses:** `F-005` (Medium / P2)
- **Files:**
  - `[CREATE]` `supabase/migrations/20261020120000_serialize_tier_limits_trigger.sql`
- **Changes:**
  - Update `public.check_plan_tier_limit()` to acquire `pg_advisory_xact_lock(hashtext('tier_limit:' || NEW.user_id::text))` prior to counting rows, and exclude soft-deleted rows (`deleted_at IS NULL`) when counting `documents` and `system_designs`.
- **Commit:** `fix(db/f-005): serialize per-user tier limit trigger with transaction advisory lock`

#### `TASK-12` — Unit & Concurrency Tests for Billing Policy and Tier Quota Enforcement
- **Addresses:** `F-002`, `F-005`
- **Files:**
  - `[MODIFY]` `src/test/billing.test.ts`
  - `[MODIFY]` `src/test/security.test.ts`
- **Changes:**
  - Add unit tests for `resolveAllowedCheckoutPrice` and `validateSubscriptionEntitlement` covering valid plans, tampered price IDs, non-active statuses, and webhook deduplication.
  - Add concurrent quota-enforcement simulation and migration audit tests in `src/test/security.test.ts`.
- **Commit:** `test(billing,security/f-002,f-005): add price allowlist, webhook entitlement, and quota race tests`

---

### Phase 4: PWA Cache Isolation, Auth/Runtime Resilience & Security Hardening (`F-004`, `SS-01`, `SS-08`)

#### `TASK-13` — Remove Broad Authenticated Supabase API Caching from Workbox Configuration
- **Addresses:** `F-004` (Medium / P1)
- **Files:**
  - `[MODIFY]` `vite.config.ts`
- **Changes:**
  - Remove the `^https:\/\/.*\.supabase\.co\/.*` `NetworkFirst` runtime caching rule from `vite.config.ts` so authenticated REST, Auth, and Edge Function responses are never stored in shared browser `CacheStorage`.
- **Commit:** `fix(pwa/f-004): remove broad supabase api runtime caching from workbox config`

#### `TASK-14` — Purge Legacy Service-Worker API Caches on Sign-Out & Account Switch
- **Addresses:** `F-004`
- **Files:**
  - `[MODIFY]` `src/lib/sync/userSyncRuntime.ts`
  - `[MODIFY]` `src/hooks/useAuth.tsx`
- **Changes:**
  - Add `clearSensitiveBrowserCaches()` to purge any `supabase-api-cache` entries from `window.caches` during `closeUserRuntime()` and `SIGNED_OUT`.
- **Commit:** `fix(security/f-004): purge service-worker api caches on sign-out and runtime teardown`

#### `TASK-15` — Fix `useAuth` Initialization Race & Surface `openUserRuntime` Failure State
- **Addresses:** `SS-01`
- **Files:**
  - `[MODIFY]` `src/hooks/useAuth.tsx`
  - `[MODIFY]` `src/contexts/UserSyncRuntimeContext.tsx`
  - `[CREATE]` `src/test/hooks/authRuntimeLifecycle.test.tsx`
- **Changes:**
  - Prevent initial `getSession()` in `useAuth.tsx` from overwriting a newer `onAuthStateChange` event (`SIGNED_OUT` / `SIGNED_IN`) that fired while `getSession()` was in flight.
  - Preserve and expose `isDegraded: true` and `runtimeError` in `UserSyncRuntimeProvider` when `openUserRuntime()` rejects.
  - Add unit tests in `src/test/hooks/authRuntimeLifecycle.test.tsx`.
- **Commit:** `fix(auth,runtime/ss-01): guard getSession init race and expose runtime open failures`

#### `TASK-16` — Harden `MarkdownPreview` Link Protocol Sanitization & Reconcile Security Docs
- **Addresses:** `SS-08`
- **Files:**
  - `[MODIFY]` `src/components/Editor/MarkdownPreview.tsx`
  - `[MODIFY]` `SECURITY.md`
  - `[MODIFY]` `docs/security/SECURITY_MODEL.md`
  - `[MODIFY]` `docs/subsystems/WORKSPACE_AND_EDITOR.md`
  - `[MODIFY]` `src/test/security.test.ts`
- **Changes:**
  - Add `sanitizeMarkdownHref` in `MarkdownPreview.tsx` blocking `javascript:`, `vbscript:`, and `data:` protocols on rendered links.
  - Reconcile security documentation to accurately describe `react-markdown` AST escaping + URI protocol filtering and default `obf:` key obfuscation vs. opt-in AES-GCM-256 vault encryption.
- **Commit:** `fix(security/ss-08): enforce safe markdown link protocols and reconcile security docs`

---

### Phase 5: Reproducible Playwright E2E Suite & CI Integration (`F-006`)

#### `TASK-17` — Add `@playwright/test` & Make E2E Specs Deterministic for Clean CI
- **Addresses:** `F-006` (Low / P2)
- **Files:**
  - `[MODIFY]` `package.json`
  - `[MODIFY]` `package-lock.json`
  - `[MODIFY]` `playwright.config.ts`
  - `[MODIFY]` `tests/e2e/auth.spec.ts`
  - `[MODIFY]` `tests/e2e/features.spec.ts`
  - `[MODIFY]` `tests/e2e/security.spec.ts`
- **Changes:**
  - Add `@playwright/test` to `devDependencies` in `package.json` and lockfile.
  - Configure `playwright.config.ts` and E2E specs with deterministic mocked Supabase auth/API routes when running in CI with `https://dummy.supabase.co`.
- **Commit:** `fix(e2e/f-006): add @playwright/test dependency and deterministic ci mocks for e2e suite`

#### `TASK-18` — Wire Playwright E2E Job into GitHub Actions CI & Final Verification
- **Addresses:** `F-006`
- **Files:**
  - `[MODIFY]` `.github/workflows/ci.yml`
  - `[MODIFY]` `docs/audits/AUDIT_REMEDIATION_PLAN.md` (execution log)
- **Changes:**
  - Add E2E verification job in `.github/workflows/ci.yml`.
  - Record per-task execution results and verify all gates (`tsc --noEmit`, `npm run lint`, `npx vitest run`, `npm run build`, `npx playwright test --list`).
- **Commit:** `ci(e2e/f-006): add playwright e2e job to github actions workflow`


---

## 3. Execution & Verification Log

All 18 atomic tasks were executed sequentially on `fix/audit-remediation-plan` (branched from `origin/main` at `0e5ab3549ef26ef34b1ffdff4b937378d2b1afdb`; `main` untouched).

| Task | Finding(s) | Commit | Summary of Verified Changes |
| :--- | :--- | :--- | :--- |
| Plan Setup | Governance (`R1`–`R10`) | `ce5626a` | Added repository audit and reviewed atomic remediation plan under `docs/audits/`. |
| `TASK-01` | `F-001` | `14ae47b` | Serialized per-user `sync_changes.sequence` allocation with `pg_advisory_xact_lock` in `record_sync_change()`. |
| `TASK-02` | `F-007`, `F-001` | `9cf5c1d` | Advanced `maxAppliedSequence` unconditionally at loop entry in `PullEngine.pullBatch`. |
| `TASK-03` | `F-001`, `F-007` | `eb08cfe` | Added cursor branch-advancement and commit-order serialization tests (`pullCursorCommitOrder.test.ts`). |
| `TASK-04` | `F-003` | `3abca73` | Added `public.apply_sync_mutation` (`SECURITY INVOKER`) transactional RPC + `workspace_folders.parent_folder_id`. |
| `TASK-05` | `F-003` | `467d4cc` | Added `executeAtomicMutation` RPC dispatcher and inspected `{ error }` in `recordIdempotency`. |
| `TASK-06` | `F-003` | `c7d3f1b` | Wired `executeAtomicMutation` across `DocumentPushAdapter`, `SystemDesignPushAdapter`, and `WorkspaceFolderPushAdapter`. |
| `TASK-07` | `F-003` | `c4092ce` | Added lost-response, post-create `v2` edit replay, `409` collision, and `PGRST202` fallback tests (`idempotentMutation.test.ts`). |
| `TASK-08` | `F-002` | `5b380c7` | Created shared server-side Stripe price allowlist, status mapper, and entitlement policy (`_shared/billingPolicy.ts`). |
| `TASK-09` | `F-002` | `3ea562b` | Enforced server price allowlist in `create-checkout-session` and passed `billingCycle` from checkout callers. |
| `TASK-10` | `F-002`, `R7` | `d3bc973` | Verified purchased price/interval/status in `stripe-webhook`, mapped DB statuses, checked write errors (`500` retry), and hardened `stripe_events` deduplication. |
| `TASK-11` | `F-005` | `39dcf3c` | Serialized `check_plan_tier_limit()` per user with `pg_advisory_xact_lock` and `deleted_at IS NULL` filtering. |
| `TASK-12` | `F-002`, `F-005` | `aa784c6` | Added billing allowlist, status mapping, webhook entitlement, and concurrent quota tests (`billing.test.ts`, `security.test.ts`). |
| `TASK-13` | `F-004` | `206cfb1` | Removed broad `*.supabase.co` Workbox `runtimeCaching` entry from `vite.config.ts`. |
| `TASK-14` | `F-004`, `R9` | `22ce246` | Added `clearSensitiveBrowserCaches` at boot (`main.tsx`), account switch, `closeUserRuntime`, and `SIGNED_OUT`. |
| `TASK-15` | `SS-01` | `d1ff473` | Guarded initial `getSession()` race in `useAuth.tsx` and surfaced `openUserRuntime` / `errored` states in `UserSyncRuntimeContext.tsx`. |
| `TASK-16` | `SS-08`, `R8` | `abec65f` | Added explicit `sanitizeMarkdownUrl` in `MarkdownPreview.tsx` and reconciled security/Markdown documentation. |
| `TASK-17` | `F-006` | `8b29b92` | Installed `@playwright/test` and added deterministic CI session/network mocks for E2E specs. |
| `TASK-18` | `F-006` | *(HEAD)* | Wired `e2e` job into `.github/workflows/ci.yml` and ran full verification gates. |

### Final Gate Results
- **TypeScript (`npx tsc --noEmit`):** Exit `0` (0 errors)
- **ESLint (`npm run lint`):** Exit `0` (0 errors)
- **Unit & Integration Suite (`npx vitest run`):** `83 / 83` test files passed (`593 / 593` tests passed)
- **Production PWA Build (`npm run build`):** Exit `0` (`dist/sw.js` verified free of `supabase-api-cache` and `supabase.co`)
- **Playwright E2E (`npx playwright test --project=chromium` with `CI=true` & dummy Supabase env):** Exit `0` (`13 passed`, `2 live-cloud-only checks skipped`, `0 failed`)
- **Follow-Up Note (`R10`):** When applying `20261020100000_commit_ordered_sync_changes.sql`, `20261020110000_atomic_idempotent_mutation_rpc.sql`, and `20261020120000_serialize_tier_limits_trigger.sql` to staging/production PostgreSQL, run a two-session SQL verification against live Postgres to complement the static migration audits and in-memory concurrency models.
