# Authentication & Storage Security Boundaries

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/hooks/useAuth.tsx`, `src/lib/local/db.ts`, `supabase/migrations/20260919082427_add_missing_rls_policies.sql`

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

### Supported Authentication Methods
- Email / Password with cryptographic salting and hashing.
- Google OAuth 2.0 with redirect callback.
- Automatic background JWT token refresh via HTTP-only or secure storage tokens.

---

## 3. Row Level Security (RLS) Policy Matrix

Every table in Supabase PostgreSQL enforces RLS. Client requests authenticate with a Bearer JWT containing the user's UUID in `auth.uid()`.

| Table | Operation | Policy Rule | Security Guarantee |
|---|---|---|---|
| `documents` | `SELECT` | `auth.uid() = user_id` | Users can only query their own documents. |
| `documents` | `INSERT` | `auth.uid() = user_id` | Documents must be owned by the inserting user. |
| `documents` | `UPDATE` | `auth.uid() = user_id` | Cross-tenant document modifications are rejected. |
| `documents` | `DELETE` | `auth.uid() = user_id` | Users can only delete their own documents. |
| `system_designs` | `ALL` | `auth.uid() = user_id` | System design canvases are strictly tenant-isolated. |
| `workspace_folders`| `ALL` | `auth.uid() = user_id` | Workspace folder trees are isolated per user. |
| `sync_changes` | `SELECT` | `auth.uid() = user_id` | Change feed pulls only return events owned by the user. |
| `processed_mutations`| `ALL`| `auth.uid() = user_id` | Idempotency verification is scoped strictly to the owning user. |
| `subscriptions`| `SELECT` | `auth.uid() = user_id` | Users can view their own billing tier; updates reserved for service role. |

---

## 4. Client Storage Isolation

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
- **Function**: It provides deterministic database naming (`ArtixDB_v2_<hash>`) so that different user accounts logging in on the same browser have completely separate IndexedDB physical storage files.
- **Sign-Out Teardown**: Upon sign-out, the database instance is closed and purged from in-memory cache, ensuring no resident memory retains user data.
