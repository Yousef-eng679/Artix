# Artix Hardening — Implementation Plan

**Source Review:** `Artix_Merged_Engineering_Review_Final.md`
**Codebase Commit:** `6ea5b92`
**Plan Date:** September 11, 2026

---

# Phase 1 — Security

---

### Task §1.1 — Fix `disableEncryption()` plaintext-storage regression

**Files in scope:**
- [`src/lib/ai/storage.ts`](file:///c:/Fenix-main/src/lib/ai/storage.ts) (line 155 — the bug)
- [`src/test/api-saving.test.ts`](file:///c:/Fenix-main/src/test/api-saving.test.ts) (lines 84–93 — existing test must be strengthened)

**Reasoning summary:**

- **Current behavior:** When a user calls `disableEncryption(passphrase)`, the function (1) reads the encrypted blob from `localStorage` key `artix.ai.settings.enc.v1`, (2) decrypts it via `decryptJSON<AISettings>(blob, passphrase)` getting the raw settings including the plaintext API key, (3) writes `JSON.stringify(settings)` directly to `localStorage` key `artix.ai.settings.v1` at line 155, (4) removes the encrypted key. The raw API key (e.g. `sk-abc123...`) is now stored as-is in `localStorage`.

- **Root cause:** Line 155 calls `JSON.stringify(settings)` instead of `JSON.stringify(sanitizeSettingsForStorage(settings))`. The `sanitizeSettingsForStorage()` function (lines 40–46) deep-clones settings and replaces `apiKey` with its `obf:${btoa(key)}` form via `obfuscateApiKey()`. This sanitization is correctly applied in `saveSettings()` (line 100) but was never applied in `disableEncryption()`. The `changePassphrase()` function (lines 162–175) does NOT have this bug — it reads from `ENC_KEY` and writes back to `ENC_KEY`, never touching `KEY`.

- **Blast radius found:** `disableEncryption()` is called from exactly 2 places: (1) `src/hooks/useAISettings.ts:59` (wrapped as `disableEnc`), exposed via the hook but **never actually invoked from any UI component** — `AISettingsCard.tsx:266` destructures `disableEncryption` but renders no button to trigger it. (2) `src/test/api-saving.test.ts:90`. The fix is entirely isolated to `storage.ts` line 155. No caller changes needed.

- **Constraints:** (1) `sanitizeSettingsForStorage()` is a private function already used by `saveSettings()` — no signature change needed. (2) Existing test at `api-saving.test.ts:84–93` currently checks that `loadSettings()` returns the original settings after disable — this must still pass. (3) A new assertion must verify the raw key does NOT appear in `localStorage`.

- **Design chosen:** Replace `JSON.stringify(settings)` with `JSON.stringify(sanitizeSettingsForStorage(settings))` on line 155. This matches the pattern used by `saveSettings()` on line 100. No alternative considered — this is the canonical one-line fix.

**Implementation steps:**

1. In `src/lib/ai/storage.ts`, line 155, change:
   ```ts
   localStorage.setItem(KEY, JSON.stringify(settings));
   ```
   to:
   ```ts
   localStorage.setItem(KEY, JSON.stringify(sanitizeSettingsForStorage(settings)));
   ```

2. In `src/test/api-saving.test.ts`, within the test `'should disable encryption and restore plaintext values'` (line 84), after line 92 (`expect(loadSettings()).toEqual(settings)`), add:
   ```ts
   // Verify no raw API key in localStorage
   const stored = localStorage.getItem('artix.ai.settings.v1');
   expect(stored).not.toContain('test-openai-key-12345');
   expect(stored).toContain('obf:');
   ```

**Acceptance criteria:**
- `disableEncryption()` writes settings through `sanitizeSettingsForStorage()`, so the stored JSON contains `obf:...` encoded key, never the raw key.
- `loadSettings()` after `disableEncryption()` still returns the original settings with the decoded key (existing behavior — `deobfuscateApiKey` handles `obf:` prefix).
- New test assertion explicitly inspects raw `localStorage` content and confirms no raw API key present.
- All 81 existing tests pass.

**Test plan:**
- **Automated:** Modify `src/test/api-saving.test.ts`, test `'should disable encryption and restore plaintext values'`, adding the two `expect` assertions above. Run `npm test`.
- **Manual verification:** In browser DevTools, save an API key → enable encryption → unlock → disable encryption → inspect `localStorage` key `artix.ai.settings.v1` → confirm value contains `obf:` prefix, not the raw key.

**Depends on:** none
**Blocks:** none

**Observed but out of scope:** `disableEncryption` is destructured in `AISettingsCard.tsx:266` but there is no UI button to trigger it. The feature exists in the hook but not in the UI. This is a product decision, not a bug.

---

### Task §1.2 — Add Content Security Policy

**Files in scope:**
- [`vercel.json`](file:///c:/Fenix-main/vercel.json) (add `headers` configuration)

**Reasoning summary:**

- **Current behavior:** No Content Security Policy exists anywhere — not in `index.html`, not in `vercel.json`, not in `vite.config.ts`, not via any plugin. Any injected script can execute freely, access `localStorage` (where API keys are stored), and exfiltrate data.

- **Root cause:** CSP was never configured. The project started from a Vite scaffold that doesn't include CSP by default.

- **Blast radius found:** The app connects to these external domains at runtime:
  - **Supabase:** `https://ldhbjeustealybjffadn.supabase.co`, `wss://ldhbjeustealybjffadn.supabase.co`
  - **AI providers (BYOK):** `https://api.openai.com`, `https://api.anthropic.com`, `https://generativelanguage.googleapis.com`, `https://api.groq.com`, `https://openrouter.ai`, `http://localhost:11434`, `http://127.0.0.1:11434`
  - **Monaco Editor CDN:** `https://cdn.jsdelivr.net` (JS, CSS, workers), uses `blob:` for web workers
  - **Google Fonts:** `https://fonts.googleapis.com` (stylesheets), `https://fonts.gstatic.com` (font files)
  - **Stripe (redirects, not loaded in-page):** `https://checkout.stripe.com`, `https://billing.stripe.com`
  - One `dangerouslySetInnerHTML` in `src/components/ui/chart.tsx:70` — injects CSS only, safe but requires `'unsafe-inline'` for `style-src`.

- **Constraints:** (1) Monaco Editor requires `'unsafe-eval'` in `script-src` because it uses `new Function()` for syntax highlighting. (2) Vite injects inline scripts during dev — CSP should only apply in production via `vercel.json` headers. (3) The CSP must not break any of the 6 AI provider connections. (4) Tailwind/shadcn uses inline styles — `style-src` needs `'unsafe-inline'`.

- **Design chosen:** Add CSP via `vercel.json` `headers` array (production-only, doesn't affect local dev). This is the Vercel-recommended approach and avoids a `<meta>` tag that can't set `frame-ancestors` or `report-uri`. Alternative rejected: `<meta>` tag in `index.html` — can't use `frame-ancestors`, applies in dev too, harder to iterate.

**Implementation steps:**

1. Replace `vercel.json` contents with:
   ```json
   {
     "headers": [
       {
         "source": "/(.*)",
         "headers": [
           {
             "key": "Content-Security-Policy",
             "value": "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.openai.com https://api.anthropic.com https://generativelanguage.googleapis.com https://api.groq.com https://openrouter.ai http://localhost:11434 http://127.0.0.1:11434 https://cdn.jsdelivr.net; worker-src 'self' blob:; frame-src https://checkout.stripe.com https://billing.stripe.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
           },
           {
             "key": "Strict-Transport-Security",
             "value": "max-age=63072000; includeSubDomains; preload"
           },
           {
             "key": "X-Content-Type-Options",
             "value": "nosniff"
           },
           {
             "key": "Referrer-Policy",
             "value": "strict-origin-when-cross-origin"
           }
         ]
       }
     ],
     "rewrites": [
       {
         "source": "/(.*)",
         "destination": "/index.html"
       }
     ]
   }
   ```

2. After deploying to Vercel preview, open browser DevTools Console and verify no CSP violations are reported during: page load, Monaco editor load, AI generation (any provider), font rendering, Stripe checkout flow.

**Acceptance criteria:**
- `vercel.json` contains a valid CSP header covering all runtime domains.
- Production deployment shows zero CSP violation errors in console during normal usage.
- All AI providers (OpenAI, Anthropic, Google, Groq, OpenRouter, Ollama) can still be called without CSP blocks.
- Monaco Editor loads and functions (syntax highlighting, workers) without CSP blocks.
- Stripe checkout redirect and portal redirect work without CSP blocks.
- HSTS, X-Content-Type-Options, and Referrer-Policy headers are also set.

**Test plan:**
- **Manual verification (required — CSP is deployment-specific):**
  1. Deploy to Vercel preview branch.
  2. Open DevTools → Console. Navigate through: landing page, auth, dashboard, project workspace, editor (Monaco), system architect, settings, pricing.
  3. Attempt an AI generation with at least one configured provider.
  4. Confirm zero `Refused to...` CSP violation errors.
  5. Check response headers via DevTools → Network → document request → verify `Content-Security-Policy` header is present and correct.
- **Automated:** The existing 81 tests run locally (no Vercel headers), so they are unaffected by this change. No new automated test needed for CSP itself.

**Depends on:** none
**Blocks:** none

**Observed but out of scope:** Monaco Editor's need for `'unsafe-eval'` is a known limitation of the library. Eliminating it would require replacing Monaco or waiting for upstream support for CSP-safe evaluation — not in scope for this hardening pass.

---

### Task §1.3 — Add missing RLS policies

**Files in scope:**
- New migration file: `supabase/migrations/<timestamp>_add_missing_rls_policies.sql`

**Reasoning summary:**

- **Current behavior:** Four tables have incomplete RLS policies:
  - `prd_generations`: GRANT UPDATE given, but no UPDATE policy → UPDATE silently returns 0 rows for all users (default-deny). The app never calls `.update()` on this table.
  - `vibe_generations`: Same situation — GRANT UPDATE given, no UPDATE policy, app never calls `.update()`.
  - `agentic_workflows`: Same situation — GRANT UPDATE given, no UPDATE policy, app never calls `.update()`.
  - `profiles`: Has SELECT, INSERT, UPDATE policies, but no DELETE policy. The app never calls `.delete()` on profiles. The `user_id` column has `ON DELETE CASCADE` from `auth.users`, so account deletion handles row removal at the DB level.

- **Root cause:** When migrations 5–8 were created (`20260617...`, `20260625...`, `20260628...`), GRANT statements included UPDATE but the corresponding CREATE POLICY was omitted. For `profiles` (migration 3, `20260205...`), DELETE policy was simply never added.

- **Blast radius found:** Confirmed by exhaustive search: (1) `prd_generations` — only SELECT and INSERT are called (`usePRDGenerations.ts:24,42`). (2) `vibe_generations` — only SELECT and INSERT (`useVibeGenerations.ts:25,44`). (3) `agentic_workflows` — only SELECT and INSERT (`useAgenticWorkflows.ts:25,44`). (4) `profiles` — SELECT, INSERT, UPDATE are called (`useProfile.tsx:67`), DELETE is not. Adding policies will not change any current behavior — it only unblocks future UPDATE/DELETE operations from being silently dropped.

- **Constraints:** (1) Policies must use `auth.uid() = user_id` pattern consistent with all existing policies. (2) UPDATE policies must include both `USING` and `WITH CHECK` clauses, matching the pattern in migration 4. (3) Must not modify any existing policy — only add new ones.

- **Design chosen:** Single migration file adding 4 policies: UPDATE on `prd_generations`, `vibe_generations`, `agentic_workflows`, and DELETE on `profiles`. Alternative rejected: revoking the GRANT UPDATE on those 3 tables instead — but that would prevent future update functionality without another migration.

**Implementation steps:**

1. Create `supabase/migrations/<next_timestamp>_add_missing_rls_policies.sql` with:
   ```sql
   -- Add missing UPDATE policies for prd_generations, vibe_generations, agentic_workflows
   CREATE POLICY "Users can update own PRDs"
     ON public.prd_generations FOR UPDATE TO authenticated
     USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

   CREATE POLICY "Users can update own vibe generations"
     ON public.vibe_generations FOR UPDATE TO authenticated
     USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

   CREATE POLICY "Users can update own agentic workflows"
     ON public.agentic_workflows FOR UPDATE TO authenticated
     USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

   -- Add missing DELETE policy for profiles
   CREATE POLICY "Users can delete own profile"
     ON public.profiles FOR DELETE TO authenticated
     USING (auth.uid() = user_id);
   ```

2. Apply the migration to the Supabase project via `supabase db push` or via the Supabase MCP `apply_migration` tool.

**Acceptance criteria:**
- All four policies exist in the database.
- Existing SELECT, INSERT, UPDATE, DELETE operations on `documents`, `projects`, `system_designs` are unaffected.
- The 81 existing tests pass (none touch these tables directly).

**Test plan:**
- **Manual verification via SQL:**
  ```sql
  SELECT tablename, policyname, cmd
  FROM pg_policies
  WHERE schemaname = 'public'
  ORDER BY tablename, cmd;
  ```
  Confirm `prd_generations`, `vibe_generations`, `agentic_workflows` each show SELECT, INSERT, UPDATE, DELETE policies, and `profiles` shows SELECT, INSERT, UPDATE, DELETE policies.
- **Automated:** No new automated test needed for the migration itself. Cross-user isolation tests are a separate concern addressed in the review's test strategy section but not part of this task's immediate scope.

**Depends on:** none
**Blocks:** none

**Observed but out of scope:** The review recommends creating two test users and verifying cross-user isolation as an automated test (§1.3 final paragraph). That is a test-infrastructure task, not a migration task, and should be tracked separately.

---

### Task §1.5 — Fix unvalidated `origin`/`return_url` open redirect in Edge Functions

**Files in scope:**
- [`supabase/functions/create-checkout-session/index.ts`](file:///c:/Fenix-main/supabase/functions/create-checkout-session/index.ts) (lines 35, 75–76)
- [`supabase/functions/create-portal-session/index.ts`](file:///c:/Fenix-main/supabase/functions/create-portal-session/index.ts) (lines 34, 56–58)
- [`supabase/functions/validate-email/index.ts`](file:///c:/Fenix-main/supabase/functions/validate-email/index.ts) (line 83 — calls `getCorsHeaders(req, ALLOWED_ORIGINS)` with its own local allowlist; must be migrated to use the centralized allowlist)
- [`supabase/functions/_shared/cors.ts`](file:///c:/Fenix-main/supabase/functions/_shared/cors.ts) (CORS wildcard `*` — fix in same pass)

**Reasoning summary:**

- **Current behavior:** `create-checkout-session` reads `origin` from the request body (line 35: `const { priceId, origin } = await req.json()`) with zero validation, then uses it directly in Stripe's `success_url` and `cancel_url` (lines 75–76). `create-portal-session` does the same with `return_url` (line 34: `const { return_url } = await req.json()`, used at line 58). An authenticated user could POST `{"priceId": "...", "origin": "https://evil.com"}` and Stripe would redirect the user (with their `session_id`) to the attacker's domain after payment.

- **Root cause:** The origin/URL is taken from untrusted client input without validation against an allowlist. The client code (`Pricing.tsx:26`, `UpgradePrompt.tsx:25`, `Settings.tsx:314`) correctly passes `window.location.origin`, but the server doesn't enforce this. Additionally, `getCorsHeaders(req)` is called without an `allowedOrigins` argument, causing it to default to `Access-Control-Allow-Origin: *`, which means any origin can invoke these functions.

- **Blast radius found (beyond review):** The review only mentions `create-checkout-session` (§1.5). Research confirmed that `create-portal-session` has the **identical vulnerability** with `return_url`. Both must be fixed together. Client callers: `Pricing.tsx:25–27`, `UpgradePrompt.tsx:24–26` (for checkout), `Settings.tsx:313–315` (for portal). All three pass `window.location.origin` — the fix will not break them as long as the allowlist includes the production domain and `localhost:8080`.

- **Constraints:** (1) The allowlist must include the production Vercel domain (`https://artix-mocha.vercel.app`), Vercel preview domains (`https://*.vercel.app`), and `http://localhost:8080` for local dev. (2) `cors.ts` `getCorsHeaders` already accepts an `allowedOrigins` parameter — callers just aren't using it. (3) Must not break the existing Stripe checkout/portal flows.

- **Design chosen:** (A) Consolidate all origin-matching logic into a single shared function `isOriginAllowed(candidateUrl)` in `cors.ts`. Both `getCorsHeaders()` (for CORS header generation from the request `Origin` header) and the Edge Functions (for validating body-supplied `origin`/`return_url` before Stripe redirect) call this one function. (B) Update `getCorsHeaders()` to use `isOriginAllowed()` instead of strict `.includes()`, so preview deployment origins that match the `*.vercel.app` suffix get their origin echoed back correctly. Alternative rejected: keeping two separate matching implementations (one wildcard-aware, one strict-array) — this is exactly the inconsistency that caused the defect.

**Implementation steps:**

1. In `supabase/functions/_shared/cors.ts`, replace the entire file with:
   ```ts
   export const corsHeaders = {
     'Access-Control-Allow-Origin': '*',
     'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
     'X-Content-Type-Options': 'nosniff',
     'X-Frame-Options': 'DENY',
   };

   const ALLOWED_ORIGINS = [
     'https://artix-mocha.vercel.app',
     'http://localhost:8080',
     'http://localhost:5173',
   ];

   /**
    * Single source of truth for "is this origin/URL allowed?"
    * Used by both getCorsHeaders (for CORS) and Edge Functions (for redirect validation).
    * Matches exact origins from the allowlist, plus any *.vercel.app preview deployment.
    */
   export function isOriginAllowed(candidateUrl: string): boolean {
     try {
       const parsed = new URL(candidateUrl);
       const origin = parsed.origin;
       if (ALLOWED_ORIGINS.includes(origin)) return true;
       if (parsed.hostname.endsWith('.vercel.app')) return true;
       return false;
     } catch {
       return false;
     }
   }

   export function getCorsHeaders(req?: Request): Record<string, string> {
     const reqOrigin = req?.headers.get('origin') || '';
     const allowOrigin = isOriginAllowed(reqOrigin) ? reqOrigin : ALLOWED_ORIGINS[0];
     return {
       ...corsHeaders,
       'Access-Control-Allow-Origin': allowOrigin,
     };
   }
   ```

   Key changes vs. original:
   - `getCorsHeaders` no longer accepts an `allowedOrigins` parameter — the allowlist is internal to this module (single source of truth).
   - `getCorsHeaders` calls `isOriginAllowed()` for its matching, which includes the `*.vercel.app` suffix check — so preview deployment origins get echoed back correctly.
   - `isOriginAllowed` is exported for Edge Functions to validate body-supplied URLs.

2. In `supabase/functions/create-checkout-session/index.ts`:
   - Change import to: `import { getCorsHeaders, isOriginAllowed } from '../_shared/cors.ts'`
   - Change line 11 from `const headers = getCorsHeaders(req)` — no change needed, `getCorsHeaders` now handles everything internally.
   - After line 38, add origin validation:
     ```ts
     if (!isOriginAllowed(origin)) {
       throw new Error('Invalid origin');
     }
     ```

3. In `supabase/functions/create-portal-session/index.ts`:
   - Change import to: `import { getCorsHeaders, isOriginAllowed } from '../_shared/cors.ts'`
   - `getCorsHeaders(req)` call stays as-is (no second argument needed now).
   - After `return_url` extraction, add:
     ```ts
     if (!isOriginAllowed(return_url)) {
       throw new Error('Invalid return_url');
     }
     ```

4. Deploy updated Edge Functions to Supabase.

**Acceptance criteria:**
- `create-checkout-session` rejects requests where `origin` is not in the allowlist (returns 400).
- `create-portal-session` rejects requests where `return_url` is not in the allowlist (returns 400).
- `Access-Control-Allow-Origin` header is set to the requesting origin (if allowed) instead of `*`.
- Vercel preview deployments (`https://artix-git-*.vercel.app`) pass both the body-origin validation AND get the correct CORS header echoed back — not the production domain, not `*`.
- Normal checkout flow from production domain (`artix-mocha.vercel.app`) works correctly.
- Normal portal flow from settings page works correctly.
- Local dev (`localhost:8080`) checkout flow works correctly.

**Test plan:**
- **Manual verification:**
  1. From production: trigger checkout → verify redirect goes to `artix-mocha.vercel.app/checkout/success`.
  2. From curl/Postman with a valid JWT: POST to `create-checkout-session` with `origin: "https://evil.com"` → verify 400 error response.
  3. From curl: POST to `create-portal-session` with `return_url: "https://evil.com/settings"` → verify 400 error response.
  4. Verify CORS response headers show the specific origin, not `*`.
  5. Simulate a Vercel preview request: send a request with `Origin: https://artix-git-test-branch.vercel.app` header and matching `origin` body field. Confirm (a) the Edge Function does not reject it, and (b) the response `Access-Control-Allow-Origin` header echoes back `https://artix-git-test-branch.vercel.app` (not the production domain, not `*`).

**Depends on:** none
**Blocks:** none

**Observed but out of scope:** The `stripe-webhook` Edge Function does not have this issue — it receives `POST` from Stripe servers, verifies the Stripe signature, and never uses client-provided URLs. The CORS wildcard in `cors.ts` also applies to `stripe-webhook`, but that endpoint does not accept browser requests (Stripe POSTs directly) so CORS is irrelevant for it.

---

# Phase 2 — Reliability

---

### Task §2.1 — Make `saveSettings()` async with race-condition protection

**Files in scope:**
- [`src/lib/ai/storage.ts`](file:///c:/Fenix-main/src/lib/ai/storage.ts) (lines 88–102 — `saveSettings`)
- [`src/hooks/useAISettings.ts`](file:///c:/Fenix-main/src/hooks/useAISettings.ts) (line 37 — calls `saveSettings`)
- [`src/components/AI/AISettingsCard.tsx`](file:///c:/Fenix-main/src/components/AI/AISettingsCard.tsx) (line 80–101 — `handleSave` calls `update`)
- [`src/test/api-saving.test.ts`](file:///c:/Fenix-main/src/test/api-saving.test.ts) (lines 30, 47, 84, 104 — calls `saveSettings`)

**Reasoning summary:**

- **Current behavior:** `saveSettings()` returns `void` synchronously. In the encrypted branch, it calls `void encryptJSON(settings, memoryPassphrase!).then(...)` — fire-and-forget. The promise chain has no `.catch()` handler. Callers cannot know when persistence completes, and three rapid saves can resolve out of order, leaving stale data.

- **Root cause:** The function was designed synchronous for the unencrypted branch (where `localStorage.setItem` is synchronous) and the encrypted branch was bolted on as fire-and-forget. The `void` keyword explicitly discards the promise. With no revision counter, three concurrent `encryptJSON()` calls can resolve in any order because Web Crypto scheduling is nondeterministic.

- **Blast radius found:** `saveSettings()` is called from exactly 1 application site: `useAISettings.ts:37` inside the `update` callback, which is itself called from `AISettingsCard.tsx`'s `handleSave` (line ~95). The `handleSave` uses a synchronous try/catch — if `saveSettings` becomes async without updating the caller, the catch will not trap async errors and `toast.success` will fire before save completes. Test file `api-saving.test.ts` has 4 synchronous calls that need updating.

- **Constraints:** (1) The unencrypted branch must remain synchronous in behavior (it already is — `localStorage.setItem` is sync). (2) The function must still update `memoryCache` and call `notifyChange()` after write, not before. (3) Existing tests must pass after updating them to `await` the call. (4) The fix must not touch `enableEncryption`, `disableEncryption`, or `changePassphrase` — those are separate functions with separate concerns.

- **Design chosen:** (A) Change `saveSettings` signature to `async function saveSettings(settings: AISettings): Promise<void>`. (B) Add a `saveRevision` counter: increment before encrypt, check after encrypt, skip write if stale. (C) Add `.catch()` → re-throw. (D) Update `useAISettings.ts` `update` to `async` and `await saveSettings`. (E) Update `AISettingsCard.tsx` `handleSave` to `await update(...)`. (F) Update test calls to `await`. Alternative rejected: Promise queue/mutex — more complex, revision counter is sufficient here because saves are always total replacements (not incremental patches).

**Implementation steps:**

1. In `src/lib/ai/storage.ts`, above `saveSettings` (before line 88), add:
   ```ts
   let saveRevision = 0;
   ```

2. Replace `saveSettings` function (lines 88–102) with:
   ```ts
   export async function saveSettings(settings: AISettings): Promise<void> {
     if (isEncrypted()) {
       if (!isUnlocked()) throw new Error('AI keys are locked. Unlock to save.');
       const revision = ++saveRevision;
       const blob = await encryptJSON(settings, memoryPassphrase!);
       if (revision !== saveRevision) return; // stale write, skip
       memoryCache = settings;
       localStorage.setItem(ENC_KEY, JSON.stringify(blob));
       notifyChange();
       return;
     }
     localStorage.setItem(KEY, JSON.stringify(sanitizeSettingsForStorage(settings)));
     notifyChange();
   }
   ```

3. In `src/hooks/useAISettings.ts`, line 36–39, change `update` to:
   ```ts
   const update = useCallback(async (next: AISettings) => {
     await saveSettings(next);
     setSettings(next);
   }, []);
   ```

4. In `src/components/AI/AISettingsCard.tsx`, make `handleSave` async and await:
   ```ts
   const handleSave = async () => {
     // ... existing validation logic ...
     try {
       await update({ ...settings, [slot]: { ... } });
       toast.success(`${label} provider saved`, { ... });
     } catch (err) {
       toast.error((err as Error).message);
     }
   };
   ```

5. In `src/test/api-saving.test.ts`, update synchronous test functions to `async` and add `await` before `saveSettings(...)` calls on lines 30, 47, 84, 104. Example for test 1:
   ```ts
   it('should save and load settings in plaintext by default', async () => {
     await saveSettings(settings);
     // ... rest unchanged
   });
   ```

**Acceptance criteria:**
- `saveSettings()` returns `Promise<void>`.
- In the encrypted branch, a revision counter prevents stale writes: if a newer save starts before an older one finishes encrypting, the older one's write is skipped.
- Crypto errors surface to callers instead of becoming unhandled rejections.
- `AISettingsCard` correctly awaits save and shows toast only after completion.
- All 81 existing tests pass (with updated `await`s).

**Test plan:**
- **Automated (modify existing):** Update `src/test/api-saving.test.ts` as described in step 5. Run `npm test`.
- **Automated (new test):** Add a test in `api-saving.test.ts` that calls `saveSettings` 3 times rapidly with different values, awaits the last one, and verifies `loadSettings()` returns the final value:
  ```ts
  it('should handle rapid saves without stale data', async () => {
    await enableEncryption('password123');
    await unlock('password123');
    saveSettings({ primary: { provider: 'openai', model: 'gpt-4', apiKey: 'A' } });
    saveSettings({ primary: { provider: 'openai', model: 'gpt-4', apiKey: 'B' } });
    await saveSettings({ primary: { provider: 'openai', model: 'gpt-4', apiKey: 'C' } });
    const loaded = loadSettings();
    expect(loaded.primary?.apiKey).toBe('C');
  });
  ```

**Depends on:** Task §1.1 (must be applied first so `disableEncryption` uses `sanitizeSettingsForStorage`, and test file modifications don't conflict)
**Blocks:** none

**Observed but out of scope:** `enableEncryption()` (line 136) has a similar fire-and-forget pattern with `encryptJSON` but is called far less frequently (only on toggle, not on every keystroke), so the race risk is negligible. Not fixing in this task to minimize blast radius.

---

### Task §2.2 — Wire `saveQueue.ts` into document and board save paths

**Files in scope:**
- [`src/lib/autosave.ts`](file:///c:/Fenix-main/src/lib/autosave.ts) (refactor to use `saveQueue`)
- [`src/lib/cache/saveQueue.ts`](file:///c:/Fenix-main/src/lib/cache/saveQueue.ts) (already built, no changes needed)
- [`src/lib/cache/debouncedSave.ts`](file:///c:/Fenix-main/src/lib/cache/debouncedSave.ts) (still used for local draft writes; its Supabase `saveFn` callback gets routed through the queue)
- [`src/components/SystemArchitect/SystemArchitect.tsx`](file:///c:/Fenix-main/src/components/SystemArchitect/SystemArchitect.tsx) (lines 159–177 — inline autosave uses `createDebouncedSaver` directly)
- [`src/hooks/useDocuments.tsx`](file:///c:/Fenix-main/src/hooks/useDocuments.tsx) (lines 79–96 — `updateDocument` mutation needs `updated_at` guard)
- [`src/hooks/useSystemDesigns.tsx`](file:///c:/Fenix-main/src/hooks/useSystemDesigns.tsx) (lines 87–110 — `updateDesign` mutation needs `updated_at` guard)

**Reasoning summary:**

- **Current behavior:** Both `Editor.tsx` (via `useAutoSave` → `debouncedSave`) and `SystemArchitect.tsx` (via direct `createDebouncedSaver`) debounce saves and fire them to Supabase. Neither enforces serial execution — concurrent saves can resolve out of order. Neither checks `updated_at` — stale writes silently overwrite newer data. Meanwhile, `saveQueue.ts` implements exactly the serial queue with version tracking that's needed, has 4 passing tests, but is never imported by any application code.

- **Root cause:** `saveQueue.ts` was built (and tested) but never wired into the actual save paths. The `debouncedSave.ts` module handles the debounce+draft-write layer, and its `saveFn` callback goes directly to the Supabase mutation without passing through the queue.

- **Blast radius found:** `debouncedSave` is used by: (1) `autosave.ts:14` (used by `Editor.tsx:7`), (2) `SystemArchitect.tsx:30`. Both must route their Supabase save through `saveQueue`. The Supabase mutations (`useDocuments.tsx:79–96`, `useSystemDesigns.tsx:87–110`) both return `updated_at` from the response but never use it for a guard clause.

- **Constraints:** (1) `debouncedSave.ts` must continue handling the local draft write (Tier 1) — only the remote save callback changes. (2) `saveQueue.ts` API must not change — it already has the right interface (`enqueue(payload) → Promise<SaveResult>`). (3) Must not change the `SavePayload` or `SaveResult` interfaces. (4) Existing edge-cases tests for `saveQueue` must pass unchanged.

- **Design chosen:** (A) In `autosave.ts`, create a `saveQueue` instance and route the `onSave` callback through `queue.enqueue()`. (B) In `SystemArchitect.tsx`, similarly create a queue instance. (C) In `useDocuments.tsx` and `useSystemDesigns.tsx`, add `.eq('updated_at', expectedUpdatedAt)` exact-match guard to the `.update()` call so Supabase rejects stale writes at the DB level. An exact-match guard (not `.lte()` or `.gt()`) is the correct optimistic-concurrency pattern here because `expectedUpdatedAt` is always the byte-for-byte `updated_at` string last returned by Supabase from a prior `.select('updated_at')` response — it is never a locally-computed or rounded value. Specifically: `useDocuments.tsx:91` returns `data.updated_at as string` and `useSystemDesigns.tsx:98` returns `data` which includes `updated_at` from `.select()`. These exact strings are stored in `saveQueue.ts`'s `versions` Map (line 57: `versions.set(payload.id, result.updated_at)`) and passed back via `getVersion()`. Alternative rejected: `.lte('updated_at', expectedUpdatedAt)` — this is a range comparison, not a true version guard. It happens to work when timestamps only increase, but it would incorrectly allow writes through if a client sends a timestamp newer than the DB value (e.g., clock skew), and it does not self-document as an optimistic-concurrency check.

**Implementation steps:**

1. In `src/lib/autosave.ts`, import `createSaveQueue`:
   ```ts
   import { createSaveQueue } from './cache/saveQueue';
   ```
   Inside the `useAutoSave` hook, create a queue ref and route the debounced `saveFn` through it. The `onSave` callback provided by the consumer returns `{ updated_at }` — adapt it to match `SaveResult`.

2. In `src/components/SystemArchitect/SystemArchitect.tsx`, import `createSaveQueue` and create a queue ref alongside the existing `saverRef`. Route the `onSaveRef.current(boardState)` call through `queue.enqueue()`.

3. In `src/hooks/useDocuments.tsx`, `updateDocumentMutation.mutationFn`: accept an optional `expectedUpdatedAt` field in the updates parameter and add `.eq('updated_at', expectedUpdatedAt)` when provided:
   ```ts
   let query = supabase.from('documents').update(rest).eq('id', id);
   if (expectedUpdatedAt) {
     query = query.eq('updated_at', expectedUpdatedAt);
   }
   ```
   The `expectedUpdatedAt` value originates from `saveQueue.getVersion(docId)`, which stores the exact `data.updated_at` string returned by the previous successful `.select('updated_at').single()` call at line 87–88 of this same mutation. It is a byte-for-byte copy of what Postgres has, so `.eq()` will match precisely.

4. In `src/hooks/useSystemDesigns.tsx`, `updateDesignMutation.mutationFn`: same pattern — accept and use `expectedUpdatedAt` with `.eq()`:
   ```ts
   let query = supabase.from('system_designs').update(updatePayload).eq('id', id);
   if (expectedUpdatedAt) {
     query = query.eq('updated_at', expectedUpdatedAt);
   }
   ```
   The `expectedUpdatedAt` value originates from `saveQueue.getVersion(designId)`, which stores the exact `updated_at` from the previous `.select().single()` response at line 98.

5. Run `npm test` — existing saveQueue tests plus all 81 tests must pass.

**Acceptance criteria:**
- Document saves from `Editor.tsx` execute serially through the queue — no concurrent Supabase mutations for the same document.
- Board saves from `SystemArchitect.tsx` execute serially through the queue.
- Rapid saves result in the final content persisted, not an intermediate version.
- An update where `expectedUpdatedAt` does not exactly match the current database `updated_at` value is rejected (0 rows affected), regardless of whether the client's timestamp is older or newer than the current value.
- Existing `saveQueue` tests in `edge-cases.test.ts` continue to pass unchanged.

**Test plan:**
- **Automated (existing):** Run `npm test` — the 4 saveQueue tests in `edge-cases.test.ts` must pass.
- **Automated (new):** Add an integration-style test in `edge-cases.test.ts` that creates a debounced saver backed by a saveQueue, fires 3 rapid saves, and verifies only the final version persists and `getVersion()` returns the last `updated_at`.
- **Automated (new — distinguishes `.eq()` from `.lte()`):** Add a test case where `expectedUpdatedAt` is set to a value *newer* than the mock database's current `updated_at` (simulating clock skew or a stale client). Confirm the update is rejected (0 rows / error), not allowed through — this specifically tests that the guard is an exact match, not a range comparison.
- **Manual:** Open editor, type rapidly, check DevTools Network tab — only one Supabase PATCH request should be in-flight at a time.

**Depends on:** none
**Blocks:** Task §2.3 (draft recovery reads back drafts; the save-queue must be in place so recovered drafts don't race with normal saves)

**Observed but out of scope:** The `debouncedSave.ts` `.catch(() => { /* draft stays */ })` on line 60 silently swallows save failures. This is addressed separately in Task §3.3.

---

### Task §2.3 — Implement draft recovery on component mount

**Files in scope:**
- [`src/components/Editor/Editor.tsx`](file:///c:/Fenix-main/src/components/Editor/Editor.tsx) (mount/init — add draft check)
- [`src/components/SystemArchitect/SystemArchitect.tsx`](file:///c:/Fenix-main/src/components/SystemArchitect/SystemArchitect.tsx) (mount/init — add draft check)
- [`src/lib/cache/debouncedSave.ts`](file:///c:/Fenix-main/src/lib/cache/debouncedSave.ts) (no changes — it already writes/clears drafts correctly)

**Reasoning summary:**

- **Current behavior:** Every content change writes a draft to `localStorage` key `artix.draft.{documentId}` (via `debouncedSave.ts:37`). On successful Supabase save, the draft is cleared (`debouncedSave.ts:47`). But on component mount, `Editor.tsx:36-37` initializes state strictly from the `document` prop (Supabase data) and `SystemArchitect.tsx:122-124` initializes from `design.board_state`. Neither checks `localStorage` for a leftover draft. If the tab crashes after the draft write but before the debounced save fires, the draft is lost.

- **Root cause:** The read-back half of the draft mechanism was never built. The write path exists and works correctly; the recovery path does not exist.

- **Blast radius found:** (1) `Editor.tsx` initializes `content` at line 37 as `useState(document.content)`. (2) `SystemArchitect.tsx` initializes board state at line 122–124 from `design.board_state`. (3) The `artix.draft.` key is written with `documentId` in `Editor.tsx` and `design-${design.id}` in `SystemArchitect.tsx`. (4) No other component reads or depends on draft keys.

- **Constraints:** (1) Draft recovery must only occur if the draft content differs from the loaded Supabase content — otherwise it would needlessly trigger autosave on every mount. (2) The draft key format uses `documentId` for Editor and `design-{id}` for SystemArchitect — must match exactly. (3) Must not break the existing autosave flow. (4) Recovery should be automatic (restore silently) — the review suggests "prompt the user to restore" but that requires UI design decisions beyond this hardening pass.

- **Design chosen:** On mount, check `localStorage.getItem('artix.draft.' + id)`. If present and different from the loaded content, use the draft as initial state and immediately trigger a save to flush it to Supabase. If same or absent, proceed as normal. Silent auto-restore chosen over a confirmation dialog to minimize UI changes in this hardening pass.

**Implementation steps:**

1. In `src/components/Editor/Editor.tsx`, modify the initial state setup (around lines 36–37):
   ```ts
   const [content, setContent] = useState(() => {
     try {
       const draft = localStorage.getItem(`artix.draft.${document.id}`);
       if (draft && draft !== document.content) {
         return draft;
       }
     } catch { /* ignore storage errors */ }
     return document.content;
   });
   ```

2. In `src/components/SystemArchitect/SystemArchitect.tsx`, at mount/init (around lines 122–124), add a similar check:
   ```ts
   // Check for recovered draft
   const draftKey = `artix.draft.design-${design.id}`;
   try {
     const draft = localStorage.getItem(draftKey);
     if (draft) {
       const parsedDraft = JSON.parse(draft) as BoardState;
       // Compare — if draft differs from loaded state, use draft
       if (JSON.stringify(parsedDraft) !== JSON.stringify(design.board_state)) {
         // Use draft as initial state
         // (exact integration depends on how board state is initialized in the component)
       }
     }
   } catch { /* ignore parse errors on corrupted drafts */ }
   ```

3. After recovery in both components, trigger an immediate save to flush the recovered draft to Supabase, then clear the draft from `localStorage`.

**Acceptance criteria:**
- If a `artix.draft.{id}` key exists in `localStorage` on component mount and differs from the Supabase-loaded content, the component initializes with the draft content.
- The recovered draft is immediately flushed to Supabase via the normal save path.
- If the draft matches the loaded content, it is silently cleared and no extra save is triggered.
- If no draft exists, behavior is identical to current (no change).

**Test plan:**
- **Automated (new test in `edge-cases.test.ts`):**
  1. Write a draft to `localStorage` with key `artix.draft.test-doc-123` containing "recovered content".
  2. Simulate component mount with `document.content = "old content"`.
  3. Assert that the component state initializes with "recovered content".
  4. Assert that the draft key is cleared after recovery.
- **Manual:** In the editor, type some text. Before the debounce fires (within 1.5s), force-close the tab (kill the process). Reopen the app and navigate to the same document. Verify the typed text appears.

**Depends on:** Task §2.2 (save queue must be in place so the recovery flush goes through the queue)
**Blocks:** none

**Observed but out of scope:** For `SystemArchitect.tsx`, the draft content is a JSON-serialized `BoardState`. If the draft is corrupted JSON, the `JSON.parse` will throw — the catch block handles this by ignoring the draft. This is acceptable for now; Zod validation of `BoardState` is addressed in Task §3.1.

---

### Task §2.4 — Fix or remove `tabCloseGuard` beacon to nonexistent endpoint

> [!IMPORTANT]
> **🔶 DECISION NEEDED — do not implement until human resolves this choice.**

**Files in scope:**
- [`src/lib/cache/tabCloseGuard.ts`](file:///c:/Fenix-main/src/lib/cache/tabCloseGuard.ts)
- [`src/lib/autosave.ts`](file:///c:/Fenix-main/src/lib/autosave.ts) (line 36 — `SAVE_ENDPOINT`, line 55 — creates guard)
- [`src/components/SystemArchitect/SystemArchitect.tsx`](file:///c:/Fenix-main/src/components/SystemArchitect/SystemArchitect.tsx) (line 158 — creates guard)
- [`src/test/edge-cases.test.ts`](file:///c:/Fenix-main/src/test/edge-cases.test.ts) (lines 114–167 — tabCloseGuard tests)

**Reasoning summary:**

- **Current behavior:** `tabCloseGuard.ts` tracks dirty documents. On `beforeunload`, it calls `navigator.sendBeacon('/api/save', payload)` with a fallback to `fetch('/api/save', { method: 'POST', keepalive: true })`. The endpoint `/api/save` does not exist — Artix is a static SPA deployed to Vercel, which rewrites all paths to `index.html`. Every beacon/fetch hits a 404 (or returns the HTML shell).

- **Root cause:** The guard was built anticipating a server-side save endpoint that was never created.

- **Options for human decision:**

  **Option A — Remove the beacon, rely on localStorage draft as the recovery path:**
  - Remove `sendBeacon` and `fetch` logic from `tabCloseGuard.ts`, keeping only the `dirtyDocs` tracking and `markClean`/`markDirty` API (still useful for `beforeunload` warning dialogs).
  - Rationale: With Task §2.3 implementing draft recovery on mount, the `localStorage` draft IS the safety net. The beacon was supposed to be a second safety net, but it never worked.
  - Trade-off: No server-side save on tab close — but since the draft is written synchronously on every keystroke (Tier 1 of debouncedSave), the window of data loss is only between the last keystroke and the `localStorage.setItem` call (effectively zero, since it's synchronous).

  **Option B — Build a real Supabase Edge Function for `/api/save`:**
  - Create `supabase/functions/save-beacon/index.ts` that accepts the beacon payload and writes to Supabase using `service_role`.
  - Rationale: True belt-and-suspenders — if `localStorage` fails or is full, the beacon catches the save.
  - Trade-off: More code, another Edge Function to maintain, and `sendBeacon` has a 64KB payload limit which could be exceeded by large documents.

**Acceptance criteria (both options):**
- No `sendBeacon` or `fetch` calls to a nonexistent endpoint.
- Dirty document tracking still works for `beforeunload` warning.
- The draft recovery path (Task §2.3) provides the actual safety net for unsaved data.

**Depends on:** Task §2.3 (draft recovery must be in place if Option A is chosen)
**Blocks:** none

---

### Task §2.5 — Decide and handle dead `tabSync` / `BroadcastChannel` code

> [!IMPORTANT]
> **🔶 DECISION NEEDED — do not implement until human resolves this choice.**

**Files in scope:**
- [`src/lib/cache/tabSync.ts`](file:///c:/Fenix-main/src/lib/cache/tabSync.ts) (109 lines — entirely unused)
- [`src/test/edge-cases.test.ts`](file:///c:/Fenix-main/src/test/edge-cases.test.ts) (lines 203–250 — tabSync tests)
- Documentation files claiming cross-tab sync is active: `README.md:16`, `DOCS.md:75,190`, `docs/ARCHITECTURE.md:42`, `docs/CHALLENGES_AND_SOLUTIONS.md:17`, `src/pages/Index.tsx:40` (landing page feature card)

**Reasoning summary:**

- **Current behavior:** `createTabSync` implements leader election (via `localStorage` lock) and cross-tab communication (via `BroadcastChannel`). It has unit tests that pass. But it is **never imported or used** by any application code — not by `autosave.ts`, `Editor.tsx`, `SystemArchitect.tsx`, or `ProjectWorkspace.tsx`. Six documentation locations (including the user-facing landing page) describe "cross-tab synchronization" or "multi-tab sync" as a working feature.

- **Additional design issue:** If the module were activated, the leader election has no TTL or heartbeat on the `localStorage` lock. If the leader tab crashes without calling `destroy()`, the lock key `artix.leader.{channel}` persists indefinitely, preventing any other tab from becoming leader.

- **Options for human decision:**

  **Option A — Wire it in properly (with fixes):**
  - Import `createTabSync` in `autosave.ts` and `SystemArchitect.tsx`.
  - Add a TTL/heartbeat to the leader lock (e.g., write a timestamp, check if stale after 10s).
  - Add message deduplication (message IDs or timestamps).
  - Trade-off: Non-trivial integration work — requires careful testing of multi-tab scenarios. The autosave flow must coordinate with tab sync to avoid duplicate saves.

  **Option B — Remove the module and update documentation:**
  - Delete `src/lib/cache/tabSync.ts`.
  - Remove its tests from `edge-cases.test.ts`.
  - Update all 6 documentation references to remove cross-tab sync claims.
  - Update `src/pages/Index.tsx:40` landing page feature card to remove the claim.
  - Trade-off: Loses the feature, but the feature never actually worked. Documentation becomes honest.

  **Option C — Keep the code, update documentation to say "planned":**
  - Keep `tabSync.ts` and its tests as-is.
  - Update documentation to say "cross-tab sync (planned)" or remove the claim entirely.
  - Trade-off: Retains dead code but at least doesn't mislead users.

**Acceptance criteria (all options):**
- No documentation claims a feature that doesn't exist.
- If wired in (Option A), leader election has TTL protection against dead locks.

**Depends on:** Task §2.2 (save queue must be in place before tab sync can coordinate saves)
**Blocks:** none

---

### Task §2.6 — Add React Error Boundaries

**Files in scope:**
- [`src/App.tsx`](file:///c:/Fenix-main/src/App.tsx) (wrap routes in a top-level boundary)
- New file: `src/components/ErrorBoundary.tsx`

**Reasoning summary:**

- **Current behavior:** Zero `ErrorBoundary`, `componentDidCatch`, or `getDerivedStateFromError` anywhere in the codebase. `react-error-boundary` is not in `package.json`. Any unhandled React render error crashes the entire app to a blank white screen with no recovery path.

- **Root cause:** Error boundaries were never added. The app relies entirely on normal React rendering without a safety net.

- **Blast radius found:** The component tree (from `main.tsx`) is: `StrictMode > QueryClientProvider > BrowserRouter > AuthProvider > ThemeProvider > App > Suspense > Routes > [8 route components]`. Highest-risk render trees: `ProjectWorkspace` (contains Monaco Editor via `Editor.tsx` and React Flow via `SystemArchitect.tsx`), which are the most complex components and most likely to encounter unexpected render errors.

- **Constraints:** (1) No new dependencies — must implement Error Boundary as a React class component (the `componentDidCatch` API is class-only). (2) The boundary must offer a recovery action (e.g., "reload page" or "go to dashboard") so users aren't stuck. (3) Must not catch errors in event handlers (Error Boundaries only catch render/lifecycle errors — this is a React design constraint).

- **Design chosen:** (A) Create a reusable `ErrorBoundary` class component in `src/components/ErrorBoundary.tsx` with a fallback UI showing an error message and a "Reload" button. (B) Wrap the `<Routes>` block in `App.tsx` with this boundary (catches all route-level render errors). This provides blanket coverage with a single insertion point. Alternative rejected: Adding targeted boundaries around Monaco and React Flow individually — this would be ideal but requires examining those components' exact crash modes, which is beyond the scope of this hardening task. The top-level boundary is the minimum viable safety net.

**Implementation steps:**

1. Create `src/components/ErrorBoundary.tsx`:
   ```tsx
   import React, { Component, ErrorInfo, ReactNode } from 'react';

   interface Props {
     children: ReactNode;
     fallback?: ReactNode;
   }

   interface State {
     hasError: boolean;
     error: Error | null;
   }

   export class ErrorBoundary extends Component<Props, State> {
     constructor(props: Props) {
       super(props);
       this.state = { hasError: false, error: null };
     }

     static getDerivedStateFromError(error: Error): State {
       return { hasError: true, error };
     }

     componentDidCatch(error: Error, errorInfo: ErrorInfo) {
       console.error('ErrorBoundary caught:', error, errorInfo);
     }

     render() {
       if (this.state.hasError) {
         if (this.props.fallback) return this.props.fallback;
         return (
           <div style={{ padding: '2rem', textAlign: 'center' }}>
             <h2>Something went wrong</h2>
             <p style={{ color: '#888', margin: '1rem 0' }}>
               {this.state.error?.message || 'An unexpected error occurred.'}
             </p>
             <button
               onClick={() => window.location.reload()}
               style={{ padding: '0.5rem 1rem', cursor: 'pointer' }}
             >
               Reload Page
             </button>
           </div>
         );
       }
       return this.props.children;
     }
   }
   ```

2. In `src/App.tsx`, import `ErrorBoundary` and wrap the `<Suspense>` block:
   ```tsx
   import { ErrorBoundary } from './components/ErrorBoundary';
   // ...
   <ErrorBoundary>
     <Suspense fallback={<PageFallback />}>
       <Routes>
         {/* ... existing routes ... */}
       </Routes>
     </Suspense>
   </ErrorBoundary>
   ```

**Acceptance criteria:**
- A rendering error in any route component shows the fallback UI (error message + reload button) instead of a blank white screen.
- The error is logged to `console.error` with component stack trace.
- The user can recover by clicking "Reload Page".
- Normal rendering is unaffected (boundary is transparent when no error occurs).
- All 81 existing tests pass.

**Test plan:**
- **Automated (new test):** Add a test in a new or existing test file that renders `<ErrorBoundary>` wrapping a component that throws during render, and asserts the fallback UI appears:
  ```tsx
  it('renders fallback UI on child render error', () => {
    const ThrowingComponent = () => { throw new Error('test crash'); };
    const { getByText } = render(
      <ErrorBoundary><ThrowingComponent /></ErrorBoundary>
    );
    expect(getByText('Something went wrong')).toBeTruthy();
  });
  ```
- **Manual:** In the editor, temporarily add `throw new Error('test')` inside a component's render. Verify the error boundary catches it and shows the fallback.

**Depends on:** none
**Blocks:** none

**Observed but out of scope:** Targeted error boundaries around Monaco Editor and React Flow would provide better UX (component-level recovery instead of page-level). This is a good follow-up but requires understanding each library's error modes — not in scope for this hardening pass.

---

### Task §2.7 — Guard all `localStorage.setItem` calls with try/catch

**Files in scope:**
- [`src/lib/ai/storage.ts`](file:///c:/Fenix-main/src/lib/ai/storage.ts) (lines 94, 100, 142, 155, 171 — 5 unguarded calls)
- [`src/hooks/useTheme.tsx`](file:///c:/Fenix-main/src/hooks/useTheme.tsx) (line 19)
- [`src/components/PWAInstallPrompt.tsx`](file:///c:/Fenix-main/src/components/PWAInstallPrompt.tsx) (line 41)
- [`src/components/APIUsageView.tsx`](file:///c:/Fenix-main/src/components/APIUsageView.tsx) (lines 32, 39)
- [`src/lib/cache/tabSync.ts`](file:///c:/Fenix-main/src/lib/cache/tabSync.ts) (line 51)

**Reasoning summary:**

- **Current behavior:** 10 of 13 production `localStorage.setItem` calls have no `try/catch`. A `QuotaExceededError` (storage full) or `SecurityError` (private browsing restrictions) will throw uncaught, potentially crashing the component or leaving the app in a broken state. Highest risk: `useTheme.tsx:19` runs on every mount — a failure here crashes the entire app before any content renders.

- **Root cause:** `localStorage.setItem` can throw in browsers under storage pressure or privacy settings, but the calls were written assuming success.

- **Blast radius found:** `debouncedSave.ts:37` already has the correct pattern (`try { localStorage.setItem(...) } catch { /* silently ignore */ }`). The 10 unguarded calls are in 5 files listed above. The fix pattern is the same for all: wrap in try/catch, silently ignore for non-critical writes (theme, PWA, usage), log for critical writes (settings).

- **Constraints:** (1) For `storage.ts` encrypted writes, a failed `localStorage.setItem` means the encrypted data is lost — this should throw/surface, not silently swallow. (2) For theme/PWA/usage writes, failure is cosmetic — silently ignore. (3) `tabSync.ts` lock write failure means leader election fails — silently ignore and fall back to non-leader mode.

- **Design chosen:** Wrap each call in try/catch. For `storage.ts`, re-throw with a descriptive message. For all others, silently ignore. This matches the existing pattern in `debouncedSave.ts`.

**Implementation steps:**

1. In `src/hooks/useTheme.tsx:19`, wrap in try/catch:
   ```ts
   try { localStorage.setItem('artix-theme', theme); } catch { /* ignore */ }
   ```

2. In `src/components/PWAInstallPrompt.tsx:41`, wrap:
   ```ts
   try { localStorage.setItem('pwa-install-dismissed', 'true'); } catch { /* ignore */ }
   ```

3. In `src/components/APIUsageView.tsx:32` and `:39`, wrap both:
   ```ts
   try { localStorage.setItem('artix.ai.usage.v1', JSON.stringify(initial)); } catch { /* ignore */ }
   ```

4. In `src/lib/cache/tabSync.ts:51`, wrap:
   ```ts
   try { localStorage.setItem(lockKey, tabId); } catch { return false; }
   ```

5. In `src/lib/ai/storage.ts`, for lines 94, 100, 142, 155, 171 — wrap each in try/catch that re-throws with context:
   ```ts
   try {
     localStorage.setItem(ENC_KEY, JSON.stringify(blob));
   } catch (e) {
     throw new Error('Failed to save encrypted settings to localStorage: ' + (e instanceof Error ? e.message : String(e)));
   }
   ```
   (Repeat pattern for all 5 calls in storage.ts.)

**Acceptance criteria:**
- All 13 production `localStorage.setItem` calls are wrapped in try/catch.
- Non-critical writes (theme, PWA, usage, tab lock) silently ignore failures.
- Critical writes (AI settings) re-throw with descriptive error messages.
- All 81 tests pass.

**Test plan:**
- **Automated (new):** In `edge-cases.test.ts`, add a test that mocks `localStorage.setItem` to throw `QuotaExceededError`, then calls `saveSettings()` and asserts it throws with the descriptive message.
- **Manual:** In Chrome DevTools, use Application → Storage → simulate quota exceeded → verify the app doesn't crash on theme changes, PWA dismissal, etc.

**Depends on:** Task §2.1 (some `storage.ts` calls will be modified by §2.1; apply §2.7 guards after §2.1's changes)
**Blocks:** none

**Observed but out of scope:** `localStorage.getItem` and `localStorage.removeItem` can also throw (rarely). Not wrapping those in this task to keep scope minimal.

---

### Task §2.8 — Fix or relabel fabricated usage/budget dashboard data

> [!IMPORTANT]
> **🔶 DECISION NEEDED — do not implement until human resolves this choice.**

**Files in scope:**
- [`src/components/APIUsageView.tsx`](file:///c:/Fenix-main/src/components/APIUsageView.tsx) (lines 18–39 — hardcoded seed data)
- Potentially: [`src/lib/ai/registry.ts`](file:///c:/Fenix-main/src/lib/ai/registry.ts) or AI provider files (if wiring real usage tracking)

**Reasoning summary:**

- **Current behavior:** `APIUsageView` displays a \$10.00 budget (hardcoded `useState(10.00)`) and seeds fake usage data (`inputTokens: 245000, outputTokens: 98000`) on first load if no `artix.ai.usage.v1` key exists. The `artix.ai.usage.v1` key is **never written to by any AI call path** — confirmed by searching the entire codebase. The view shows fabricated data that never changes (unless the user clicks "Reset Usage" which just resets to 0).

- **The view is rendered in `Dashboard.tsx:221`** inside the "API Usage" nav item, reachable only on desktop.

- **Options for human decision:**

  **Option A — Wire real token tracking from AI responses:**
  - After each `callAI`/`streamAI` call in `registry.ts` or the provider files, extract `usage.prompt_tokens` and `usage.completion_tokens` from the response and write to `artix.ai.usage.v1`.
  - Trade-off: Requires modifying the AI provider layer. Token counting differs per provider (OpenAI returns usage in response, Anthropic in headers, Google in metadata, streaming may not return usage at all). Non-trivial to do correctly across all providers.

  **Option B — Relabel as estimated/illustrative:**
  - Remove the hardcoded seed data. Start with zeros.
  - Add a clear label: "Estimated Usage (not connected to real billing)".
  - Remove the \$10 budget or label it "Example budget".
  - Trade-off: Simple, honest, no provider changes needed. Loses the "looks real" dashboard feel.

  **Option C — Remove the view entirely:**
  - Remove `APIUsageView.tsx` and the "API Usage" nav item from `DashboardSidebar.tsx`.
  - Trade-off: Cleanest, but loses a UI element that could be valuable later.

**Acceptance criteria (all options):**
- No fabricated data is presented as real usage.
- If real tracking (Option A): token counts update after each AI call.
- If relabeled (Option B): UI clearly indicates data is illustrative.

**Depends on:** none
**Blocks:** none

---

# Phase 3 — Validation & Type Safety

---

### Task §3.1 — Add Zod runtime validation at critical data boundaries

**Files in scope:**
- [`src/lib/ai/storage.ts`](file:///c:/Fenix-main/src/lib/ai/storage.ts) (lines 74, 78 — `JSON.parse(raw) as AISettings`)
- [`src/lib/ai/types.ts`](file:///c:/Fenix-main/src/lib/ai/types.ts) (lines 53–56 — `AISettings` interface; add Zod schema alongside)
- [`src/hooks/useSystemDesigns.tsx`](file:///c:/Fenix-main/src/hooks/useSystemDesigns.tsx) (lines 5–23 — `BoardState` interface; add Zod schema for draft recovery parsing)

**Reasoning summary:**

- **Current behavior:** Zod (`^3.25.76`) is installed and used in exactly one file: `src/pages/Auth.tsx` for form validation. All other trust boundaries use `JSON.parse(raw) as SomeType` — unguarded type assertions that provide zero runtime safety. If `localStorage` data is corrupted, manually tampered, or structurally wrong, the app proceeds with malformed data and eventually crashes in unpredictable places.

- **Root cause:** Zod schemas were never defined for `AISettings` or `BoardState`. The library is available but unused outside `Auth.tsx`.

- **Blast radius found:** The most critical boundaries are: (1) `storage.ts:74,78` — loading AI settings from localStorage (4 `as AISettings` casts). (2) `storage.ts:122,153,168` — parsing encrypted blobs from localStorage (3 `as EncryptedBlob` casts). (3) `SystemArchitect.tsx:164` — parsing draft content as `BoardState`. (4) `useSystemDesigns.tsx:54,78,104` — casting Supabase response `board_state` as `BoardState`. The review recommends starting with `AISettings` and `BoardState` schemas — not covering all 16 `JSON.parse` calls at once.

- **Constraints:** (1) Must not change the `AISettings` or `BoardState` TypeScript interfaces — the Zod schema must match them exactly. (2) Use `.safeParse()` with fallback, not `.parse()` that throws — corrupted data should degrade gracefully, not crash. (3) Streaming chunk parsers (`streaming.ts`, `anthropic.ts`, `google.ts`) are NOT in scope for this task — they handle partial/malformed data differently (drop and continue). (4) No new dependencies — Zod is already installed.

- **Design chosen:** (A) Define `AISettingsSchema` in `src/lib/ai/types.ts` next to the interface. (B) Define `BoardStateSchema` in `src/hooks/useSystemDesigns.tsx` next to the interface. (C) In `storage.ts` `loadSettings()`, replace `JSON.parse(raw) as AISettings` with `AISettingsSchema.safeParse(JSON.parse(raw))` — on failure, log a warning and return `{}`. (D) In `SystemArchitect.tsx` draft recovery (Task §2.3) and `useSystemDesigns.tsx` Supabase response parsing, use `BoardStateSchema.safeParse()`. Alternative rejected: Creating a separate `schemas.ts` file — co-locating schemas with their interfaces keeps the relationship obvious and avoids a new file.

**Implementation steps:**

1. In `src/lib/ai/types.ts`, after the existing `AISettings` interface (line 56), add:
   ```ts
   import { z } from 'zod';

   const providerIdSchema = z.enum(['openai', 'anthropic', 'google', 'groq', 'openrouter', 'ollama']);

   const aiSlotSchema = z.object({
     provider: providerIdSchema,
     model: z.string(),
     apiKey: z.string(),
     baseUrl: z.string().optional(),
   });

   export const AISettingsSchema = z.object({
     primary: aiSlotSchema.optional(),
     backup: aiSlotSchema.optional(),
   });
   ```

2. In `src/hooks/useSystemDesigns.tsx`, after the existing `BoardState` interface (line 23), add:
   ```ts
   import { z } from 'zod';

   export const BoardStateSchema = z.object({
     nodes: z.array(z.object({
       id: z.string(),
       type: z.string(),
       position: z.object({ x: z.number(), y: z.number() }),
       data: z.object({ label: z.string(), description: z.string().optional() }),
     })),
     edges: z.array(z.object({
       id: z.string(),
       source: z.string(),
       target: z.string(),
       label: z.string().optional(),
     })),
     strokes: z.array(z.object({
       points: z.array(z.object({ x: z.number(), y: z.number() })),
       color: z.string(),
       width: z.number(),
     })).optional(),
   });
   ```

3. In `src/lib/ai/storage.ts` `loadSettings()`, replace the two `JSON.parse(raw) as AISettings` calls (lines 74, 78) with:
   ```ts
   const parsed = AISettingsSchema.safeParse(JSON.parse(raw));
   if (!parsed.success) {
     console.warn('Corrupt AI settings in localStorage, resetting:', parsed.error.message);
     return {};
   }
   return restoreSettingsFromStorage(parsed.data);
   ```
   Import `AISettingsSchema` from `../ai/types`.

4. Similarly, add `EncryptedBlobSchema` validation for the 3 `as EncryptedBlob` casts (lines 122, 153, 168):
   ```ts
   const EncryptedBlobSchema = z.object({
     v: z.literal(1),
     salt: z.string(),
     iv: z.string(),
     ct: z.string(),
   });
   ```

**Acceptance criteria:**
- Corrupted `artix.ai.settings.v1` in localStorage (e.g. `"hello"`, `null`, `{"primary": 123}`) results in a console warning and graceful fallback to `{}`, not a crash.
- Valid settings load correctly as before.
- Valid and invalid `BoardState` JSON is handled gracefully in draft recovery.
- All existing tests pass.

**Test plan:**
- **Automated (new in `api-saving.test.ts`):**
  ```ts
  it('should handle corrupt localStorage settings gracefully', () => {
    localStorage.setItem('artix.ai.settings.v1', '{"primary": "not-an-object"}');
    const settings = loadSettings();
    expect(settings).toEqual({});
  });

  it('should handle invalid JSON in localStorage gracefully', () => {
    localStorage.setItem('artix.ai.settings.v1', 'not-json-at-all');
    const settings = loadSettings();
    expect(settings).toEqual({});
  });
  ```

**Depends on:** Task §2.1 (storage.ts `loadSettings` may be affected by async changes)
**Blocks:** none

**Observed but out of scope:** The 3 streaming chunk parsers (`streaming.ts`, `anthropic.ts`, `google.ts`) use `JSON.parse` with silent catch — this is actually appropriate for SSE stream chunks where partial/malformed data is expected during streaming. Adding Zod validation per-chunk would add latency for no benefit.

---

### Task §3.2 — Enable TypeScript strict mode incrementally

**Files in scope:**
- [`tsconfig.app.json`](file:///c:/Fenix-main/tsconfig.app.json) (the config governing `src/`)
- [`tsconfig.json`](file:///c:/Fenix-main/tsconfig.json) (root config — has `strictNullChecks: false`)
- Potentially **many files in `src/`** (143 `.ts`/`.tsx` files) that may need type fixes

**Reasoning summary:**

- **Current behavior:** `tsconfig.app.json` has `strict: false`, `strictNullChecks: false`, `noImplicitAny: false`, `noUnusedLocals: false`, `noUnusedParameters: false`, `noFallthroughCasesInSwitch: false`. TypeScript cannot catch null/undefined misuse, implicit `any`, unused bindings, or switch fallthrough anywhere in the 143 source files.

- **Root cause:** The project was bootstrapped with a permissive config and never tightened.

- **Blast radius found:** Enabling `strict: true` all at once on 143 files will likely produce hundreds of type errors. The review specifically recommends `strictNullChecks` first, then the rest incrementally.

- **Constraints:** (1) Must not block the build — the project must continue to build and all tests must pass after each flag is enabled. (2) This is potentially a high-churn task depending on how many null-check errors exist. (3) This task should be planned but the exact file-level fixes cannot be enumerated without running the compiler — the plan should specify the process, not pre-list every fix.

- **Design chosen:** A two-step rollout: (A) Step 1: Enable `strictNullChecks: true` in `tsconfig.app.json`, fix all resulting errors, verify build + tests pass. (B) Step 2: Enable `strict: true` (which includes `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitThis`, `alwaysStrict`), fix remaining errors. `noImplicitAny` is deferred — it requires the most changes and is lower-value than null checks.

**Implementation steps:**

1. **Step 1 — `strictNullChecks`:**
   - In `tsconfig.app.json`, set `"strictNullChecks": true`.
   - In `tsconfig.json`, change `"strictNullChecks": false` to `"strictNullChecks": true`.
   - Run `npx tsc --noEmit`. Collect all errors.
   - Fix each error using the narrowest correct fix: null guard (`if (x)` / `x ?? default`), non-null assertion only where provably safe, or optional chaining.
   - Run `npm run build` and `npm test` after all fixes.

2. **Step 2 — `strict: true`:**
   - In `tsconfig.app.json`, set `"strict": true`. Remove the individual `"noImplicitAny": false` line.
   - Run `npx tsc --noEmit`. Fix remaining errors.
   - Run `npm run build` and `npm test`.

**Acceptance criteria:**
- `tsconfig.app.json` has `"strict": true` (or at minimum `"strictNullChecks": true` after Step 1).
- `npm run build` succeeds with zero type errors.
- All tests pass.

**Test plan:**
- **Automated:** `npx tsc --noEmit` returns exit code 0. `npm run build` succeeds. `npm test` passes.

**Depends on:** Tasks §3.1 (Zod schemas may introduce type changes that interact with strict mode)
**Blocks:** none

**Observed but out of scope:** Enabling `noUnusedLocals` and `noUnusedParameters` would flag dead variables/params — useful but separate from type safety. Not included in this task.

---

### Task §3.3 — Surface silently-swallowed errors in critical paths

**Files in scope:**
- [`src/lib/ai/storage.ts`](file:///c:/Fenix-main/src/lib/ai/storage.ts) (lines 25–27, 35–37, 79–81 — obfuscation + settings load)
- [`src/lib/cache/debouncedSave.ts`](file:///c:/Fenix-main/src/lib/cache/debouncedSave.ts) (line 60 — DB save `.catch(() => {})`)
- [`src/components/AI/PRDGeneratorDialog.tsx`](file:///c:/Fenix-main/src/components/AI/PRDGeneratorDialog.tsx) (line 113)
- [`src/components/AI/VibeCodingDialog.tsx`](file:///c:/Fenix-main/src/components/AI/VibeCodingDialog.tsx) (line 121)
- [`src/components/AI/AgenticWorkflowDialog.tsx`](file:///c:/Fenix-main/src/components/AI/AgenticWorkflowDialog.tsx) (line 120)

**Reasoning summary:**

- **Current behavior:** 16 catch blocks across `src/` silently swallow errors. Of these, 11 are in critical paths (saving data, loading settings, AI responses). The most dangerous are: (1) `storage.ts:79` — corrupt settings silently return `{}`, erasing all user config with zero diagnostic. (2) `debouncedSave.ts:60` — a failed Supabase save is silently swallowed with no UI feedback. (3) Three AI dialog history saves (`PRDGenerator`, `VibeCoding`, `AgenticWorkflow`) silently drop history records.

- **Root cause:** The original code prioritized "don't crash" over "tell someone something went wrong." This is appropriate for some catch blocks (SSE stream chunk parsing, iframe detection, draft cleanup) but not for data persistence failures.

- **Blast radius found:** The 16 catch blocks fall into two categories: (A) **Critical paths** — 11 blocks where failure information matters and should at minimum reach `console.error`. (B) **Cosmetic/intentional** — 5 blocks where silent failure is the correct behavior (SSE chunk drops during streaming, queue tail suppression, iframe check, draft cleanup).

- **Constraints:** (1) Stream chunk parsers (`streaming.ts:37`, `anthropic.ts:83`, `google.ts:91`) should remain silent — dropping a single malformed SSE chunk is expected during streaming. (2) `saveQueue.ts:50` `.catch(() => {})` is correct by design — the caller's promise is separately returned and throws properly. (3) `main.tsx:14` iframe check is correct — `SecurityError` from cross-origin access is expected. (4) `debouncedSave.ts:48` draft cleanup is correctly silent.

- **Design chosen:** Add `console.error` with context to the 6 highest-impact silent catch blocks. Do NOT add user-facing toasts (that's a UX decision). Do NOT touch the 5 intentionally-silent blocks. The 3 dialog history blocks get `console.error` so debugging is possible, but they remain non-throwing since the generation output was already shown to the user.

**Implementation steps:**

1. In `src/lib/ai/storage.ts:79`, change:
   ```ts
   } catch {
     return {};
   }
   ```
   to:
   ```ts
   } catch (e) {
     console.error('Failed to load AI settings from localStorage:', e);
     return {};
   }
   ```

2. In `src/lib/ai/storage.ts:25` (obfuscate) and `:35` (deobfuscate), add `console.warn`:
   ```ts
   } catch (e) {
     console.warn('Base64 encoding/decoding failed:', e);
     return key; // or stored
   }
   ```

3. In `src/lib/cache/debouncedSave.ts:60`, change:
   ```ts
   .catch(() => {
     // Save failed — draft stays in localStorage for crash recovery
   });
   ```
   to:
   ```ts
   .catch((e) => {
     console.error('Database save failed, draft retained in localStorage:', e);
   });
   ```

4. In the three AI dialog files (`PRDGeneratorDialog.tsx:113`, `VibeCodingDialog.tsx:121`, `AgenticWorkflowDialog.tsx:120`), change:
   ```ts
   } catch {
     /* best effort */
   }
   ```
   to:
   ```ts
   } catch (e) {
     console.error('Failed to save generation history:', e);
   }
   ```

**Acceptance criteria:**
- Critical-path failures produce `console.error` messages with the error object.
- Intentionally-silent catch blocks (streaming, queue tail, iframe, draft cleanup) remain unchanged.
- No user-facing behavior changes (no new toasts or error dialogs).
- All tests pass.

**Test plan:**
- **Automated:** Run `npm test` — no test changes needed since we're only adding console output.
- **Manual:** In DevTools, simulate a localStorage quota error during settings save → verify `console.error` appears with descriptive message. Simulate a Supabase outage during autosave → verify `console.error` appears.

**Depends on:** none
**Blocks:** none

**Observed but out of scope:** The `storage.ts:79` `catch { return {}; }` effectively resets all user settings on any localStorage corruption. The fix in this task adds logging but still returns `{}`. A better UX would be to show the user a toast ("Settings could not be loaded — they may have been reset"). That's a UX decision, not a code hardening fix, so it's out of scope.

---

# Phase 4 — Repository Cleanup

---

### Task §3.4 — Fix package metadata, lockfiles, README links, and legacy naming

**Files in scope:**
- [`package.json`](file:///c:/Fenix-main/package.json) (lines 2, 4 — `name`, `version`, add missing fields)
- Root directory: delete `bun.lock` and `bun.lockb` (or `package-lock.json`, depending on chosen package manager)
- [`README.md`](file:///c:/Fenix-main/README.md) (line 45 — `file:///c:/Fenix-main/DOCS.md` link)
- [`DOCS.md`](file:///c:/Fenix-main/DOCS.md) (line 159 — `c:/Fenix-main/` path)
- [`docs/PROJECT_FILE_STRUCTURE.md`](file:///c:/Fenix-main/docs/PROJECT_FILE_STRUCTURE.md) (line 10 — `c:/Fenix-main/` path)
- [`.gitignore`](file:///c:/Fenix-main/.gitignore) (add entry for non-canonical lockfiles)

**Reasoning summary:**

- **Current behavior:** (1) `package.json` has `name: "vite_react_shadcn_ts"` and `version: "0.0.0"` — the original Vite scaffold defaults. No `description`, `author`, `license`, or `repository` fields. (2) Three lockfiles coexist: `bun.lock` (301KB), `bun.lockb` (245KB), `package-lock.json` (507KB). (3) `README.md:45` contains `file:///c:/Fenix-main/DOCS.md` — a local filesystem link that won't work for anyone on GitHub. (4) `DOCS.md:159` and `docs/PROJECT_FILE_STRUCTURE.md:10` contain `c:/Fenix-main/` in directory tree diagrams.

- **Root cause:** Standard project-setup hygiene that was never done after initial scaffolding and renaming from Fenix to Artix.

- **Blast radius found:** (1) `fenix`/`Fenix` references: 37 matches total. 5 are migration code in `storage.ts` (must keep). 10 are test assertions for migration/branding (must keep). 3 are documentation paths (`README.md`, `DOCS.md`, `PROJECT_FILE_STRUCTURE.md`) — change to `Artix`. The rest are in the review files themselves (not app code). (2) No UI text contains "Fenix" — branding is clean. (3) `.gitignore` does not exclude any lockfiles.

- **Constraints:** (1) Migration keys `fenix.ai.settings.v1` and `fenix.ai.settings.enc.v1` in `storage.ts` MUST stay — they're required for backward compatibility with existing users. (2) Branding tests in `branding.test.ts` that assert "Fenix" is absent from UI MUST stay — they prevent regression. (3) Must choose one package manager and commit to it.

- **Design chosen:** (A) Update `package.json` metadata. (B) Choose `npm` as the canonical package manager (it's what the CI scripts use: `npm run lint`, `npm test`, `npm run build`), keep `package-lock.json`, delete `bun.lock` and `bun.lockb`. (C) Fix all `file:///` and `c:/Fenix-main/` references in docs. (D) Add `bun.lock*` to `.gitignore`.

**Implementation steps:**

1. In `package.json`, update lines 2 and 4:
   ```json
   "name": "artix",
   "version": "1.0.0",
   ```
   Add after `"private": true`:
   ```json
   "description": "Developer command center with AI-assisted technical design, encrypted credential storage, and persistent workspaces",
   "author": "Yousef-eng679",
   "license": "MIT",
   "repository": {
     "type": "git",
     "url": "https://github.com/Yousef-eng679/Artix.git"
   },
   ```

2. Delete `bun.lock` and `bun.lockb` from the repo root:
   ```bash
   git rm bun.lock bun.lockb
   ```

3. Add to `.gitignore`:
   ```
   bun.lock
   bun.lockb
   ```

4. In `README.md:45`, change:
   ```md
   [DOCS.md](file:///c:/Fenix-main/DOCS.md)
   ```
   to:
   ```md
   [DOCS.md](./DOCS.md)
   ```

5. In `DOCS.md:159`, change `c:/Fenix-main/` to `artix/` (or simply `.`) in the directory tree diagram.

6. In `docs/PROJECT_FILE_STRUCTURE.md:10`, change `c:/Fenix-main/` to `artix/` in the directory tree diagram.

**Acceptance criteria:**
- `package.json` `name` is `"artix"`, `version` is `"1.0.0"`, and metadata fields are populated.
- Only one lockfile exists: `package-lock.json`.
- No `file:///` links in `README.md`.
- No `c:/Fenix-main/` paths in documentation (except the review files, which are not app docs).
- Migration code for `fenix.ai.settings.*` keys remains intact.
- All tests pass (including branding tests that assert "Fenix" is absent from UI).

**Test plan:**
- **Automated:** Run `npm test` — branding tests must pass. Run `npm run build` — build must succeed.
- **Manual:** Open `README.md` on GitHub → click the DOCS.md link → verify it resolves to the correct file (not a 404 or `file:///` error).

**Depends on:** none (can be done in parallel with any phase, but per the review's ordering, done last)
**Blocks:** none

**Observed but out of scope:** The `LICENSE` file itself was not checked — if the repo claims MIT in `package.json`, a `LICENSE` file should exist at the root. This is a documentation task beyond the review's scope.

---

# Open Decisions Requiring Human Input Before Implementation

| # | Task | Decision | Options | Trade-offs |
|:---:|:---|:---|:---|:---|
| 1 | §2.4 | Tab close guard: fix or remove? | **A:** Remove beacon, rely on localStorage draft | Simple, draft recovery (§2.3) is the real safety net. Loss: no server-side last-resort save. |
| | | | **B:** Build a real Edge Function | Belt-and-suspenders, but more code + 64KB payload limit on `sendBeacon`. |
| 2 | §2.5 | Cross-tab sync: wire in, remove, or keep as planned? | **A:** Wire in with TTL fix | Non-trivial integration work, but delivers the promised feature. |
| | | | **B:** Remove code + update docs | Honest docs, less dead code, feature never worked anyway. |
| | | | **C:** Keep code, update docs to "planned" | Retains option value but still dead code. |
| 3 | §2.8 | Usage dashboard: wire real data, relabel, or remove? | **A:** Wire real token tracking | Requires modifying AI provider layer, token counting differs per provider. |
| | | | **B:** Relabel as illustrative | Simple, honest, no provider changes. |
| | | | **C:** Remove entirely | Cleanest, but loses the UI. |

---

# Phase Completion Gates

- **Phase 1 complete when:** Tasks §1.1, §1.2, §1.3, §1.5 acceptance criteria are all met. All 81 tests pass. CSP verified on Vercel preview with zero violations. Edge Function origin validation verified via manual curl test.
- **Phase 2 complete when:** Tasks §2.1, §2.2, §2.3, §2.6, §2.7 acceptance criteria are all met, PLUS human decisions for §2.4, §2.5, §2.8 are resolved and their chosen options implemented. All tests pass (81 original + new tests from this phase).
- **Phase 3 complete when:** Tasks §3.1, §3.2, §3.3 acceptance criteria are all met. `npx tsc --noEmit` returns 0. `npm run build` succeeds. All tests pass.
- **Phase 4 complete when:** Task §3.4 acceptance criteria are met. One canonical lockfile. No broken links. All tests pass. `npm run build` succeeds.

---

# Discrepancies Found Between Plan Investigation and Review Document

| # | Review Claim | What Investigation Found | Impact on Plan |
|:---:|:---|:---|:---|
| 1 | §1.5 mentions only `create-checkout-session` | `create-portal-session` has the **identical** `return_url` open redirect vulnerability. | Task §1.5 scope expanded to include both Edge Functions. |
| 2 | §1.5 does not mention CORS wildcard | `cors.ts` defaults to `Access-Control-Allow-Origin: *` because no function passes `allowedOrigins`. | Task §1.5 consolidates all origin matching into a single `isOriginAllowed()` function in `cors.ts`, used by both `getCorsHeaders()` and Edge Function body validation. `getCorsHeaders()` signature simplified (no more `allowedOrigins` parameter). |
| 3 | §2.2 says `saveQueue.ts` has "optimistic locking (version/updated_at-guarded writes)" | `saveQueue.ts` tracks `updated_at` in a client-side map but does NOT send it to Supabase. The Supabase `.update()` calls in `useDocuments.tsx` and `useSystemDesigns.tsx` have no `updated_at` guard clause. | Task §2.2 must also add server-side version guards in the hooks, not just wire the client-side queue. |
| 4 | §2.5 references "multiTabSync.ts" | The actual file is named `tabSync.ts`. Docs reference the wrong filename. | Task §2.5 includes fixing the filename references in documentation if Option B or C is chosen. |
| 5 | §3.3 review says "several places" swallow errors | Investigation found exactly **16 catch blocks** matching the criteria, of which **11 are in critical paths** and **5 are intentionally defensive**. | Task §3.3 targets the 6 highest-impact blocks, not all 16 — the defensive ones are correct by design. |

---

## Additional issues found during patching

None. Both corrections were verified against the actual codebase and confirmed as legitimate defects in the original plan. No further issues were discovered during the patching process.
