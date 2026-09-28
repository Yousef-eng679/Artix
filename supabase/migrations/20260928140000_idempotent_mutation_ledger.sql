-- ============================================================================
-- Phase C1: Mutation Identity & Idempotent Server Protocol
-- Enhances processed_mutations to track acknowledged version and timestamp
-- ============================================================================

ALTER TABLE public.processed_mutations
  ADD COLUMN IF NOT EXISTS version BIGINT NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NULL;

-- Ensure RLS policies allow SELECT, INSERT, and UPDATE for the owning user
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'processed_mutations' AND policyname = 'Users can update their own processed mutations'
  ) THEN
    CREATE POLICY "Users can update their own processed mutations"
      ON public.processed_mutations FOR UPDATE
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;
