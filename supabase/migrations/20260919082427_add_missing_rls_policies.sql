-- §1.3: Add missing RLS UPDATE policies for prd_generations, vibe_generations,
-- agentic_workflows (each had GRANT UPDATE but no CREATE POLICY for UPDATE),
-- and missing DELETE policy for profiles (ON DELETE CASCADE on auth.users handles
-- account deletion at DB level, but RLS DELETE is needed for explicit row deletion).

-- prd_generations: GRANT UPDATE exists, UPDATE policy was missing
CREATE POLICY "Users can update own PRDs"
  ON public.prd_generations FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- vibe_generations: GRANT UPDATE exists, UPDATE policy was missing
CREATE POLICY "Users can update own vibe generations"
  ON public.vibe_generations FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- agentic_workflows: GRANT UPDATE exists, UPDATE policy was missing
CREATE POLICY "Users can update own agentic workflows"
  ON public.agentic_workflows FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- profiles: DELETE policy was missing (SELECT, INSERT, UPDATE already exist)
CREATE POLICY "Users can delete their own profile"
  ON public.profiles FOR DELETE TO authenticated
  USING (auth.uid() = user_id);
