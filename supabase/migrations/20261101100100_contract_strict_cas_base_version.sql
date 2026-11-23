-- ============================================================================
-- ARTIX: TASK-01B (Contract Phase) — Strict Server-Side CAS Enforcement (Gap C-01)
--
-- Rollout Stage: CONTRACT (apply AFTER updated web clients with TASK-02 & TASK-03
-- have been deployed so no active client omits `p_base_version` on update/delete)
--   1. Rejects any `update` or `delete` mutation where `p_base_version IS NULL`
--      or `p_base_version < 1` with SQLSTATE `22023`.
--   2. Enforces exact `version = p_base_version` predicates across all four
--      synced entity tables (`projects`, `documents`, `system_designs`,
--      `workspace_folders`), closing Gap C-01 permanently.
-- ============================================================================

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

  -- Strict fail-closed CAS invariant (Gap C-01): update & delete MUST supply a positive baseline version
  IF p_operation IN ('update', 'delete') AND (p_base_version IS NULL OR p_base_version < 1) THEN
    RAISE EXCEPTION 'Valid positive p_base_version is required for % mutations (C-01)', p_operation
      USING ERRCODE = '22023';
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

  -- Step B: Execute entity mutation under strict CAS
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
         AND p.version = p_base_version
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
         AND p.version = p_base_version
      RETURNING p.version INTO v_version;

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
         AND d.version = p_base_version
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
         AND d.version = p_base_version
      RETURNING d.version INTO v_version;

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
         AND sd.version = p_base_version
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
         AND sd.version = p_base_version
      RETURNING sd.version INTO v_version;

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
         AND wf.version = p_base_version
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
         AND wf.version = p_base_version
      RETURNING wf.version INTO v_version;

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

COMMENT ON FUNCTION public.apply_sync_mutation(UUID, UUID, TEXT, UUID, TEXT, UUID, JSONB, INTEGER) IS
  'Atomically checks processed_mutations, enforces strict CAS (p_base_version >= 1) across projects/documents/system_designs/workspace_folders, emits structured conflict reasons, and records processed_mutations in one transaction.';
