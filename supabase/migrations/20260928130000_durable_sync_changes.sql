-- ============================================================================
-- ARTIX: Durable Pull Change Feed (Phase 6)
-- Creates sync_changes log and triggers for documents, system_designs, and folders.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.sync_changes (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('document', 'system_design', 'workspace_folder')),
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  entity_version BIGINT NOT NULL,
  payload JSONB,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for efficient cursor-based range scans per user
CREATE INDEX IF NOT EXISTS idx_sync_changes_user_seq 
  ON public.sync_changes (user_id, sequence ASC);

ALTER TABLE public.sync_changes ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sync_changes' AND policyname = 'Users can read own sync changes'
  ) THEN
    CREATE POLICY "Users can read own sync changes"
      ON public.sync_changes
      FOR SELECT
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sync_changes' AND policyname = 'Service role full access on sync changes'
  ) THEN
    CREATE POLICY "Service role full access on sync changes"
      ON public.sync_changes
      FOR ALL
      TO service_role
      USING (true);
  END IF;
END $$;

-- Trigger function to record change events into sync_changes
CREATE OR REPLACE FUNCTION public.record_sync_change()
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Attach triggers
DROP TRIGGER IF EXISTS trg_sync_changes_documents ON public.documents;
CREATE TRIGGER trg_sync_changes_documents
  AFTER INSERT OR UPDATE OR DELETE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.record_sync_change();

DROP TRIGGER IF EXISTS trg_sync_changes_system_designs ON public.system_designs;
CREATE TRIGGER trg_sync_changes_system_designs
  AFTER INSERT OR UPDATE OR DELETE ON public.system_designs
  FOR EACH ROW EXECUTE FUNCTION public.record_sync_change();

DROP TRIGGER IF EXISTS trg_sync_changes_workspace_folders ON public.workspace_folders;
CREATE TRIGGER trg_sync_changes_workspace_folders
  AFTER INSERT OR UPDATE OR DELETE ON public.workspace_folders
  FOR EACH ROW EXECUTE FUNCTION public.record_sync_change();
