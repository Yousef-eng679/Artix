-- ============================================================================
-- ARTIX: TASK-20 & TASK-27 — sync_changes Retention Window, Monotonic Floor,
-- and Feed Bounds RPC for Cursor-Below-Floor Resnapshot Recovery
--
-- Quantitative Storage & Growth Analysis (Rule 7 — TASK-20):
--   - Fixed tuple + B-tree index overhead per `public.sync_changes` row:
--       HeapTupleHeader (24 B) + line pointer (4 B) + sequence BIGINT (8 B) +
--       user_id UUID (16 B) + entity_type TEXT (~14 B) + entity_id TEXT (37 B) +
--       operation TEXT (~7 B) + entity_version BIGINT (8 B) +
--       mutation_id UUID (16 B) + changed_at TIMESTAMPTZ (8 B) +
--       3 B-tree index entries (~88 B) = ~225 B fixed/row.
--   - Variable `payload JSONB` (PostgreSQL PGLZ/LZ4 TOAST compressed):
--       * project / workspace_folder: ~220 B payload -> ~445 B/row
--       * document (~8 KB markdown): ~2.8 KB compressed -> ~3.0 KB/row (~8.2 KB raw)
--       * system_design (~12 KB board JSON): ~3.8 KB compressed -> ~4.0 KB/row (~12.2 KB raw)
--       * Weighted average across active editing (~120 coalesced mutations/DAU/day):
--         ~3.2 KB compressed / ~8.5 KB uncompressed per row.
--   - Unbounded vs 30-day Pruned Growth:
--       * 100 DAU:   360,000 rows / 30d -> ~1.15 GB compressed (~13.8 GB/yr unbounded)
--       * 1,000 DAU: 3,600,000 rows / 30d -> ~11.5 GB compressed (~138 GB/yr unbounded)
--   - Resolution:
--       1. `public.sync_retention_state` records the monotonic `min_retained_sequence`
--          floor BEFORE `prune_sync_changes()` deletes expired batches.
--       2. `public.get_sync_feed_bounds()` exposes `(min_retained_sequence, max_sequence)`
--          to authenticated clients.
--       3. Clients with `localCursor < min_retained_sequence` execute `resnapshotAll()`
--          against live entity tables + `pullAll()` above `max_sequence`.
--
-- Rollout Note (Rule 4):
--   Prepared in repository ONLY. Do NOT auto-apply to live Supabase.
-- ============================================================================

-- 1. Singleton watermark table tracking the monotonic pruned sequence floor
CREATE TABLE IF NOT EXISTS public.sync_retention_state (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  min_retained_sequence BIGINT NOT NULL DEFAULT 0 CHECK (min_retained_sequence >= 0),
  last_pruned_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.sync_retention_state (id, min_retained_sequence)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.sync_retention_state ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'sync_retention_state'
       AND policyname = 'Authenticated users can read sync retention floor'
  ) THEN
    CREATE POLICY "Authenticated users can read sync retention floor"
      ON public.sync_retention_state
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'sync_retention_state'
       AND policyname = 'Service role full access on sync retention state'
  ) THEN
    CREATE POLICY "Service role full access on sync retention state"
      ON public.sync_retention_state
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- 2. Supporting index for bounded batch pruning by age + sequence order
CREATE INDEX IF NOT EXISTS idx_sync_changes_changed_at_seq
  ON public.sync_changes (changed_at ASC, sequence ASC);

-- 3. Authenticated read RPC returning global retention floor + caller's feed ceiling
CREATE OR REPLACE FUNCTION public.get_sync_feed_bounds()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_min_retained BIGINT := 0;
  v_user_max_seq BIGINT := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required for get_sync_feed_bounds'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(srs.min_retained_sequence, 0)
    INTO v_min_retained
    FROM public.sync_retention_state AS srs
   WHERE srs.id = 1;

  SELECT COALESCE(MAX(sc.sequence), 0)
    INTO v_user_max_seq
    FROM public.sync_changes AS sc
   WHERE sc.user_id = v_uid;

  RETURN jsonb_build_object(
    'min_retained_sequence', GREATEST(COALESCE(v_min_retained, 0), 0),
    'max_sequence', GREATEST(COALESCE(v_user_max_seq, 0), COALESCE(v_min_retained, 0), 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_sync_feed_bounds() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_sync_feed_bounds() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_sync_feed_bounds() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sync_feed_bounds() TO service_role;

COMMENT ON FUNCTION public.get_sync_feed_bounds() IS
  'Returns { min_retained_sequence, max_sequence } for the authenticated user so PullEngine can detect pruned cursors and snapshot-hydrate safely.';

-- 4. Monotonic batched retention pruner (service_role / scheduled cron only)
CREATE OR REPLACE FUNCTION public.prune_sync_changes(
  p_retention INTERVAL DEFAULT INTERVAL '30 days',
  p_batch_limit INTEGER DEFAULT 10000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ;
  v_max_pruned_seq BIGINT;
  v_deleted_count BIGINT := 0;
  v_new_floor BIGINT := 0;
BEGIN
  IF p_retention IS NULL OR p_retention < INTERVAL '1 hour' THEN
    RAISE EXCEPTION 'p_retention must be at least 1 hour'
      USING ERRCODE = '22023';
  END IF;

  IF p_batch_limit IS NULL OR p_batch_limit <= 0 OR p_batch_limit > 100000 THEN
    RAISE EXCEPTION 'p_batch_limit must be between 1 and 100000'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize concurrent pruner invocations
  PERFORM pg_advisory_xact_lock(
    hashtextextended('artix.sync_changes.prune', 0)
  );

  v_cutoff := now() - p_retention;

  -- Identify contiguous oldest candidate sequences strictly up to v_cutoff
  -- (Using an ordered sequence upper bound guarantees we never create sequence holes
  -- below min_retained_sequence even if changed_at timestamps are slightly skewed.)
  SELECT MAX(cand.sequence)
    INTO v_max_pruned_seq
    FROM (
      SELECT sc.sequence
        FROM public.sync_changes AS sc
       WHERE sc.changed_at < v_cutoff
       ORDER BY sc.sequence ASC
       LIMIT p_batch_limit
    ) AS cand;

  IF v_max_pruned_seq IS NULL THEN
    SELECT COALESCE(srs.min_retained_sequence, 0)
      INTO v_new_floor
      FROM public.sync_retention_state AS srs
     WHERE srs.id = 1;

    RETURN jsonb_build_object(
      'deleted_count', 0,
      'min_retained_sequence', COALESCE(v_new_floor, 0)
    );
  END IF;

  -- Advance monotonic floor FIRST in the same transaction before deleting rows
  INSERT INTO public.sync_retention_state (
    id,
    min_retained_sequence,
    last_pruned_at,
    updated_at
  ) VALUES (
    1,
    v_max_pruned_seq,
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE
    SET min_retained_sequence = GREATEST(public.sync_retention_state.min_retained_sequence, EXCLUDED.min_retained_sequence),
        last_pruned_at = now(),
        updated_at = now()
  RETURNING min_retained_sequence INTO v_new_floor;

  DELETE FROM public.sync_changes AS sc
   WHERE sc.sequence <= v_max_pruned_seq
     AND sc.changed_at < v_cutoff;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'deleted_count', v_deleted_count,
    'min_retained_sequence', v_new_floor
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prune_sync_changes(INTERVAL, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_sync_changes(INTERVAL, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.prune_sync_changes(INTERVAL, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.prune_sync_changes(INTERVAL, INTEGER) TO service_role;

COMMENT ON FUNCTION public.prune_sync_changes(INTERVAL, INTEGER) IS
  'Advances sync_retention_state.min_retained_sequence monotonically and batch-prunes expired sync_changes rows.';
