# Artix — Engineering Review & Fix Checklist

**Repository:** `Yousef-eng679/Artix`  
**Branch reviewed:** `main`  
**Latest commit inspected:** `6ea5b92a52b3e437e56a8a624d28c8322d6d5f1e`  
**Review date:** September 7, 2026

---

## 1. Executive Summary

Artix is substantially stronger than a typical portfolio CRUD application.

It has:

- A real product concept rather than a demo-only interface.
- A nontrivial React + TypeScript architecture.
- AI-provider abstraction.
- Technical document/editor functionality.
- Interactive architecture/graph tooling.
- AI reflection/refinement logic.
- Browser persistence and autosave.
- Cross-tab synchronization.
- Supabase authentication/persistence.
- PWA/offline-oriented functionality.
- Security-oriented code and tests.
- Unit tests plus Playwright E2E tests.
- Export and workspace-oriented functionality.

### Current assessment

| Area | Assessment |
|---|---:|
| Product idea | 9/10 |
| Engineering depth | 8.5/10 |
| Architecture | 8/10 |
| Testing effort | 8/10 |
| Security maturity | 6.5–7/10 |
| Repository polish | 6.5/10 |
| Production readiness | ~7/10 |
| Portfolio strength | **~8.2/10** |

### Main conclusion

Do **not** focus on adding lots of new features right now.

The highest-value work is:

1. Fix credential-storage edge cases.
2. Tighten security claims and behavior.
3. Verify database/RLS/authentication boundaries.
4. Make persistence reliable under failures and rapid saves.
5. Add automated CI.
6. Clean repository/package-manager/branding leftovers.
7. Improve documentation so the engineering work is obvious.
8. Prove the existing feature set with stronger integration/E2E coverage.

---

# 2. Priority System

Use this order when fixing issues.

### P0 — Critical

Security bugs, data-loss bugs, authentication/authorization failures, or anything that could expose user data/credentials.

### P1 — High

Reliability, production correctness, major architectural weaknesses, missing automated verification.

### P2 — Medium

Repository quality, developer experience, documentation, maintainability.

### P3 — Polish

Visual/documentation improvements that do not materially affect correctness.

---

# 3. P0 — Credential Storage Security

## 3.1 `disableEncryption()` can write the API key back in plaintext

### Location

`src/lib/ai/storage.ts`

### Problem

The encrypted-storage path correctly encrypts settings.

However, `disableEncryption()` currently does:

```ts
localStorage.setItem(KEY, JSON.stringify(settings));
```

This bypasses the existing:

```ts
sanitizeSettingsForStorage(settings)
```

function.

That means disabling encryption can cause the decrypted API key to be stored directly in `localStorage`.

### Why this matters

This creates an inconsistent security model:

- Encryption enabled → encrypted blob.
- Encryption disabled → intended obfuscation.
- Current implementation → potentially raw plaintext API key.

### Fix

Change:

```ts
localStorage.setItem(KEY, JSON.stringify(settings));
```

to:

```ts
localStorage.setItem(
  KEY,
  JSON.stringify(sanitizeSettingsForStorage(settings))
);
```

### Also add tests

Test the complete lifecycle:

1. Save API key.
2. Enable encryption.
3. Unlock.
4. Disable encryption.
5. Inspect `localStorage`.
6. Assert that the raw API key does not appear directly.
7. Load settings.
8. Assert the original API key is restored correctly.

**Priority: P0**

---

# 4. P0/P1 — Be Precise About Browser-Side API-Key Security

## Current situation

Artix has an `obf:` mechanism based on Base64:

```ts
return `obf:${btoa(key)}`;
```

Base64 is encoding, not encryption.

The project also has optional encryption using Web Crypto, which is much stronger.

### Important security distinction

Even encrypted browser-local credentials cannot completely protect a credential from malicious JavaScript executing inside the same origin.

If the application must use an API key in the browser, the application ultimately needs access to the decrypted key.

Therefore:

- Base64/obfuscation ≠ security.
- Encryption at rest ≠ protection against XSS.
- CSP, dependency hygiene, XSS prevention, and minimizing credential exposure still matter.

### Recommended product wording

Avoid claims such as:

> "Your API keys are completely secure."

Prefer wording such as:

> "API keys are stored locally in your browser. Optional encryption protects stored credentials using Web Crypto. Browser-side credentials can still be exposed if malicious code executes within the application's origin."

### Security checklist

- [ ] Fix plaintext regression in `disableEncryption()`.
- [ ] Verify crypto implementation.
- [ ] Review CSP.
- [ ] Audit `dangerouslySetInnerHTML`.
- [ ] Sanitize any user-controlled rendered HTML/Markdown.
- [ ] Review third-party dependencies.
- [ ] Keep API keys out of logs.
- [ ] Keep API keys out of error telemetry.
- [ ] Never include keys in URLs.
- [ ] Never commit `.env` secrets.
- [ ] Add security regression tests.

**Priority: P0/P1**

---

# 5. P1 — Make Encrypted Saves Awaitable and Race-Safe

## Current situation

Encrypted `saveSettings()` performs:

```ts
void encryptJSON(settings, memoryPassphrase!).then((blob) => {
  localStorage.setItem(ENC_KEY, JSON.stringify(blob));
});
```

The function itself returns immediately.

### Risks

Callers cannot know when persistence has actually completed.

Rapid consecutive saves could potentially finish out of order if encryption operations complete in an unexpected order.

Example:

```text
save(A)
save(B)
save(C)

encryption(B) finishes
encryption(C) finishes
encryption(A) finishes

final storage = A
```

The exact likelihood depends on implementation/runtime behavior, but the design does not guarantee ordering.

### Recommended API

Make persistence asynchronous:

```ts
export async function saveSettings(
  settings: AISettings
): Promise<void> {
  if (isEncrypted()) {
    if (!isUnlocked()) {
      throw new Error('AI keys are locked. Unlock to save.');
    }

    const blob = await encryptJSON(
      settings,
      memoryPassphrase!
    );

    memoryCache = settings;
    localStorage.setItem(
      ENC_KEY,
      JSON.stringify(blob)
    );

    notifyChange();
    return;
  }

  localStorage.setItem(
    KEY,
    JSON.stringify(
      sanitizeSettingsForStorage(settings)
    )
  );

  notifyChange();
}
```

### Better version

If saves can happen frequently, add serialized writes or a revision counter.

For example:

```ts
let saveRevision = 0;

export async function saveSettings(
  settings: AISettings
): Promise<void> {
  const revision = ++saveRevision;

  const blob = await encryptJSON(
    settings,
    memoryPassphrase!
  );

  if (revision !== saveRevision) {
    return;
  }

  localStorage.setItem(
    ENC_KEY,
    JSON.stringify(blob)
  );

  memoryCache = settings;
  notifyChange();
}
```

Or use a promise queue/mutex.

### Tests

Test:

- rapid saves,
- save while locking,
- save while changing passphrase,
- failed encryption,
- browser storage failure,
- recovery after reload.

**Priority: P1**

---

# 6. P1 — Review Supabase RLS and Authorization Thoroughly

Artix uses Supabase authentication/persistence.

Do not assume authentication automatically means authorization is correct.

Review every user-owned table and verify:

```text
authenticated user
        |
        v
row.owner_id == auth.uid()
        |
        v
allow SELECT/INSERT/UPDATE/DELETE
```

### Checklist

For every table:

- [ ] SELECT policy.
- [ ] INSERT policy.
- [ ] UPDATE policy.
- [ ] DELETE policy.
- [ ] Ownership check.
- [ ] No cross-user access.
- [ ] No client-controlled owner ID bypass.
- [ ] Anonymous access denied where appropriate.
- [ ] Service-role credentials never reach the browser.
- [ ] Sensitive columns are protected.
- [ ] Database constraints reinforce authorization assumptions.

### Test explicitly

Create two test users:

```text
User A
User B
```

Then verify:

```text
A cannot read B's project
A cannot update B's project
A cannot delete B's project
B cannot read A's project
```

This should be part of the security test suite.

**Priority: P0/P1**

---

# 7. P1 — Audit Authentication Flows

Recent repository activity includes authentication improvements such as:

- Email confirmation redirect changes.
- Server-side email deliverability validation.
- Disposable-domain validation.

That is good engineering work.

Now test the entire lifecycle.

### Test matrix

#### Registration

- [ ] Valid email.
- [ ] Invalid email.
- [ ] Disposable email.
- [ ] Existing account.
- [ ] Weak password.
- [ ] Confirmation required.

#### Confirmation

- [ ] Correct redirect.
- [ ] Expired link.
- [ ] Invalid link.
- [ ] Already-confirmed account.

#### Login

- [ ] Correct credentials.
- [ ] Incorrect password.
- [ ] Unconfirmed user.
- [ ] Rate limiting/abuse handling if applicable.

#### Password recovery

- [ ] Request reset.
- [ ] Correct redirect.
- [ ] Expired reset.
- [ ] Invalid reset.
- [ ] Successful password change.

#### Session

- [ ] Refresh.
- [ ] Logout.
- [ ] Multiple tabs.
- [ ] Expired session.
- [ ] Revoked session.

**Priority: P1**

---

# 8. P1 — Persistence and Autosave Reliability

Artix has a sophisticated persistence direction involving local drafts/database persistence and cross-tab synchronization.

This is one of the strongest engineering areas of the project, but it needs failure-oriented testing.

## Test scenarios

### Browser refresh

```text
Edit
→ autosave
→ refresh
→ data survives
```

### Network failure

```text
Edit
→ database unavailable
→ local draft retained
→ reconnect
→ synchronization succeeds
```

### Concurrent tabs

```text
Tab A edits
Tab B edits
→ synchronization behavior is deterministic
```

### Browser close

```text
Edit
→ immediate close/reopen
→ latest safe draft survives
```

### Conflicting edits

Define a clear conflict strategy:

- last-write-wins,
- revision number,
- timestamp,
- merge,
- or explicit conflict UI.

Do not leave this implicit.

### Cross-tab synchronization

If using `BroadcastChannel`, verify:

- channel cleanup,
- duplicate events,
- stale events,
- tab shutdown,
- malformed messages,
- multiple simultaneous tabs.

**Priority: P1**

---

# 9. P1 — Define a Single Source of Truth for Project State

Artix has multiple persistence layers.

Document exactly which layer is authoritative.

Recommended model:

```text
UI state
   |
   v
Local in-memory state
   |
   v
Local draft/autosave
   |
   v
Remote database
```

Define:

- what happens when local and remote differ,
- what wins after login,
- what wins after logout,
- what happens when a remote save fails,
- what happens when a browser draft is newer,
- when local drafts are deleted.

Create a dedicated architecture document:

```text
docs/PERSISTENCE.md
```

with sequence diagrams for:

1. Normal save.
2. Offline save.
3. Reconnect.
4. Multi-tab edit.
5. Login merge.

**Priority: P1**

---

# 10. P1 — Add GitHub Actions CI

The repository has lint/test/build scripts and a meaningful test suite.

The next step is to make them automatically enforce quality.

Create:

```text
.github/workflows/ci.yml
```

Recommended pipeline:

```text
push / pull_request
        |
        +--> install dependencies
        |
        +--> lint
        |
        +--> unit tests
        |
        +--> build
        |
        +--> E2E tests
```

At minimum run:

```bash
npm run lint
npm test
npm run build
```

Then add Playwright E2E tests in a separate job if needed.

### CI should fail on

- Type errors.
- Lint failures.
- Unit test failures.
- Build failures.
- Security regression failures.
- Critical E2E failures.

### Add badges to README

For example:

```text
CI
Tests
Build
License
```

**Priority: P1**

---

# 11. P1 — Improve Test Strategy

Current test coverage is already a strong point.

Existing tests include areas such as:

- AI architecture.
- AI behavior.
- API saving.
- Billing.
- Branding.
- Edge cases.
- Remediation.
- Security.
- UX.
- UX feedback.
- Authentication E2E.
- Feature E2E.
- Security E2E.

The next goal is not simply "more tests."

The goal is **risk-based tests**.

## Highest-value tests

### Security

- [ ] API key storage lifecycle.
- [ ] Encryption disable regression.
- [ ] Wrong passphrase.
- [ ] Change passphrase.
- [ ] Locked state.
- [ ] XSS-sensitive rendering.
- [ ] RLS isolation.

### Persistence

- [ ] Offline draft.
- [ ] Failed remote save.
- [ ] Recovery.
- [ ] Concurrent tabs.
- [ ] Conflict handling.

### AI

- [ ] Provider failure.
- [ ] Invalid response.
- [ ] Rate limit.
- [ ] Timeout.
- [ ] Malformed JSON.
- [ ] Missing API key.
- [ ] Provider fallback.
- [ ] Cancellation.

### Billing

- [ ] Failed payment.
- [ ] Usage limit.
- [ ] Invalid plan.
- [ ] Boundary values.

**Priority: P1**

---

# 12. P1 — AI Provider Abstraction

The provider-independent AI architecture is one of Artix's strongest portfolio features.

Keep provider-specific logic isolated.

Recommended architecture:

```text
Application
    |
    v
AI Service
    |
    v
Provider Interface
    |
    +---- OpenAI
    |
    +---- Gemini
    |
    +---- Other provider
```

Avoid:

```text
UI component
    |
    +--> OpenAI-specific request
    |
    +--> Gemini-specific request
    |
    +--> provider-specific parsing
```

### Interface should define

- generate text,
- structured output,
- streaming if supported,
- error normalization,
- cancellation,
- usage metadata,
- model metadata.

### Normalize provider errors

Instead of leaking provider-specific error shapes everywhere:

```ts
type AIError =
  | { type: 'auth'; message: string }
  | { type: 'rate_limit'; message: string }
  | { type: 'timeout'; message: string }
  | { type: 'invalid_response'; message: string }
  | { type: 'network'; message: string }
  | { type: 'unknown'; message: string };
```

This will make the UI much easier to maintain.

**Priority: P1**

---

# 13. P1 — AI Reflection Pass

The architecture includes a two-pass reflection/refinement flow.

Conceptually:

```text
User input
    |
    v
Initial generation
    |
    v
Reflection / critique
    |
    v
Refined output
```

This is a strong idea.

Make it measurable.

Track:

- initial output,
- critique,
- final output,
- latency,
- token/cost usage,
- failure rate.

Add tests for:

- vague input,
- technically incomplete input,
- already-good input,
- malformed AI output,
- provider failure,
- reflection failure.

Do not automatically assume a second AI pass is always better.

The system should have a clear rule for when refinement is useful.

**Priority: P1/P2**

---

# 14. P2 — Repository/package.json Cleanup

The repository still has generic Vite starter metadata such as:

```json
"name": "vite_react_shadcn_ts",
"version": "0.0.0"
```

For a mature project named Artix, this makes the repository feel unfinished.

### Change to something like

```json
{
  "name": "artix",
  "version": "1.0.0"
}
```

Use whatever versioning scheme you actually want.

Also review:

- description,
- author,
- license,
- repository metadata,
- homepage,
- package manager,
- scripts.

**Priority: P2**

---

# 15. P2 — Choose One Package Manager

The repository contains multiple lockfiles:

```text
bun.lock
bun.lockb
package-lock.json
```

This creates ambiguity.

Choose one canonical package manager.

For example:

```text
npm
```

Then keep:

```text
package-lock.json
```

and remove unrelated lockfiles.

Or choose Bun and use only its canonical lockfile.

### Also document

```text
Node/Bun version
package manager
install command
dev command
test command
build command
```

**Priority: P2**

---

# 16. P2 — Fix README Broken Local File Link

The README contains a machine-specific link similar to:

```text
file:///c:/Fenix-main/DOCS.md
```

This will not work for GitHub users.

Replace it with a repository-relative link:

```md
[Documentation](./DOCS.md)
```

This is also important because the repository has legacy Fenix naming elsewhere.

**Priority: P2**

---

# 17. P2 — Remove/Isolate Legacy Fenix Naming

The code still contains migration references such as:

```text
fenix.ai.settings.v1
fenix.ai.settings.enc.v1
```

Keeping these migration keys is reasonable if existing users need migration support.

However, visible legacy references such as:

```text
Fenix
C:\Fenix-main
```

make the project look partially renamed.

### Recommended approach

Keep migration compatibility internally:

```ts
const LEGACY_KEY = 'fenix.ai.settings.v1';
```

but avoid legacy branding everywhere else.

Search the entire repository for:

```text
Fenix
fenix
C:\Fenix-main
```

Classify each result:

```text
Required migration
Documentation
UI branding
Comment
Dead code
Build/config
```

Remove everything unnecessary.

**Priority: P2**

---

# 18. P2 — README Restructure

The README already communicates that Artix is a broad developer-oriented product.

Make the first screen much more effective.

Recommended order:

```text
ARTIX

One-sentence value proposition

[Live Demo] [Documentation] [Architecture]

Screenshot

What Artix does

Key engineering highlights

Architecture

Security

Testing

Tech stack

Installation

Development

Roadmap
```

### Focus less on feature quantity

Instead of:

```text
Feature A
Feature B
Feature C
Feature D
...
```

show engineering depth:

```text
Provider-independent AI execution
Encrypted local credential storage
Crash-resistant autosave
Cross-tab synchronization
Graph-based architecture editor
Supabase persistence
Security/E2E test coverage
PWA/offline support
```

This is much stronger for a technical portfolio.

**Priority: P2**

---

# 19. P2 — Add an Architecture Diagram

Create a clean architecture diagram showing:

```text
                    ┌──────────────────┐
                    │   React UI       │
                    └────────┬─────────┘
                             │
                 ┌───────────▼───────────┐
                 │ Application Services  │
                 └───────┬────────┬──────┘
                         │        │
              ┌──────────▼──┐  ┌─▼──────────┐
              │ AI Layer    │  │ Persistence │
              └──────┬──────┘  └─────┬──────┘
                     │                │
          ┌──────────┼──────────┐     │
          │          │          │     │
       Provider A Provider B Provider C
                                      │
                              ┌───────▼───────┐
                              │ Supabase      │
                              └───────────────┘
```

Also show:

```text
Local Storage
Web Crypto
BroadcastChannel
PWA
```

This makes the architecture immediately understandable.

**Priority: P2**

---

# 20. P2 — Document Security Model

Create:

```text
docs/SECURITY.md
```

Include:

## Threat model

What Artix protects against:

- accidental local exposure,
- unauthorized database access,
- malformed input,
- common browser threats.

What it does not guarantee:

- malicious JavaScript executing in the same origin,
- compromised browser extensions,
- compromised device,
- compromised third-party provider.

## Credential model

Explain:

```text
BYOK
   |
   v
Browser
   |
   +--> optional encryption
   |
   v
AI provider
```

## Database model

Explain:

```text
authenticated user
        |
        v
RLS
        |
        v
user-owned data
```

This will significantly increase technical credibility.

**Priority: P2**

---

# 21. P2 — Error Handling Standardization

Audit all async boundaries.

Every important external operation should have:

```text
loading
success
failure
retry
cancel
```

This applies to:

- AI requests.
- Supabase requests.
- Autosave.
- Export.
- Authentication.
- Billing.
- File operations.

Avoid generic:

```ts
catch {
  return {};
}
```

when failure information matters.

Silently swallowing errors makes debugging and production support harder.

Where appropriate:

```ts
catch (error) {
  logSafeError(error);
  return {
    ok: false,
    error: normalizeError(error)
  };
}
```

Never log API credentials or sensitive user content unnecessarily.

**Priority: P1/P2**

---

# 22. P2 — Validate External Data at Boundaries

The project already uses Zod.

Use schemas aggressively at boundaries:

```text
AI response
Supabase response
URL parameters
localStorage data
imported project files
export files
user input
```

For example:

```ts
const settings = AISettingsSchema.parse(raw);
```

instead of trusting:

```ts
JSON.parse(raw)
```

The localStorage layer is particularly important because stored data can be malformed or manually modified.

### Test malformed storage

Examples:

```text
null
{}
[]
"hello"
invalid JSON
wrong types
unknown fields
missing fields
oversized values
```

**Priority: P1/P2**

---

# 23. P2 — LocalStorage Failure Handling

Browser storage is not guaranteed to succeed.

Potential failures include:

- quota exceeded,
- privacy restrictions,
- browser policies,
- malformed stored data,
- storage being unavailable.

Audit every:

```ts
localStorage.setItem(...)
localStorage.getItem(...)
localStorage.removeItem(...)
```

and determine whether failure should:

- be ignored,
- fall back to memory,
- show a warning,
- trigger recovery.

Do not allow a storage failure to crash the main editor.

**Priority: P2**

---

# 24. P2 — PWA Reliability

Artix has PWA functionality.

Test:

- [ ] Install prompt.
- [ ] Dismiss prompt.
- [ ] Reload after dismissal.
- [ ] Offline application shell.
- [ ] Reconnection.
- [ ] Updated service worker.
- [ ] Stale cached assets.
- [ ] Logout/login while offline.
- [ ] Data edits while offline.
- [ ] Cache invalidation after deployment.

Do not let an outdated service worker keep users on broken application code.

**Priority: P2**

---

# 25. P2 — Usage/Budget UI Accuracy

`APIUsageView.tsx` currently initializes a budget around:

```ts
useState(10.00)
```

and reads usage information from localStorage.

Review whether this is:

- demo data,
- a default budget,
- real billing data,
- provider-specific usage,
- or estimated usage.

If it is only an estimate, label it clearly.

Do not present estimated client-side usage as authoritative billing data.

If real billing is supported, the source of truth should be server-side.

**Priority: P1/P2**

---

# 26. P2 — Separate Demo/Client Estimates from Authoritative Data

Anything involving:

- billing,
- quotas,
- usage,
- subscription state,
- credits,

should have a clearly defined authority.

Recommended:

```text
UI estimate
    |
    v
Server verification
    |
    v
authoritative state
```

Never rely exclusively on:

```text
localStorage
```

for security-sensitive limits.

A user can modify browser storage.

**Priority: P1**

---

# 27. P2 — Audit Client-Side Authorization

For every important action ask:

> Is this merely hidden in the UI, or actually forbidden on the server?

Bad:

```text
UI hides admin button
```

Good:

```text
server rejects unauthorized operation
```

This is especially important for:

- billing,
- quotas,
- user data,
- project ownership,
- premium features,
- admin operations.

**Priority: P1**

---

# 28. P2 — Dependency Hygiene

Review:

```bash
npm outdated
npm audit
```

and inspect major dependencies.

Do not blindly upgrade everything.

For each major update:

```text
current
→ breaking changes
→ tests
→ build
→ E2E
```

Also remove unused dependencies.

A smaller dependency graph improves:

- security,
- build time,
- maintainability,
- portfolio credibility.

**Priority: P2**

---

# 29. P2 — TypeScript Strictness

Verify TypeScript compiler settings.

Aim for strong settings such as:

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "noImplicitOverride": true
}
```

Only enable additional flags after checking the codebase.

The goal is not maximum compiler strictness for its own sake.

The goal is catching real classes of bugs.

**Priority: P2**

---

# 30. P2 — Dead Code and Architecture Cleanup

Search for:

```text
TODO
FIXME
HACK
TEMP
legacy
deprecated
unused
```

The previous repository search found no TODO results, which is good.

Still inspect:

- unused exports,
- duplicate utilities,
- legacy components,
- abandoned providers,
- obsolete migration code,
- old branding,
- unreachable branches.

Run the project's lint/build tooling and address warnings rather than ignoring them.

**Priority: P2**

---

# 31. P3 — UI/UX Polish

After correctness/security work, review:

### Empty states

Every major screen should explain what to do next.

### Loading states

Avoid blank screens.

### Error states

Show useful recovery actions.

### Keyboard accessibility

Verify:

- tab order,
- focus state,
- keyboard shortcuts,
- modal behavior.

### Screen readers

Verify:

- labels,
- button names,
- form errors,
- dialog semantics.

### Responsive layout

Test:

```text
desktop
tablet
mobile
```

Especially the graph/editor interfaces.

**Priority: P3**

---

# 32. P3 — Observability

If Artix is intended to become a real SaaS, introduce safe observability.

Track things such as:

```text
AI request success rate
AI request failure rate
average latency
autosave failure rate
database errors
authentication failures
E2E failures
```

Do NOT record:

- API keys,
- passwords,
- auth tokens,
- unnecessary private project content.

**Priority: P2/P3**

---

# 33. Recommended Documentation Structure

Use:

```text
README.md

docs/
├── ARCHITECTURE.md
├── SECURITY.md
├── PERSISTENCE.md
├── AI.md
├── TESTING.md
├── CONTRIBUTING.md
└── DEPLOYMENT.md
```

### `ARCHITECTURE.md`

Explain components and data flow.

### `SECURITY.md`

Explain threat model and credential storage.

### `PERSISTENCE.md`

Explain autosave, offline state, and synchronization.

### `AI.md`

Explain provider abstraction and reflection pass.

### `TESTING.md`

Explain unit/E2E/security strategy.

### `DEPLOYMENT.md`

Explain environment variables and production deployment.

### `CONTRIBUTING.md`

Explain setup and contribution workflow.

---

# 34. Recommended Fix Order

Do not try to fix everything simultaneously.

## Phase 1 — Security

### Task 1
Fix:

```ts
disableEncryption()
```

so it sanitizes storage.

### Task 2
Add credential lifecycle regression tests.

### Task 3
Review XSS-sensitive rendering.

### Task 4
Review CSP.

### Task 5
Audit Supabase RLS.

### Task 6
Test cross-user isolation.

---

# 35. Phase 2 — Reliability

### Task 7
Make encrypted saves awaitable.

### Task 8
Prevent stale encrypted writes.

### Task 9
Test autosave failures.

### Task 10
Test offline recovery.

### Task 11
Test cross-tab synchronization.

### Task 12
Define persistence conflict resolution.

### Task 13
Validate localStorage data with Zod.

---

# 36. Phase 3 — Testing/CI

### Task 14
Create GitHub Actions CI.

### Task 15
Run:

```bash
npm run lint
npm test
npm run build
```

### Task 16
Add Playwright E2E job.

### Task 17
Add security regression suite.

### Task 18
Add Supabase authorization tests.

### Task 19
Add AI provider failure tests.

---

# 37. Phase 4 — Repository Cleanup

### Task 20
Fix `package.json` metadata.

### Task 21
Choose one package manager.

### Task 22
Remove unnecessary lockfiles.

### Task 23
Fix `file:///...` README links.

### Task 24
Remove non-migration Fenix references.

### Task 25
Audit dependencies.

### Task 26
Remove dead code.

---

# 38. Phase 5 — Documentation

### Task 27
Rewrite README first screen.

### Task 28
Add architecture diagram.

### Task 29
Add SECURITY.md.

### Task 30
Add PERSISTENCE.md.

### Task 31
Add AI.md.

### Task 32
Add TESTING.md.

### Task 33
Add DEPLOYMENT.md.

---

# 39. Phase 6 — Product Polish

### Task 34
Audit loading states.

### Task 35
Audit error states.

### Task 36
Audit empty states.

### Task 37
Accessibility pass.

### Task 38
Mobile/responsive pass.

### Task 39
PWA reliability pass.

### Task 40
Observability.

---

# 40. Portfolio Positioning

Artix is strong enough to be presented as a serious engineering project.

Do not describe it only as:

> "An AI-powered developer tool."

That undersells the engineering.

Better framing:

> **Artix is a developer command center built around AI-assisted technical design, with a provider-independent AI architecture, browser-side credential protection, persistent workspaces, autosave, cross-tab synchronization, interactive system architecture tooling, and automated security/E2E testing.**

### Engineering bullets

Use bullets like:

- Designed a provider-independent AI execution layer supporting multiple model providers.
- Built a two-pass AI reflection/refinement pipeline for improving technical outputs.
- Implemented browser-local credential storage with optional Web Crypto encryption.
- Built resilient local/remote persistence and autosave flows.
- Implemented cross-tab synchronization using browser communication primitives.
- Integrated Supabase authentication and persistent user workspaces.
- Built interactive graph-based architecture tooling.
- Added unit, security, and Playwright E2E testing.
- Built PWA/offline-oriented functionality.

These communicate engineering decisions rather than simply listing UI features.

---

# 41. What NOT to Do Yet

Avoid spending significant time on:

- adding another 20 features,
- adding unnecessary animations,
- adding more AI providers just for the feature count,
- rewriting the entire frontend,
- changing frameworks without a concrete reason,
- premature microservices,
- complicated backend infrastructure before validating current architecture,
- polishing README graphics while security bugs remain.

The current project already has enough scope.

The next level comes from making the existing system **correct, reliable, testable, and explainable**.

---

# 42. Definition of Done

Before calling Artix production-ready, aim for:

## Security

- [ ] No plaintext credential regression.
- [ ] Correct encryption lifecycle.
- [ ] XSS review complete.
- [ ] CSP reviewed.
- [ ] RLS verified.
- [ ] Cross-user access tests pass.
- [ ] No secret leakage in logs.

## Reliability

- [ ] Autosave survives failures.
- [ ] Offline edits recover.
- [ ] Cross-tab synchronization is deterministic.
- [ ] Persistence conflicts have defined behavior.
- [ ] Async saves cannot overwrite newer state.

## Testing

- [ ] Unit tests pass.
- [ ] Security tests pass.
- [ ] E2E tests pass.
- [ ] Build passes.
- [ ] Lint passes.
- [ ] CI enforces all of the above.

## Repository

- [ ] Package metadata is Artix-specific.
- [ ] One package manager.
- [ ] One canonical lockfile.
- [ ] No broken local links.
- [ ] No accidental legacy branding.
- [ ] No unnecessary dead code.

## Documentation

- [ ] README explains the product.
- [ ] Architecture is documented.
- [ ] Security model is documented.
- [ ] Persistence model is documented.
- [ ] AI architecture is documented.
- [ ] Testing strategy is documented.
- [ ] Deployment is documented.

---

# 43. Final Assessment

Artix's biggest strength is that there is real engineering underneath the UI.

The project already demonstrates:

```text
AI architecture
+ persistence
+ security considerations
+ authentication
+ interactive tooling
+ PWA
+ testing
+ product thinking
```

The biggest weakness is not a lack of features.

It is the gap between:

```text
"the project contains sophisticated engineering"
```

and:

```text
"the project has been rigorously verified, documented,
and polished as a production system."
```

Closing that gap will produce a much bigger improvement than adding another major feature.

### Target

Current portfolio strength:

**~8.2/10**

After the P0/P1 work is completed and documented well:

**9+/10 is realistic as a portfolio engineering project.**

The priority should be:

```text
SECURITY
   ↓
RELIABILITY
   ↓
TESTING + CI
   ↓
REPOSITORY CLEANUP
   ↓
DOCUMENTATION
   ↓
UX POLISH
   ↓
NEW FEATURES
```

---

# 44. Master Checklist

Copy this section into your issue tracker if useful.

## P0

- [ ] Fix `disableEncryption()` plaintext-storage bug
- [ ] Add encryption lifecycle regression tests
- [ ] Audit Supabase RLS
- [ ] Verify cross-user isolation
- [ ] Audit XSS-sensitive rendering
- [ ] Review CSP
- [ ] Verify no secret leakage

## P1

- [ ] Make encrypted saves awaitable
- [ ] Prevent stale async saves
- [ ] Test persistence failures
- [ ] Test offline recovery
- [ ] Test cross-tab synchronization
- [ ] Define conflict resolution
- [ ] Validate localStorage with schemas
- [ ] Audit authentication lifecycle
- [ ] Audit client/server authorization
- [ ] Clarify billing/usage authority
- [ ] Add GitHub Actions CI
- [ ] Add security regression coverage
- [ ] Add AI provider failure coverage

## P2

- [ ] Rename package metadata to Artix
- [ ] Choose one package manager
- [ ] Remove extra lockfiles
- [ ] Fix README local links
- [ ] Clean legacy Fenix references
- [ ] Audit dependencies
- [ ] Audit dead code
- [ ] Add SECURITY.md
- [ ] Add PERSISTENCE.md
- [ ] Add AI.md
- [ ] Add TESTING.md
- [ ] Add DEPLOYMENT.md
- [ ] Add architecture diagram
- [ ] Improve README engineering focus
- [ ] Audit error handling
- [ ] Audit external-data validation
- [ ] Audit PWA reliability

## P3

- [ ] Loading-state pass
- [ ] Error-state pass
- [ ] Empty-state pass
- [ ] Accessibility pass
- [ ] Responsive/mobile pass
- [ ] Observability
- [ ] Final visual polish

---

## Bottom Line

**Don't rebuild Artix. Harden it.**

The architecture and feature scope are already substantial. The highest-return work now is turning the existing complexity into a system that is demonstrably secure, reliable, tested, maintainable, and easy for another engineer to understand.
