# Known Issues — Artix

This file tracks issues, limitations, and deferred design decisions discovered during the September 2026 hardening effort that are intentionally out of scope for that effort. Each entry states why it was deferred and what would need to happen to address it.

This file is separate from the phased hardening plan's own internal open decisions (Tasks §2.4, §2.5, §2.8), which are tracked within that plan itself.

---

## Data & Reliability

### 1. Fetch failures are visually indistinguishable from "genuinely empty"
**Where:** `useDocuments.tsx`, `useSystemDesigns.tsx`, `useProjects.tsx`, and their consumer `ProjectWorkspace.tsx`.
Each hook returns `data ?? []` without a consuming component checking `.error`. A failed fetch (e.g., while offline) renders the exact same empty state as a project with zero documents.
**Why deferred:** Discovered during PWA/offline testing, outside the original 18-item plan. Fix requires adding a distinct error/offline UI branch to three hooks and their consumers.

## Progressive Web App (PWA)

### 2. All PWA icon files are the same image, mislabeled with different sizes
**Where:** `public/pwa-192x192.png`, `public/pwa-512x512.png`, `public/apple-touch-icon-180x180.png`, `public/favicon.png`, `public/favicon.ico`. All are the same 1024x1024 image; `favicon.ico` is a renamed PNG, not a real multi-resolution ICO.
**Why deferred:** Cosmetic in most browsers; needs real per-size icon exports plus a genuine .ico.

### 3. Leftover iframe/preview-environment service worker unregister logic
**Where:** `src/main.tsx` force-unregisters the service worker in iframes or hostnames containing `id-preview--` — leftover from an earlier dev/preview tool, not relevant to the current Vercel deployment.

### 4. Service worker "stickiness" delays app updates for returning users
Discovered during Task §1.2 CSP verification: a previously-visited tab kept serving a stale cached app shell after a fix had already shipped, until the tab was fully closed/reopened. General characteristic of the current Workbox setup; a "new version available" refresh prompt would address it.

## Security Model (see also SECURITY.md)

### 5. `disableEncryption()` has no UI entry point
`AISettingsCard.tsx` destructures it but never renders a button calling it. Product decision, not a bug.

### 6. API key protection has an inherent live-XSS limitation
See `SECURITY.md` Section 3 for the full explanation. Summary: at-rest encryption (AES-256-GCM + PBKDF2) protects a locked vault; once unlocked, the key is usable in-memory by the page's own JavaScript, so a live XSS attack during that window isn't defeated by the encryption layer. CSP (Task §1.2) is the actual primary mitigation for this risk, not the encryption itself.

## Third-Party Integration

### 7. Google OAuth consent screen shows the raw Supabase domain, not "Artix"
Standard Supabase-hosted-auth behavior — the OAuth callback is Supabase's domain, and Google shows its root domain unless the Google Cloud OAuth consent screen is branded and verified, or a Supabase custom domain is configured. Not a code bug.

## Product Scope (Not Bugs)

### 8. No real-time multi-user collaborative editing
All content is single-owner (`user_id`-scoped); no sharing/collaborator schema exists. A CRDT-based approach (e.g., Yjs) was discussed and deferred as solving a different problem than this project's actual concurrency concern (same user, multiple tabs — addressed by Task §2.2's optimistic concurrency control).

## Testing

### 9. Two E2E tests target live Supabase pending an isolated test environment
`tests/e2e/auth.spec.ts` (401 check) and `tests/e2e/security.spec.ts` (CORS check) make direct requests against the live production Supabase project (no isolated staging project exists yet — blocked on Supabase project provisioning). They are preserved for local and staging verification, and will be wired into a dedicated CI workflow when a staging environment is configured.
**To re-enable in CI:** provision a second Supabase project, apply all current migrations to it, deploy the same Edge Functions, and wire `TEST_SUPABASE_URL`/`TEST_SUPABASE_ANON_KEY` as GitHub Actions secrets.

---

## How to use this file
When an item is resolved, move it to `docs/CHANGELOG.md` under the relevant version and delete it from here — don't leave resolved-but-undeleted entries.
