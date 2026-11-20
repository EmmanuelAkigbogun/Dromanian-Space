-- A repository project can have its own Drive folder (My files → Projects → repo).
ALTER TABLE public.project_github_links
  ADD COLUMN IF NOT EXISTS drive_folder_id uuid REFERENCES public.drive_items(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
