# PostgreSQL Row Level Security (RLS) & Authentication Architecture

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `supabase/migrations/20260919082427_add_missing_rls_policies.sql`, `supabase/migrations/20260928130000_durable_sync_changes.sql`

---

## 1. Overview

Row Level Security (RLS) in Artix guarantees that every row in PostgreSQL is cryptographically partitioned by user ownership. Regardless of client query parameters, PostgreSQL evaluates security policies before returning or modifying any data.

---

## 2. Authentication Flow & JWT Token Claims

1. User authenticates via Supabase Auth (`src/hooks/useAuth.tsx`) using PKCE flow.
2. Supabase issues a cryptographically signed JSON Web Token (JWT).
3. The JWT payload includes:
   ```json
   {
     "sub": "2f49aadd-3b10-4cb4-ba50-e6de0a9eb951",
     "aud": "authenticated",
     "role": "authenticated",
     "email": "developer@artix.dev"
   }
   ```
4. On every HTTPS REST call, the client passes `Authorization: Bearer <JWT>`.
5. PostgreSQL extracts the user ID using the native function `auth.uid()`.

---

## 3. Comprehensive RLS Policy Catalog

### 3.1 Entity Tables (`documents`, `system_designs`, `workspace_folders`)
Every entity table enforces four explicit policies:

```sql
-- SELECT Policy
CREATE POLICY "Users can select own documents"
  ON public.documents FOR SELECT
  USING (auth.uid() = user_id);

-- INSERT Policy
CREATE POLICY "Users can insert own documents"
  ON public.documents FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- UPDATE Policy
CREATE POLICY "Users can update own documents"
  ON public.documents FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- DELETE Policy
CREATE POLICY "Users can delete own documents"
  ON public.documents FOR DELETE
  USING (auth.uid() = user_id);
```

### 3.2 Change Feed Log (`public.sync_changes`)
```sql
-- Client read access:
CREATE POLICY "Users can read own sync changes"
  ON public.sync_changes FOR SELECT
  USING (auth.uid() = user_id);

-- Service role access (for automated cleanup workers):
CREATE POLICY "Service role full access on sync changes"
  ON public.sync_changes FOR ALL
  TO service_role
  USING (true);
```

### 3.3 Idempotency Ledger (`public.processed_mutations`)
```sql
CREATE POLICY "Users can select own processed mutations"
  ON public.processed_mutations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own processed mutations"
  ON public.processed_mutations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own processed mutations"
  ON public.processed_mutations FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

### 3.4 Billing Subscriptions (`public.subscriptions`)
```sql
-- Users can inspect their current plan:
CREATE POLICY "Users can view own subscription"
  ON public.subscriptions FOR SELECT
  USING (auth.uid() = user_id);

-- Only Supabase Edge Functions with service_role can update plan tiers:
CREATE POLICY "Service role can manage subscriptions"
  ON public.subscriptions FOR ALL
  TO service_role
  USING (true);
```
