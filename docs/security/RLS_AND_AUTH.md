# PostgreSQL Row Level Security (RLS) & Authentication Architecture

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `supabase/migrations/20260919082427_add_missing_rls_policies.sql`, `supabase/migrations/20260928130000_durable_sync_changes.sql`, `supabase/migrations/20261020130000_harden_security_definer_advisors.sql`, `supabase/migrations/20261101100200_sync_changes_retention_and_floor.sql`, `supabase/migrations/20261101100300_atomic_billing_reconciliation_and_manual_grants.sql`, `src/test/postgres/backendConcurrencyAndRls.pg.test.ts`

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

### 3.1 User-Owned Workspace, Profile & AI History Tables (`projects`, `documents`, `system_designs`, `workspace_folders`, `profiles`, `prd_generations`, `vibe_generations`, `agentic_workflows`)
All user-owned tables enforce `auth.uid() = user_id` on `SELECT`, `INSERT` (`WITH CHECK`), `UPDATE` (`USING` and `WITH CHECK`), and `DELETE`:

```sql
-- Example: public.documents (identical pattern on projects, system_designs, workspace_folders)
CREATE POLICY "Users can select own documents"
  ON public.documents FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own documents"
  ON public.documents FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own documents"
  ON public.documents FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own documents"
  ON public.documents FOR DELETE
  USING (auth.uid() = user_id);
```

### 3.2 Change Feed Log (`public.sync_changes`) & Retention Floor (`public.sync_retention_state`)
```sql
-- Client read access to own change feed:
CREATE POLICY "Users can read own sync changes"
  ON public.sync_changes FOR SELECT
  USING (auth.uid() = user_id);

-- Service role full access on sync_changes:
CREATE POLICY "Service role full access on sync changes"
  ON public.sync_changes FOR ALL
  TO service_role
  USING (true);

-- Retention floor watermark: authenticated read-only, service_role write
CREATE POLICY "Authenticated users can read sync retention floor"
  ON public.sync_retention_state FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role full access on sync retention state"
  ON public.sync_retention_state FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
```
`public.record_sync_change()` (`SECURITY DEFINER`, `SET search_path = public`) has `EXECUTE` revoked from `PUBLIC`, `anon`, and `authenticated`. `public.get_sync_feed_bounds()` runs as `SECURITY INVOKER` (`authenticated`), while `public.prune_sync_changes()` is restricted to `service_role`.

### 3.3 Idempotency Ledger (`public.processed_mutations`) & Atomic Sync RPC (`public.apply_sync_mutation`)
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
`public.apply_sync_mutation` runs as `SECURITY INVOKER` (`GRANT EXECUTE ... TO authenticated`) and explicitly asserts `IF auth.uid() IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION ... USING ERRCODE = '42501'; END IF;` before reading or mutating any row.

### 3.4 Billing, Webhook Ledger & Manual Grants (`public.subscriptions`, `public.stripe_events`, `public.manual_grants`)
```sql
-- Subscriptions: users can SELECT own row; writes occur only via service_role RPC reconcile_stripe_subscription
CREATE POLICY "Users can view own subscription"
  ON public.subscriptions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage subscriptions"
  ON public.subscriptions FOR ALL
  TO service_role
  USING (true);

-- Manual Grants: users can SELECT own row; writes restricted to service_role
CREATE POLICY "Users can view own manual grant"
  ON public.manual_grants FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
```
- `public.stripe_events` has RLS enabled with **zero** `anon` or `authenticated` policies (inaccessible to clients; accessed solely by `service_role` inside `public.reconcile_stripe_subscription`).
- `public.reconcile_stripe_subscription`, `public.user_has_active_pro_entitlement`, and `public.check_plan_tier_limit` (`SECURITY DEFINER`, `SET search_path = public`) have `EXECUTE` revoked from `PUBLIC`, `anon`, and `authenticated`.
