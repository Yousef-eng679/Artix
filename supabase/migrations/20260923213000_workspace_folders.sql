-- 1. Create workspace_folders table
CREATE TABLE public.workspace_folders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (id, project_id)
);

-- 2. RLS
ALTER TABLE public.workspace_folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own folders"
  ON public.workspace_folders FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own folders"
  ON public.workspace_folders FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own folders"
  ON public.workspace_folders FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own folders"
  ON public.workspace_folders FOR DELETE
  USING (auth.uid() = user_id);

-- 3. Auto-update timestamp trigger
CREATE TRIGGER update_workspace_folders_updated_at
  BEFORE UPDATE ON public.workspace_folders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 4. Add nullable folder_id to documents and system_designs
ALTER TABLE public.documents
  ADD COLUMN folder_id UUID NULL;

ALTER TABLE public.system_designs
  ADD COLUMN folder_id UUID NULL;

-- 5. Composite FK for project-safe folder membership
ALTER TABLE public.documents
  ADD CONSTRAINT documents_folder_project_fk
  FOREIGN KEY (folder_id, project_id)
  REFERENCES public.workspace_folders(id, project_id)
  ON DELETE SET NULL;

ALTER TABLE public.system_designs
  ADD CONSTRAINT system_designs_folder_project_fk
  FOREIGN KEY (folder_id, project_id)
  REFERENCES public.workspace_folders(id, project_id)
  ON DELETE SET NULL;

-- 6. Case-insensitive unique folder name per project
CREATE UNIQUE INDEX IF NOT EXISTS workspace_folders_project_name_idx
  ON public.workspace_folders (project_id, lower(trim(name)));
