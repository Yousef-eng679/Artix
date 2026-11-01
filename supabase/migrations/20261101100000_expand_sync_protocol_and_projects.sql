-- ============================================================================
-- ARTIX: TASK-01A (Expand Phase) — Sync Protocol Mutation Correlation,
-- Structured Conflict Diagnostics, and Projects Outbox Sync Support
--
-- Rollout Stage: EXPAND (safe to apply BEFORE deploying updated web clients)
--   1. Adds `mutation_id UUID NULL` to `public.sync_changes` so `PullEngine`
--      recognizes self-echoes deterministically after ambiguous network losses
--      (Gap S-01 / Amendment C).
--   2. Promotes `public.projects` to a versioned, sync-tracked entity
--      (`version`, `deleted_at`, `increment_entity_version()`,
--      `record_sync_change()`, and `'project'` support in `apply_sync_mutation`).
--   3. Upgrades `public.apply_sync_mutation(...)` to return structured conflict
--      diagnostics (`reason`: `'version_mismatch'` | `'remote_deleted'` |
--      `'already_exists'`, `current_version`, `current_row`) while retaining
--      temporary Expand-window compatibility for older cached browser tabs
--      until `20261101100100_contract_strict_cas_base_version.sql` is applied.
-- ============================================================================

-- 1. Promote public.projects to CAS-versioned syncable entity
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

DROP TRIGGER IF EXISTS update_projects_updated_at ON public.projects;
DROP TRIGGER IF EXISTS trigger_increment_projects_version ON public.projects;
CREATE TRIGGER trigger_increment_projects_version
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.increment_entity_version();

-- 2. Expand public.sync_changes with mutation_id and 'project' entity_type
ALTER TABLE public.sync_changes
  ADD COLUMN IF NOT EXISTS mutation_id UUID NULL;

DO $$
DECLARE
  v_conname TEXT;
BEGIN
  FOR v_conname IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
     WHERE n.nspname = 'public'
       AND t.relname = 'sync_changes'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%entity_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.sync_changes DROP CONSTRAINT %I', v_conname);
  END LOOP;
END $$;

ALTER TABLE public.sync_changes
  ADD CONSTRAINT sync_changes_entity_type_check
  CHECK (entity_type IN ('project', 'document', 'system_design', 'workspace_folder'));

CREATE INDEX IF NOT EXISTS idx_sync_changes_user_mutation
  ON public.sync_changes (user_id, mutation_id)
  WHERE mutation_id IS NOT NULL;

-- 3. Update record_sync_change() to record 'project' events and root-scoped mutation_id
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
  v_ctx_mutation_id TEXT;
  v_ctx_entity_type TEXT;
  v_ctx_entity_id TEXT;
  v_mutation_id UUID := NULL;
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    v_entity_type := 'project';
  ELSIF TG_TABLE_NAME = 'documents' THEN
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

  -- Stamp mutation_id ONLY onto the direct root entity mutation (never onto cascaded child deletes)
  v_ctx_mutation_id := NULLIF(current_setting('artix.current_mutation_id', true), '');
  v_ctx_entity_type := NULLIF(current_setting('artix.current_mutation_entity_type', true), '');
  v_ctx_entity_id := NULLIF(current_setting('artix.current_mutation_entity_id', true), '');

  IF v_ctx_mutation_id IS NOT NULL
     AND v_ctx_entity_type = v_entity_type
     AND v_ctx_entity_id = v_entity_id THEN
    v_mutation_id := v_ctx_mutation_id::UUID;
  END IF;

  -- Serialize per-user sequence allocation until transaction commit (Audit F-001)
  PERFORM pg_advisory_xact_lock(
    hashtextextended('artix.sync_changes:' || v_user_id::TEXT, 0)
  );

  INSERT INTO public.sync_changes (
    user_id,
    entity_type,
    entity_id,
    operation,
    entity_version,
    mutation_id,
    payload,
    changed_at
  ) VALUES (
    v_user_id,
    v_entity_type,
    v_entity_id,
    v_op,
    v_version,
    v_mutation_id,
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

REVOKE ALL ON FUNCTION public.record_sync_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_sync_change() FROM anon;
REVOKE ALL ON FUNCTION public.record_sync_change() FROM authenticated;

COMMENT ON FUNCTION public.record_sync_change() IS
  'Appends commit-ordered change events (including root-scoped mutation_id) to public.sync_changes.';

DROP TRIGGER IF EXISTS trg_sync_changes_projects ON public.projects;
CREATE TRIGGER trg_sync_changes_projects
  AFTER INSERT OR UPDATE OR DELETE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.record_sync_change();

-- 4. Expand-phase apply_sync_mutation with structured conflict diagnostics and GUC correlation
CREATE OR REPLACE FUNCTION public.apply_sync_mutation(
  p_mutation_id UUID,
  p_user_id UUID,
  p_entity_type TEXT,
  p_entity_id UUID,
  p_operation TEXT,
  p_project_id UUID DEFAULT NULL,
  p_payload JSONB DEFAULT '{}'::JSONB,
  p_base_version INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_ledger_version BIGINT;
  v_ledger_updated_at TIMESTAMPTZ;
  v_version INTEGER;
  v_existing_version INTEGER;
  v_existing_row JSONB;
  v_updated_at TIMESTAMPTZ;
  v_effective_project_id UUID;
  v_folder_id UUID;
  v_parent_folder_id UUID;
  v_body JSONB := COALESCE(p_payload, '{}'::JSONB);
BEGIN
  IF p_mutation_id IS NULL OR p_user_id IS NULL OR p_entity_id IS NULL THEN
    RAISE EXCEPTION 'mutation_id, user_id, and entity_id are required'
      USING ERRCODE = '22023';
  END IF;

  IF auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Authenticated user does not match mutation user_id'
      USING ERRCODE = '42501';
  END IF;

  IF p_entity_type NOT IN ('project', 'document', 'system_design', 'workspace_folder') THEN
    RAISE EXCEPTION 'Unsupported entity_type: %', p_entity_type
      USING ERRCODE = '22023';
  END IF;

  IF p_operation NOT IN ('create', 'update', 'delete') THEN
    RAISE EXCEPTION 'Unsupported operation: %', p_operation
      USING ERRCODE = '22023';
  END IF;

  IF p_operation IN ('update', 'delete') AND (p_base_version IS NULL OR p_base_version <= 0) THEN
    RAISE WARNING '[artix-cas-deprecation] Legacy null/non-positive p_base_version (%) for % on %:%',
      p_base_version, p_operation, p_entity_type, p_entity_id;
  END IF;

  -- Serialize duplicate in-flight retries sharing the same mutation_id
  PERFORM pg_advisory_xact_lock(
    hashtextextended('artix.mutation:' || p_mutation_id::TEXT, 0)
  );

  -- Step A: Idempotency ledger check inside the same transaction
  SELECT pm.version, pm.updated_at
    INTO v_ledger_version, v_ledger_updated_at
    FROM public.processed_mutations AS pm
   WHERE pm.mutation_id = p_mutation_id
     AND pm.user_id = p_user_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'already_processed',
      'version', v_ledger_version,
      'updated_at', v_ledger_updated_at
    );
  END IF;

  v_effective_project_id := COALESCE(
    p_project_id,
    NULLIF(v_body->>'project_id', '')::UUID,
    NULLIF(v_body->>'projectId', '')::UUID
  );

  v_folder_id := CASE
    WHEN v_body ? 'folder_id' THEN NULLIF(v_body->>'folder_id', '')::UUID
    WHEN v_body ? 'folderId' THEN NULLIF(v_body->>'folderId', '')::UUID
    ELSE NULL
  END;

  v_parent_folder_id := CASE
    WHEN v_body ? 'parent_folder_id' THEN NULLIF(v_body->>'parent_folder_id', '')::UUID
    WHEN v_body ? 'parentFolderId' THEN NULLIF(v_body->>'parentFolderId', '')::UUID
    ELSE NULL
  END;

  -- Expose mutation context to record_sync_change() for this statement only
  PERFORM set_config('artix.current_mutation_id', p_mutation_id::TEXT, true);
  PERFORM set_config('artix.current_mutation_entity_type', p_entity_type, true);
  PERFORM set_config('artix.current_mutation_entity_id', p_entity_id::TEXT, true);

  -- Step B: Execute entity mutation
  IF p_entity_type = 'project' THEN
    IF p_operation = 'create' THEN
      INSERT INTO public.projects (
        id, user_id, name, updated_at
      ) VALUES (
        p_entity_id,
        p_user_id,
        COALESCE(NULLIF(btrim(v_body->>'name'), ''), 'Untitled Project'),
        now()
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING version, updated_at INTO v_version, v_updated_at;

      IF NOT FOUND THEN
        SELECT p.version, to_jsonb(p.*)
          INTO v_existing_version, v_existing_row
          FROM public.projects AS p
         WHERE p.id = p_entity_id AND p.user_id = p_user_id;
        RETURN jsonb_build_object(
          'status', 'conflict',
          'reason', 'already_exists',
          'current_version', v_existing_version,
          'current_row', v_existing_row
        );
      END IF;

    ELSIF p_operation = 'update' THEN
      UPDATE public.projects AS p
         SET name = CASE
               WHEN v_body ? 'name' AND v_body->>'name' IS NOT NULL THEN btrim(v_body->>'name')
               ELSE p.name
             END,
             updated_at = now()
       WHERE p.id = p_entity_id
         AND p.user_id = p_user_id
         AND (p_base_version IS NULL OR p_base_version <= 0 OR p.version = p_base_version)
      RETURNING p.version, p.updated_at INTO v_version, v_updated_at;

      IF NOT FOUND THEN
        SELECT p.version, to_jsonb(p.*)
          INTO v_existing_version, v_existing_row
          FROM public.projects AS p
         WHERE p.id = p_entity_id AND p.user_id = p_user_id;
        IF FOUND THEN
          RETURN jsonb_build_object(
            'status', 'conflict',
            'reason', 'version_mismatch',
            'current_version', v_existing_version,
            'current_row', v_existing_row
          );
        END IF;
        RETURN jsonb_build_object(
          'status', 'conflict',
          'reason', 'remote_deleted',
          'current_version', NULL
        );
      END IF;

    ELSIF p_operation = 'delete' THEN
      DELETE FROM public.projects AS p
       WHERE p.id = p_entity_id
         AND p.user_id = p_user_id
         AND (p_base_version IS NULL OR p_base_version <= 0 OR p.version = p_base_version)
      RETURNING p.version INTO v_version;

      IF NOT FOUND AND p_base_version IS NOT NULL AND p_base_version > 0 THEN
        SELECT p.version, to_jsonb(p.*)
          INTO v_existing_version, v_existing_row
          FROM public.projects AS p
         WHERE p.id = p_entity_id AND p.user_id = p_user_id;
        IF FOUND THEN
          RETURN jsonb_build_object(
            'status', 'conflict',
            'reason', 'version_mismatch',
            'current_version', v_existing_version,
            'current_row', v_existing_row
          );
        END IF;
      END IF;
      v_version := NULL;
      v_updated_at := now();
    END IF;

  ELSIF p_entity_type = 'document' THEN
    IF p_operation = 'create' THEN
      INSERT INTO public.documents (
        id, user_id, project_id, folder_id, title, content, format, updated_at
      ) VALUES (
        p_entity_id,
        p_user_id,
        v_effective_project_id,
        v_folder_id,
        COALESCE(NULLIF(v_body->>'title', ''), 'Untitled Document'),
        COALESCE(v_body->>'content', ''),
        COALESCE(NULLIF(v_body->>'format', ''), 'markdown'),
        now()
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING version, updated_at INTO v_version, v_updated_at;

      IF NOT FOUND THEN
        SELECT d.version, to_jsonb(d.*)
          INTO v_existing_version, v_existing_row
          FROM public.documents AS d
         WHERE d.id = p_entity_id AND d.user_id = p_user_id;
        RETURN jsonb_build_object(
          'status', 'conflict',
          'reason', 'already_exists',
          'current_version', v_existing_version,
          'current_row', v_existing_row
        );
      END IF;

    ELSIF p_operation = 'update' THEN
      UPDATE public.documents AS d
         SET title = CASE
               WHEN v_body ? 'title' AND v_body->>'title' IS NOT NULL THEN v_body->>'title'
               ELSE d.title
             END,
             content = CASE
               WHEN v_body ? 'content' AND v_body->>'content' IS NOT NULL THEN v_body->>'content'
               ELSE d.content
             END,
             format = CASE
               WHEN v_body ? 'format' AND v_body->>'format' IS NOT NULL THEN v_body->>'format'
               ELSE d.format
             END,
             folder_id = CASE
               WHEN (v_body ? 'folder_id') OR (v_body ? 'folderId') THEN v_folder_id
               ELSE d.folder_id
             END,
             updated_at = now()
       WHERE d.id = p_entity_id
         AND d.user_id = p_user_id
         AND (p_base_version IS NULL OR p_base_version <= 0 OR d.version = p_base_version)
      RETURNING d.version, d.updated_at INTO v_version, v_updated_at;

      IF NOT FOUND THEN
        SELECT d.version, to_jsonb(d.*)
          INTO v_existing_version, v_existing_row
          FROM public.documents AS d
         WHERE d.id = p_entity_id AND d.user_id = p_user_id;
        IF FOUND THEN
          RETURN jsonb_build_object(
            'status', 'conflict',
            'reason', 'version_mismatch',
            'current_version', v_existing_version,
            'current_row', v_existing_row
          );
        END IF;
        RETURN jsonb_build_object(
          'status', 'conflict',
          'reason', 'remote_deleted',
          'current_version', NULL
        );
      END IF;

    ELSIF p_operation = 'delete' THEN
      DELETE FROM public.documents AS d
       WHERE d.id = p_entity_id
         AND d.user_id = p_user_id
         AND (p_base_version IS NULL OR p_base_version <= 0 OR d.version = p_base_version)
      RETURNING d.version INTO v_version;

      IF NOT FOUND AND p_base_version IS NOT NULL AND p_base_version > 0 THEN
        SELECT d.version, to_jsonb(d.*)
          INTO v_existing_version, v_existing_row
          FROM public.documents AS d
         WHERE d.id = p_entity_id AND d.user_id = p_user_id;
        IF FOUND THEN
          RETURN jsonb_build_object(
            'status', 'conflict',
            'reason', 'version_mismatch',
            'current_version', v_existing_version,
            'current_row', v_existing_row
          );
        END IF;
      END IF;
      v_version := NULL;
      v_updated_at := now();
    END IF;

  ELSIF p_entity_type = 'system_design' THEN
    IF p_operation = 'create' THEN
      INSERT INTO public.system_designs (
        id, user_id, project_id, folder_id, name, board_state, updated_at
      ) VALUES (
        p_entity_id,
        p_user_id,
        v_effective_project_id,
        v_folder_id,
        COALESCE(NULLIF(v_body->>'name', ''), 'New System Design'),
        COALESCE(
          CASE
            WHEN v_body ? 'board_state' AND jsonb_typeof(v_body->'board_state') <> 'null' THEN v_body->'board_state'
            WHEN v_body ? 'boardState' AND jsonb_typeof(v_body->'boardState') <> 'null' THEN v_body->'boardState'
            ELSE NULL
          END,
          '{"nodes":[],"edges":[],"strokes":[]}'::JSONB
        ),
        now()
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING version, updated_at INTO v_version, v_updated_at;

      IF NOT FOUND THEN
        SELECT sd.version, to_jsonb(sd.*)
          INTO v_existing_version, v_existing_row
          FROM public.system_designs AS sd
         WHERE sd.id = p_entity_id AND sd.user_id = p_user_id;
        RETURN jsonb_build_object(
          'status', 'conflict',
          'reason', 'already_exists',
          'current_version', v_existing_version,
          'current_row', v_existing_row
        );
      END IF;

    ELSIF p_operation = 'update' THEN
      UPDATE public.system_designs AS sd
         SET name = CASE
               WHEN v_body ? 'name' AND v_body->>'name' IS NOT NULL THEN v_body->>'name'
               ELSE sd.name
             END,
             board_state = CASE
               WHEN v_body ? 'board_state' AND jsonb_typeof(v_body->'board_state') <> 'null' THEN v_body->'board_state'
               WHEN v_body ? 'boardState' AND jsonb_typeof(v_body->'boardState') <> 'null' THEN v_body->'boardState'
               ELSE sd.board_state
             END,
             folder_id = CASE
               WHEN (v_body ? 'folder_id') OR (v_body ? 'folderId') THEN v_folder_id
               ELSE sd.folder_id
             END,
             updated_at = now()
       WHERE sd.id = p_entity_id
         AND sd.user_id = p_user_id
         AND (p_base_version IS NULL OR p_base_version <= 0 OR sd.version = p_base_version)
      RETURNING sd.version, sd.updated_at INTO v_version, v_updated_at;

      IF NOT FOUND THEN
        SELECT sd.version, to_jsonb(sd.*)
          INTO v_existing_version, v_existing_row
          FROM public.system_designs AS sd
         WHERE sd.id = p_entity_id AND sd.user_id = p_user_id;
        IF FOUND THEN
          RETURN jsonb_build_object(
            'status', 'conflict',
            'reason', 'version_mismatch',
            'current_version', v_existing_version,
            'current_row', v_existing_row
          );
        END IF;
        RETURN jsonb_build_object(
          'status', 'conflict',
          'reason', 'remote_deleted',
          'current_version', NULL
        );
      END IF;

    ELSIF p_operation = 'delete' THEN
      DELETE FROM public.system_designs AS sd
       WHERE sd.id = p_entity_id
         AND sd.user_id = p_user_id
         AND (p_base_version IS NULL OR p_base_version <= 0 OR sd.version = p_base_version)
      RETURNING sd.version INTO v_version;

      IF NOT FOUND AND p_base_version IS NOT NULL AND p_base_version > 0 THEN
        SELECT sd.version, to_jsonb(sd.*)
          INTO v_existing_version, v_existing_row
          FROM public.system_designs AS sd
         WHERE sd.id = p_entity_id AND sd.user_id = p_user_id;
        IF FOUND THEN
          RETURN jsonb_build_object(
            'status', 'conflict',
            'reason', 'version_mismatch',
            'current_version', v_existing_version,
            'current_row', v_existing_row
          );
        END IF;
      END IF;
      v_version := NULL;
      v_updated_at := now();
    END IF;

  ELSIF p_entity_type = 'workspace_folder' THEN
    IF p_operation = 'create' THEN
      INSERT INTO public.workspace_folders (
        id, user_id, project_id, name, parent_folder_id, updated_at
      ) VALUES (
        p_entity_id,
        p_user_id,
        v_effective_project_id,
        v_body->>'name',
        v_parent_folder_id,
        now()
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING version, updated_at INTO v_version, v_updated_at;

      IF NOT FOUND THEN
        SELECT wf.version, to_jsonb(wf.*)
          INTO v_existing_version, v_existing_row
          FROM public.workspace_folders AS wf
         WHERE wf.id = p_entity_id AND wf.user_id = p_user_id;
        RETURN jsonb_build_object(
          'status', 'conflict',
          'reason', 'already_exists',
          'current_version', v_existing_version,
          'current_row', v_existing_row
        );
      END IF;

    ELSIF p_operation = 'update' THEN
      UPDATE public.workspace_folders AS wf
         SET name = CASE
               WHEN v_body ? 'name' AND v_body->>'name' IS NOT NULL THEN v_body->>'name'
               ELSE wf.name
             END,
             parent_folder_id = CASE
               WHEN (v_body ? 'parent_folder_id') OR (v_body ? 'parentFolderId') THEN v_parent_folder_id
               ELSE wf.parent_folder_id
             END,
             updated_at = now()
       WHERE wf.id = p_entity_id
         AND wf.user_id = p_user_id
         AND (p_base_version IS NULL OR p_base_version <= 0 OR wf.version = p_base_version)
      RETURNING wf.version, wf.updated_at INTO v_version, v_updated_at;

      IF NOT FOUND THEN
        SELECT wf.version, to_jsonb(wf.*)
          INTO v_existing_version, v_existing_row
          FROM public.workspace_folders AS wf
         WHERE wf.id = p_entity_id AND wf.user_id = p_user_id;
        IF FOUND THEN
          RETURN jsonb_build_object(
            'status', 'conflict',
            'reason', 'version_mismatch',
            'current_version', v_existing_version,
            'current_row', v_existing_row
          );
        END IF;
        RETURN jsonb_build_object(
          'status', 'conflict',
          'reason', 'remote_deleted',
          'current_version', NULL
        );
      END IF;

    ELSIF p_operation = 'delete' THEN
      DELETE FROM public.workspace_folders AS wf
       WHERE wf.id = p_entity_id
         AND wf.user_id = p_user_id
         AND (p_base_version IS NULL OR p_base_version <= 0 OR wf.version = p_base_version)
      RETURNING wf.version INTO v_version;

      IF NOT FOUND AND p_base_version IS NOT NULL AND p_base_version > 0 THEN
        SELECT wf.version, to_jsonb(wf.*)
          INTO v_existing_version, v_existing_row
          FROM public.workspace_folders AS wf
         WHERE wf.id = p_entity_id AND wf.user_id = p_user_id;
        IF FOUND THEN
          RETURN jsonb_build_object(
            'status', 'conflict',
            'reason', 'version_mismatch',
            'current_version', v_existing_version,
            'current_row', v_existing_row
          );
        END IF;
      END IF;
      v_version := NULL;
      v_updated_at := now();
    END IF;
  END IF;

  -- Clear statement mutation context
  PERFORM set_config('artix.current_mutation_id', '', true);
  PERFORM set_config('artix.current_mutation_entity_type', '', true);
  PERFORM set_config('artix.current_mutation_entity_id', '', true);

  -- Step C: Record processed_mutations atomically in the SAME transaction
  INSERT INTO public.processed_mutations (
    mutation_id,
    user_id,
    entity_type,
    entity_id,
    version,
    updated_at
  ) VALUES (
    p_mutation_id,
    p_user_id,
    p_entity_type,
    p_entity_id,
    v_version,
    v_updated_at
  );

  RETURN jsonb_build_object(
    'status', 'applied',
    'version', v_version,
    'updated_at', v_updated_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_sync_mutation(UUID, UUID, TEXT, UUID, TEXT, UUID, JSONB, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_sync_mutation(UUID, UUID, TEXT, UUID, TEXT, UUID, JSONB, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.apply_sync_mutation(UUID, UUID, TEXT, UUID, TEXT, UUID, JSONB, INTEGER) TO authenticated;
