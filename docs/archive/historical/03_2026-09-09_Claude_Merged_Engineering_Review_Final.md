# Artix — Merged Engineering Review (Final, Consolidated)

**Sources merged:**
1. Original review — `Artix_Engineering_Review_and_Fix_Checklist.md`
2. Independent Round 2 review (direct source inspection)
3. Local comparison review (`c:/Fenix-main` analysis)

**Method note:** Every item below was cross-checked directly against the source at commit `6ea5b92`. Where the three sources disagreed, the disagreement is resolved explicitly and flagged — this document does not just concatenate the three lists.

---

## 0. Corrections applied during merge

Two claims from source #3 were checked against the actual Postgres/Workbox semantics and found to be **mischaracterized**. They are still listed below (the underlying facts are real), but with corrected severity/explanation:

- **RLS "missing UPDATE policy" on `prd_generations`, `vibe_generations`, `agentic_workflows`** — originally framed as "a user could edit another user's records." This is backwards. With RLS enabled and no UPDATE policy defined, Postgres **default-denies UPDATE for everyone, including the row's owner** — it is not a cross-user access hole, it's a silent functional dead-end. Confirmed the app never calls `.update()` on these three tables, so it is currently inert either way.
- **PWA `NetworkFirst` caching on `*.supabase.co`** — originally framed as intercepting POST/PATCH/DELETE mutations and auth requests. Workbox's `runtimeCaching` matches **GET requests only** by default when no `method` is specified (as is the case in `vite.config.ts`), so mutation traffic is very likely unaffected. Worth an explicit `method: 'GET'` for clarity, but this is not the mutation-corruption risk originally described.

---

## 1. P0 — Security

### 1.1 `disableEncryption()` writes the API key back in plaintext
**File:** `src/lib/ai/storage.ts`
Disabling encryption bypasses `sanitizeSettingsForStorage()` and writes the raw settings object (including the decrypted API key) directly to `localStorage`.
**Fix:** wrap the write in `sanitizeSettingsForStorage(settings)`. One-line fix. Add a lifecycle regression test (save → encrypt → unlock → disable → inspect `localStorage` → confirm no raw key).

### 1.2 No Content Security Policy anywhere
Checked `index.html`, `vercel.json`, `vite.config.ts` — no CSP meta tag, no CSP header, no plugin. This is the first line of defense against XSS reaching `localStorage`-held API keys; currently absent entirely.
**Fix:** add a CSP via `vercel.json` headers or a meta tag, starting with a reasonably strict default-src and widening only as needed.

### 1.3 Supabase RLS / authorization — full audit needed
Confirmed by reading every migration file directly:

| Table | SELECT | INSERT | UPDATE | DELETE | Note |
|---|:---:|:---:|:---:|:---:|---|
| `documents` | ✅ | ✅ | ✅ | ✅ | Clean |
| `projects` | ✅ | ✅ | ✅ | ✅ | Clean |
| `system_designs` | ✅ | ✅ | ✅ | ✅ | Clean |
| `profiles` | ✅ | ✅ | ✅ | ❌ | No DELETE policy — but `user_id` has `ON DELETE CASCADE` from `auth.users`, so account deletion already removes the row at the DB level. Client-side delete was likely never intended. Low real risk; add the policy anyway for completeness. |
| `prd_generations` | ✅ | ✅ | ❌ | ✅ | No UPDATE policy → UPDATE silently affects 0 rows for everyone (see §0). Not currently called by the app. Add policy if update functionality is ever built. |
| `vibe_generations` | ✅ | ✅ | ❌ | ✅ | Same as above. |
| `agentic_workflows` | ✅ | ✅ | ❌ | ✅ | Same as above. |
| `subscriptions` | ✅ (own only) | ❌ | ❌ | ❌ | By design — writes only via `service_role` in Edge Functions. Correct. |
| `stripe_events` | ❌ | ❌ | ❌ | ❌ | By design — webhook-only table. Correct. |

**Also do:** create two test users and explicitly verify cross-user isolation (A cannot read/update/delete B's `documents`/`projects`/`system_designs`) as an automated test, not just a manual check.

### 1.4 Confirmed clean (no action needed)
- `SUPABASE_SERVICE_ROLE_KEY` only appears in Edge Functions (`create-checkout-session`, `create-portal-session`, `stripe-webhook`) — never in client bundle code. Verified by direct search.
- No API keys, tokens, or secrets appear in any `console.log`/`console.error` call anywhere in `src/`. Verified by direct search.
- `crypto.ts` (AES-GCM + PBKDF2, 250,000 iterations, random salt/IV per operation) is correctly implemented — no changes needed.
- `stripe-webhook/index.ts` correctly verifies the Stripe signature (`constructEventAsync`) and implements idempotency via a `stripe_events` lookup before processing.
- `create-checkout-session` correctly derives `user.id` from a verified JWT, not from client input.

### 1.5 Unvalidated `origin` parameter in `create-checkout-session` (open redirect)
**File:** `supabase/functions/create-checkout-session/index.ts`
`origin` is accepted from the request body with zero validation and used directly to build `success_url`/`cancel_url` for Stripe:
```ts
success_url: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
cancel_url: `${origin}/dashboard`,
```
An authenticated caller could redirect the post-payment flow to an attacker-controlled domain.
**Fix:** validate `origin` against an allowlist (production domain + Vercel preview pattern) before use.

---

## 2. P1 — Reliability

### 2.1 AI settings save — fire-and-forget race condition
**File:** `src/lib/ai/storage.ts`, encrypted `saveSettings()`
```ts
void encryptJSON(settings, memoryPassphrase!).then((blob) => {
  localStorage.setItem(ENC_KEY, JSON.stringify(blob));
});
```
No `await`, no `.catch()` (unhandled rejection risk), and no ordering guarantee — three rapid saves can resolve out of order and leave stale data as "current."
**Fix:** make `saveSettings()` `async`, add a revision counter or serialize writes, add a `.catch()`.

### 2.2 Document/board save — same race, but a real fix already exists unused
**Files:** `src/lib/cache/debouncedSave.ts` (used by both `Editor.tsx` via `autosave.ts`, and `SystemArchitect.tsx`), and `src/lib/cache/saveQueue.ts`.
Same race-condition pattern as §2.1, but for document/board content specifically. **The fix is already built:** `saveQueue.ts` implements a serial save queue with optimistic locking (`version`/`updated_at`-guarded writes) and has passing tests in `src/test/edge-cases.test.ts` — but it is **never imported by any actual application code**. Confirmed via search: zero references outside the test file.
**Fix:** wire `saveQueue.ts` into `autosave.ts` and `SystemArchitect.tsx`'s save path in place of the raw `debouncedSave` call. Add a `version`/`updated_at` guard clause to the corresponding Supabase `.update()` calls (`useSystemDesigns.tsx`, `useDocuments.tsx`) so the database itself rejects stale writes, not just the client.

### 2.3 Draft recovery is write-only — never read back
**File:** `src/lib/cache/debouncedSave.ts`
Every keystroke writes a draft to `localStorage` (`artix.draft.{id}`) and clears it on successful save — this part works. **But nothing in the application ever reads that draft back on load.** Confirmed by search: the key is referenced only in the test file, never in `Editor.tsx`, `SystemArchitect.tsx`, or anywhere on mount/init.
**Practical effect:** if the tab crashes before the debounced save fires, the draft sits in `localStorage` correctly, but the user has no way to recover it — the "crash-resistant autosave" the docs describe is only half-built.
**Fix:** on component mount, check for a matching `artix.draft.{id}` key; if present and different from the loaded content, prompt the user to restore it (or restore automatically and flush).

### 2.4 Tab-close safety net sends to a nonexistent endpoint
**File:** `src/lib/cache/tabCloseGuard.ts`
`navigator.sendBeacon('/api/save', payload)` — no such route or Supabase Edge Function exists anywhere in the repo (confirmed against `supabase/functions/` and `vercel.json`, which rewrites all paths to `index.html` as a static SPA). The `flushSync()` fallback that's supposed to carry the real save during `beforeunload` uses a normal (non-`keepalive`) request, which browsers frequently abort mid-flight during tab close.
**Fix:** either build a real minimal save endpoint for the beacon, or remove the beacon entirely and rely explicitly on the (now-fixed, see §2.3) localStorage draft as the documented recovery path.

### 2.5 Cross-tab sync (`BroadcastChannel`) is dead code
**File:** `src/lib/cache/tabSync.ts`
`createTabSync` is never imported anywhere in the application — not in `autosave.ts`, `Editor.tsx`, `SystemArchitect.tsx`, or `ProjectWorkspace.tsx`. Only referenced in `edge-cases.test.ts`. Same exact pattern as §2.2's `saveQueue.ts`: a tested module that isn't wired in. The docs/README describe "cross-tab synchronization" as a working feature; it currently is not.
**Additional design issue if activated:** the leader-election lock in `tabSync.ts` has no TTL/heartbeat — if the leader tab closes abruptly, the lock key can persist in `localStorage` indefinitely.
**Decision needed:** wire it in properly (with a TTL on the lock), or remove it and the corresponding claims from `README.md`/`DOCS.md`.

### 2.6 Zero React Error Boundaries
Confirmed by search: no `ErrorBoundary`, `componentDidCatch`, or `getDerivedStateFromError` anywhere in `src/`. An unexpected render error anywhere (Monaco editor, React Flow canvas, an AI dialog) currently takes down the entire app to a blank white screen with no recovery path.
**Fix:** add at least one top-level Error Boundary in `App.tsx`, plus targeted ones around Monaco and the React Flow canvas specifically, since those are the highest-complexity render trees.

### 2.7 `localStorage.setItem` mostly unguarded
13 production call sites found; the large majority have no `try/catch`. Any `QuotaExceededError` or `SecurityError` (private browsing) will throw unhandled. Highest-risk sites: `useTheme.tsx` (runs on every mount) and the two unencrypted/encrypted writes in `storage.ts`.
**Fix:** wrap all `localStorage` writes in try/catch with silent-fallback behavior, consistent with the pattern `debouncedSave.ts` already uses correctly.

### 2.8 Usage/Budget dashboard shows fabricated data
**File:** `src/components/APIUsageView.tsx`
Hardcoded seed values (`inputTokens: 245000, outputTokens: 98000`) are shown as if real when no stored usage exists, alongside a hardcoded `$10.00` budget. Confirmed by search: nothing in the AI call path (`registry.ts`, `providers/*`) ever writes back to the `artix.ai.usage.v1` key after a real request — so these numbers never reflect actual usage.
**Fix:** either wire real token counts from `callAI`/`streamAI` responses into this key, or relabel the UI clearly as illustrative/estimated until that's built.

---

## 3. P2 — Code quality & validation

### 3.1 Zod validation exists in exactly one place
`zod` is imported only in `src/pages/Auth.tsx`. Everywhere else that crosses a trust boundary uses an unguarded type assertion instead of runtime validation:
- `src/lib/ai/storage.ts` — `JSON.parse(raw) as AISettings` (this one matters most: it's the loader for stored API keys)
- Supabase query responses — `data as Document[]`-style assertions
- AI provider responses — `JSON.parse(res.text)` for generated architecture/PRD content
- URL parameters — unvalidated

**Fix:** start with an `AISettings` schema in `storage.ts` and a `BoardState` schema, using `.safeParse()` with a default-and-warn fallback instead of an unguarded assertion.

### 3.2 TypeScript strict mode is fully disabled
Confirmed in `tsconfig.app.json` / `tsconfig.json`: `strict: false`, `strictNullChecks: false`, `noImplicitAny: false`, `noUnusedLocals: false`, `noUnusedParameters: false`, `noFallthroughCasesInSwitch: false`. TypeScript currently cannot catch null/undefined misuse, implicit `any`, unused bindings, or switch fallthrough anywhere in the codebase.
**Fix:** turn on flags incrementally (`strictNullChecks` first, since it tends to surface the most real bugs) rather than flipping `strict: true` all at once, which will likely produce a large, unmanageable error dump.

### 3.3 Errors swallowed silently in several places
Examples: `debouncedSave.ts`'s `.catch(() => {})` on failed saves (draft correctly stays local, but nothing surfaces the failure beyond the UI's generic "Error" badge), `storage.ts`'s `catch { return {}; }` on a corrupted settings read (masks the corruption as "no settings configured"), `streaming.ts`'s silent chunk-drop on malformed AI stream data.
**Fix:** not all of these need to become user-facing errors, but they should at minimum reach `console.error` with enough context to debug, and the AI-settings-corruption case specifically should surface to the user rather than silently resetting.

### 3.4 Repository hygiene
- `package.json` still has the Vite scaffold name (`"vite_react_shadcn_ts"`) and `"version": "0.0.0"`.
- Three lockfiles present simultaneously (`bun.lock`, `bun.lockb`, `package-lock.json`) — pick one package manager, remove the others.
- `README.md` contains a `file:///c:/...` local link that won't resolve on GitHub — change to a relative path.
- Legacy "Fenix" references: the `fenix.ai.settings.v1` key in `storage.ts` is a required migration-compatibility shim and should stay; remaining mentions in `DOCS.md`/`README.md` are just text cleanup.

---

## 4. Recommended fix order

Unchanged in spirit from the original checklist's conclusion — this merge does not change the overall verdict, it sharpens it.

**Phase 1 — Security (do first, ~1 day of focused work)**
1. Fix `disableEncryption()` plaintext regression (§1.1)
2. Add CSP (§1.2)
3. Validate `origin` in `create-checkout-session` (§1.5)
4. Add the missing RLS policies for completeness (§1.3) — low urgency given current usage, but cheap and removes a footgun for future features
5. Cross-user isolation test suite for `documents`/`projects`/`system_designs`

**Phase 2 — Reliability (the highest-leverage phase — several fixes already exist and just need wiring)**
6. Wire `saveQueue.ts` into the real save paths (§2.2) — this is a connect-not-build task
7. Fix the AI-settings save race with an async + revision-guarded `saveSettings()` (§2.1)
8. Make the draft actually recoverable on load (§2.3)
9. Decide and implement the `tabCloseGuard` fix or removal (§2.4)
10. Decide and implement the `tabSync.ts` wiring or removal, with a lock TTL if kept (§2.5)
11. Add top-level + targeted Error Boundaries (§2.6)
12. Guard remaining `localStorage.setItem` calls (§2.7)
13. Fix or relabel the usage dashboard (§2.8)

**Phase 3 — Validation & type safety**
14. `zod` schema for `AISettings` first, then `BoardState` (§3.1)
15. Incrementally enable `strictNullChecks`, then the rest of `strict` (§3.2)
16. Surface silently-swallowed errors that currently hide real failures (§3.3)

**Phase 4 — Repository cleanup & docs**
17. Package metadata, lockfiles, README links (§3.4)
18. Once Phases 1–3 are done, update `README.md`/`DOCS.md` so every claimed feature ("crash-resistant autosave," "cross-tab sync") matches what's actually wired in — several currently describe features that exist in code but are not connected.

---

## Bottom line

Both source reviews converge on the same underlying verdict: **the architecture is sound and does not need a rebuild.** What repeatedly shows up across all three passes is a specific pattern — well-built, tested modules (`saveQueue.ts`, `tabSync.ts`) sitting disconnected next to the code paths that actually run, and documentation describing features (autosave crash-resistance, cross-tab sync) more completely than the wiring currently supports. Closing that gap — connecting what's already built, plus the standalone fixes in §1 and §3 — is a bounded, well-scoped body of work, not a redesign.
