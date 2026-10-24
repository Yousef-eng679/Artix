-- ============================================================================
-- ARTIX: Commit-Ordered Change Feed Sequence Allocation (Audit F-001)
--
-- Problem
--   public.sync_changes.sequence is a GENERATED ALWAYS AS IDENTITY column.
--   Identity values are allocated when the row is inserted, not when the
--   transaction commits. Two overlapping transactions for the same user can
--   therefore commit out of allocation order:
--
--     T_A inserts change -> sequence N   (still open)
--     T_B inserts change -> sequence N+1 (commits)
--     client pulls, sees N+1, advances cursor to N+1
--     T_A commits -> N is now visible but below the cursor -> skipped forever
--
-- Fix
--   Before allocating a sequence value, record_sync_change() takes a
--   transaction-scoped advisory lock keyed by the change's user_id. The lock
--   is released only when the transaction commits or rolls back, so a second
--   transaction for the same user cannot allocate a sequence value until the
--   first one has finished. For any single user, sequence allocation order
--   now equals commit order, which is the only ordering the PullEngine relies
--   on because every pull query filters by user_id.
--
-- Trade-offs
--   * Writes for the same user are serialized from the moment the trigger
--     fires until commit. PostgREST requests are single-statement
--     transactions, so the hold time is short.
--   * A multi-row transaction that updates rows in an order conflicting with
--     another same-user transaction can deadlock; PostgreSQL detects this and
--     aborts one transaction, which the client outbox retries.
--   * Advisory lock keys are 64-bit hashes; a hash collision between two users
--     only causes extra serialization, never incorrect ordering.
--   * Different users are not serialized against each other. Their sequence
--     values interleave globally, which is harmless because cursors are
--     per-user.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_sync_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entity_type TEXT;
  v_user_id UUID;
  v_entity_id TEXT;
  v_version BIGINT;
  v_payload JSONB;
  v_op TEXT;
BEGIN
  IF TG_TABLE_NAME = 'documents' THEN
    v_entity_type := 'document';
  ELSIF TG_TABLE_NAME = 'system_designs' THEN
    v_entity_type := 'system_design';
  ELSIF TG_TABLE_NAME = 'workspace_folders' THEN
    v_entity_type := 'workspace_folder';
  ELSE
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_op := 'delete';
    v_user_id := OLD.user_id;
    v_entity_id := OLD.id::TEXT;
    v_version := OLD.version;
    v_payload := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    v_op := 'create';
    v_user_id := NEW.user_id;
    v_entity_id := NEW.id::TEXT;
    v_version := NEW.version;
    v_payload := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_op := 'update';
    v_user_id := NEW.user_id;
    v_entity_id := NEW.id::TEXT;
    v_version := NEW.version;
    v_payload := to_jsonb(NEW);
  END IF;

  -- F-001: serialize per-user sequence allocation until this transaction ends.
  -- Must run BEFORE the INSERT below, because the INSERT is what allocates the
  -- identity value.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('artix.sync_changes:' || v_user_id::TEXT, 0)
  );

  INSERT INTO public.sync_changes (
    user_id,
    entity_type,
    entity_id,
    operation,
    entity_version,
    payload,
    changed_at
  ) VALUES (
    v_user_id,
    v_entity_type,
    v_entity_id,
    v_op,
    v_version,
    v_payload,
    now()
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.record_sync_change() IS
  'Appends a row to public.sync_changes. Takes a per-user transaction advisory '
  'lock before allocating the identity sequence so that, per user, sequence '
  'allocation order equals commit order (audit F-001).';

-- Triggers created in 20260928130000_durable_sync_changes.sql reference this
-- function by name, so replacing the function body is sufficient; no trigger
-- needs to be recreated.
