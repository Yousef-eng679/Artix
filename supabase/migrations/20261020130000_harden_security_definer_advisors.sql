-- ============================================================================
-- ARTIX: Harden SECURITY DEFINER Trigger Functions per Supabase Security Advisor
--   1. Revoke direct PostgREST RPC EXECUTE on `public.record_sync_change()`
--      from `PUBLIC`, `anon`, and `authenticated` (trigger invocation remains
--      unaffected).
--   2. Pin `SET search_path = public` on `public.handle_new_user()`.
-- ============================================================================

REVOKE ALL ON FUNCTION public.record_sync_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_sync_change() FROM anon;
REVOKE ALL ON FUNCTION public.record_sync_change() FROM authenticated;

ALTER FUNCTION public.handle_new_user() SET search_path = public;
