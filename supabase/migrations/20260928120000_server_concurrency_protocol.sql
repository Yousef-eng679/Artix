-- Phase 5: Server Concurrency Protocol & CAS Row Versioning

-- 1. Add version column for optimistic concurrency control
ALTER TABLE public.documents 
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE public.system_designs 
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE public.workspace_folders 
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- 2. Add deleted_at column for durable soft-deletes/tombstones
ALTER TABLE public.documents 
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE NULL;

ALTER TABLE public.system_designs 
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE NULL;

ALTER TABLE public.workspace_folders 
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE NULL;

-- 3. Version increment and timestamp update trigger function
CREATE OR REPLACE FUNCTION public.increment_entity_version()
RETURNS TRIGGER AS $$
BEGIN
  NEW.version = OLD.version + 1;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Attach triggers to syncable tables
DROP TRIGGER IF EXISTS trigger_increment_documents_version ON public.documents;
CREATE TRIGGER trigger_increment_documents_version
BEFORE UPDATE ON public.documents
FOR EACH ROW
EXECUTE FUNCTION public.increment_entity_version();

DROP TRIGGER IF EXISTS trigger_increment_system_designs_version ON public.system_designs;
CREATE TRIGGER trigger_increment_system_designs_version
BEFORE UPDATE ON public.system_designs
FOR EACH ROW
EXECUTE FUNCTION public.increment_entity_version();

DROP TRIGGER IF EXISTS trigger_increment_workspace_folders_version ON public.workspace_folders;
CREATE TRIGGER trigger_increment_workspace_folders_version
BEFORE UPDATE ON public.workspace_folders
FOR EACH ROW
EXECUTE FUNCTION public.increment_entity_version();

-- 4. Durable processed mutations table for idempotency verification
CREATE TABLE IF NOT EXISTS public.processed_mutations (
  mutation_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  processed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.processed_mutations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own processed mutations"
ON public.processed_mutations FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own processed mutations"
ON public.processed_mutations FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_processed_mutations_user_entity 
ON public.processed_mutations (user_id, entity_type, entity_id);
