# Authentication & Storage Security Boundaries

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/hooks/useAuth.tsx`, `src/lib/auth/offlineSession.ts`, `src/lib/local/db.ts`, `supabase/migrations/20260919082427_add_missing_rls_policies.sql`, `supabase/migrations/20261101100300_atomic_billing_reconciliation_and_manual_grants.sql`

---

## 1. Overview

Artix implements multi-tenant security through defense-in-depth:
1. **Cloud Security**: Supabase PostgreSQL Row Level Security (RLS) driven by cryptographic JWT validation.
2. **Client Session Isolation**: User-scoped IndexedDB instances tied strictly to the authenticated user ID.
3. **Application Crypto Boundary**: User-provided third-party AI keys encrypted via PBKDF2/AES-GCM in browser storage.

---

## 2. Authentication Subsystem (`src/hooks/useAuth.tsx`)

Powered by Supabase Auth using the secure **PKCE (Proof Key for Code Exchange)** flow:

```typescript
export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  }
});
```

### Supported Authentication Methods & Offline Cold-Start Continuity
- **Email / Password** with pre-signup disposable-domain and DNS-over-HTTPS MX validation (`src/lib/emailValidation.ts` -> `/functions/v1/validate-email`).
- **Google OAuth 2.0** with PKCE redirect callback.
- **Offline Expired-JWT Continuity (`src/lib/auth/offlineSession.ts`)**: When booting offline (or when token refresh fails due to network loss) after the cached JWT's `exp` timestamp has elapsed, `recoverOfflineSessionFromStorage()` parses the persisted Supabase session token (`sb-<host>-auth-token`) in `localStorage` and restores the user identity with `isOfflineSession = true`. `UserSyncRuntimeContext` mounts `ArtixDB_v2_<hash>` for full local read/write access while pausing cloud sync (`runtime.setCloudSyncPaused(true)`). When connectivity returns, `useAuth` attempts `supabase.auth.refreshSession()`; if rejected with a fatal `4xx` (`invalid_grant`), `reauthRequired = true` surfaces the non-destructive `reauth-sync-banner` without wiping local IndexedDB work.

---

## 3. Row Level Security (RLS) Policy Matrix

Every table in Supabase PostgreSQL (all 14 `public` tables) enforces RLS. Client requests authenticate with a Bearer JWT containing the user's UUID in `auth.uid()`.

| Table | Operation | Policy Rule | Security Guarantee |
|---|---|---|---|
| `projects` | `ALL` | `auth.uid() = user_id` | Projects are strictly tenant-isolated across all operations. |
| `documents` | `ALL` | `auth.uid() = user_id` | Users can only select, insert, update, or delete their own documents. |
| `system_designs` | `ALL` | `auth.uid() = user_id` | System design canvases are strictly tenant-isolated. |
| `workspace_folders`| `ALL` | `auth.uid() = user_id` | Workspace folder trees are isolated per user. |
| `profiles` | `SELECT/INSERT/UPDATE` | `auth.uid() = user_id` | Users can read and update only their own profile row. |
| `prd_generations` / `vibe_generations` / `agentic_workflows` | `SELECT/INSERT/DELETE` | `auth.uid() = user_id` | AI generation history is isolated per user and capped on Free tier by `check_plan_tier_limit()`. |
| `sync_changes` | `SELECT` | `auth.uid() = user_id` | Change feed pulls only return events owned by the user (`service_role` full access). |
| `sync_retention_state` | `SELECT` | `authenticated` (`true`) | Authenticated clients read `min_retained_sequence` via `get_sync_feed_bounds()`; writes restricted to `service_role`. |
| `processed_mutations`| `ALL`| `auth.uid() = user_id` | Idempotency verification is scoped strictly to the owning user. |
| `subscriptions`| `SELECT` | `auth.uid() = user_id` | Users can view their own billing tier; writes reserved for `service_role` (`reconcile_stripe_subscription`). |
| `manual_grants`| `SELECT` | `auth.uid() = user_id` | Users can view their own administrative Pro grant; writes reserved for `service_role`. |
| `stripe_events`| `NONE` (`service_role` only) | No `anon`/`authenticated` policy | Webhook deduplication ledger is completely inaccessible to client roles. |

---

## 4. Client Storage & Multi-Account Isolation

### The Role of `getUserScopeHash`
In `src/lib/local/db.ts`:
```typescript
export function getUserScopeHash(userId: string): string {
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
```
- **Clarification**: `getUserScopeHash` computes an FNV-1a 32-bit hash. It is **NOT** an encryption key or cryptographic boundary.
- **Function**: It provides deterministic database naming (`ArtixDB_v2_<hash>`) and partitions `localStorage` keys for workspace tabs (`artix.workspace.tabs.<hash>.<projectId>`) and crash-recovery drafts (`artix.draft.<hash>.<id>`).
- **Sign-Out & Account-Switch Teardown**: Upon sign-out or account switch (`User A -> User B`), `closeUserRuntime` stops Realtime, aborts sync timers, evicts `TabCoordinator` (`evictTabCoordinator`) and `SyncEngine` singletons, closes and evicts the Dexie database instance (`closeUserArtixDB`), clears the TanStack `QueryClient` and `dirtyTracker`, and runs `clearSensitiveBrowserCaches()`.
