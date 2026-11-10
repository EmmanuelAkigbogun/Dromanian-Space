-- Keep both attachment bytes and metadata inside the immutable audience of a
-- live post. In particular, a legacy message deleted before Drive backfill
-- must not regain access through the grant created by that later backfill.

-- Repeat the additive audience setup defensively so this privacy migration can
-- repair a table or function removed during an operator-led recovery. Applied
-- migration files remain immutable and migrate.sh still rejects checksum
-- drift before reaching this repair.
CREATE TABLE IF NOT EXISTS public.file_attachment_audiences (
  attachment_id uuid NOT NULL REFERENCES public.file_attachments(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attachment_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_file_attachment_audiences_user_channel
  ON public.file_attachment_audiences (user_id, channel_id, attachment_id);

ALTER TABLE public.file_attachment_audiences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.file_attachment_audiences FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.capture_file_attachment_audience(p_attachment_id uuid)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  INSERT INTO public.file_attachment_audiences (attachment_id, channel_id, user_id)
  SELECT attachment.id, message.channel_id, member.user_id
  FROM public.file_attachments attachment
  JOIN public.messages message ON message.id = attachment.message_id
  JOIN public.channel_members member ON member.channel_id = message.channel_id
  WHERE attachment.id = p_attachment_id
    AND message.deleted_at IS NULL
    AND member.created_at <= coalesce(attachment.created_at, message.created_at, now())
  UNION
  SELECT attachment.id, message.channel_id, message.user_id
  FROM public.file_attachments attachment
  JOIN public.messages message ON message.id = attachment.message_id
  WHERE attachment.id = p_attachment_id
    AND message.deleted_at IS NULL
    AND message.user_id IS NOT NULL
  ON CONFLICT (attachment_id, user_id) DO NOTHING;
$$;

REVOKE ALL ON FUNCTION public.capture_file_attachment_audience(uuid) FROM PUBLIC, anon, authenticated;

INSERT INTO public.file_attachment_audiences (attachment_id, channel_id, user_id)
SELECT attachment.id, message.channel_id, member.user_id
FROM public.file_attachments attachment
JOIN public.messages message ON message.id = attachment.message_id
JOIN public.channel_members member ON member.channel_id = message.channel_id
WHERE message.deleted_at IS NULL
  AND member.created_at <= coalesce(attachment.created_at, message.created_at, now())
UNION
SELECT attachment.id, message.channel_id, message.user_id
FROM public.file_attachments attachment
JOIN public.messages message ON message.id = attachment.message_id
WHERE message.deleted_at IS NULL
  AND message.user_id IS NOT NULL
ON CONFLICT (attachment_id, user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.on_file_attachment_inserted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM public.capture_file_attachment_audience(NEW.id);
  PERFORM public.drive_link_attachment(NEW.id, 'message_attachment');
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'file attachment audience/Drive link failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END $$;

DROP POLICY IF EXISTS "file_attachments_select" ON public.file_attachments;
CREATE POLICY "file_attachments_select" ON public.file_attachments
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.messages message
    JOIN public.file_attachment_audiences audience
      ON audience.attachment_id = file_attachments.id
     AND audience.channel_id = message.channel_id
     AND audience.user_id = auth.uid()
    WHERE message.id = file_attachments.message_id
      AND message.deleted_at IS NULL
      AND public.user_is_channel_member(message.channel_id, auth.uid())
  )
);

CREATE OR REPLACE FUNCTION public.drive_role_for(p_item_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_item drive_items%ROWTYPE; v_best integer;
BEGIN
  IF p_user_id IS NULL OR p_item_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_item FROM drive_items WHERE id = p_item_id;
  IF v_item.id IS NULL OR v_item.trashed_at IS NOT NULL OR v_item.purge_requested_at IS NOT NULL THEN RETURN NULL; END IF;
  IF NOT user_is_workspace_member(v_item.workspace_id, p_user_id) THEN RETURN NULL; END IF;
  IF v_item.owner_id = p_user_id THEN RETURN 'owner'; END IF;

  WITH RECURSIVE chain AS (
    SELECT i.id, i.parent_id, i.inherit_permissions, i.owner_id, 0 AS depth
    FROM drive_items i WHERE i.id = p_item_id
    UNION ALL
    SELECT p.id, p.parent_id, p.inherit_permissions, p.owner_id, c.depth + 1
    FROM drive_items p JOIN chain c ON p.id = c.parent_id
    WHERE c.inherit_permissions AND c.depth < 50
  )
  SELECT max(r) INTO v_best FROM (
    SELECT 3 AS r FROM chain WHERE depth > 0 AND owner_id = p_user_id
    UNION ALL
    SELECT drive_role_rank(g.role)
    FROM drive_grants g JOIN chain c ON g.item_id = c.id
    WHERE (g.principal_type = 'user' AND g.user_id = p_user_id)
       OR g.principal_type = 'workspace'
       OR (
         g.principal_type = 'channel'
         AND user_is_channel_member(g.channel_id, p_user_id)
         AND (
           g.source NOT IN ('message_attachment', 'legacy_backfill')
           OR (
             g.source = 'message_attachment'
             AND EXISTS (
               SELECT 1
               FROM public.message_resources resource
               JOIN public.messages resource_message ON resource_message.id = resource.message_id
               WHERE resource.item_id = g.item_id
                 AND resource_message.channel_id = g.channel_id
                 AND resource_message.deleted_at IS NULL
             )
           )
           OR EXISTS (
             SELECT 1
             FROM public.file_attachment_drive_links attachment_link
             JOIN public.file_attachments attachment
               ON attachment.id = attachment_link.attachment_id
             JOIN public.messages attachment_message
               ON attachment_message.id = attachment.message_id
             JOIN public.file_attachment_audiences audience
               ON audience.attachment_id = attachment.id
              AND audience.channel_id = attachment_message.channel_id
              AND audience.user_id = p_user_id
             WHERE attachment_link.item_id = g.item_id
               AND attachment_message.channel_id = g.channel_id
               AND attachment_message.deleted_at IS NULL
           )
         )
       )
       OR (g.principal_type = 'project' AND (is_project_member(g.project_id, p_user_id) OR is_project_owner(g.project_id, p_user_id)))
  ) roles;

  RETURN CASE coalesce(v_best, 0) WHEN 3 THEN 'editor' WHEN 2 THEN 'commenter' WHEN 1 THEN 'viewer' ELSE NULL END;
END;
$$;

-- Remove snapshots for posts that were already deleted during an old upgrade.
-- A different live post of the same object retains its own independent row.
DELETE FROM public.file_attachment_audiences audience
USING public.file_attachments attachment, public.messages message
WHERE attachment.id = audience.attachment_id
  AND message.id = attachment.message_id
  AND message.deleted_at IS NOT NULL;

-- The historical soft-delete trigger could not reconcile a Drive grant that
-- did not exist yet. Reconcile those post-backfill grants now; the helper keeps
-- a grant whenever another live message still supplies the same audience.
DO $$
DECLARE candidate record;
BEGIN
  FOR candidate IN
    SELECT DISTINCT attachment_link.item_id, message.channel_id
    FROM public.file_attachment_drive_links attachment_link
    JOIN public.file_attachments attachment
      ON attachment.id = attachment_link.attachment_id
    JOIN public.messages message ON message.id = attachment.message_id
    WHERE attachment_link.item_id IS NOT NULL
      AND message.deleted_at IS NOT NULL
  LOOP
    PERFORM public.drive_reconcile_conversation_grant(
      candidate.item_id, candidate.channel_id
    );
  END LOOP;
END $$;

SELECT public.revoke_anon_rpc_access();
NOTIFY pgrst, 'reload schema';
