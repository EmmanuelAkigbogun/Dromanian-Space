-- RLS policy expressions execute with the querying role's table privileges.
-- Keep the immutable audience table private and expose only the exact boolean
-- needed by the file_attachments SELECT policy.

CREATE OR REPLACE FUNCTION public.file_attachment_audience_allows(
  p_attachment_id uuid, p_channel_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.file_attachment_audiences audience
    WHERE audience.attachment_id = p_attachment_id
      AND audience.channel_id = p_channel_id
      AND audience.user_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.file_attachment_audience_allows(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.file_attachment_audience_allows(uuid, uuid)
  TO authenticated;

-- The table remains immutable and unreadable through PostgREST. The policy can
-- now evaluate audience membership without granting callers direct SELECT.
REVOKE ALL ON public.file_attachment_audiences
  FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "file_attachments_select" ON public.file_attachments;
CREATE POLICY "file_attachments_select" ON public.file_attachments
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.messages message
    WHERE message.id = file_attachments.message_id
      AND message.deleted_at IS NULL
      AND public.user_is_channel_member(message.channel_id, auth.uid())
      AND public.file_attachment_audience_allows(
        file_attachments.id, message.channel_id
      )
  )
);

SELECT public.revoke_anon_rpc_access();
NOTIFY pgrst, 'reload schema';
