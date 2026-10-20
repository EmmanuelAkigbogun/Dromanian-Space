-- Editors may share Drive items by default, matching collaborative Drive
-- behavior. Owners retain the per-item switch and can disable re-sharing.
ALTER TABLE public.drive_items
  ALTER COLUMN editors_can_share SET DEFAULT true;

UPDATE public.drive_items
SET editors_can_share = true
WHERE editors_can_share = false;

NOTIFY pgrst, 'reload schema';
