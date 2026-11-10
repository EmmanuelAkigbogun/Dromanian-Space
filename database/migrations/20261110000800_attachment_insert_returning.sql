-- INSERT ... RETURNING evaluates the table's SELECT policy before AFTER INSERT
-- triggers capture the immutable audience row. Let only the authenticated
-- author of that live message see their just-inserted attachment in that gap;
-- every other reader still requires the captured audience snapshot.

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
      AND (
        (
          file_attachments.user_id = auth.uid()
          AND message.user_id = auth.uid()
        )
        OR public.file_attachment_audience_allows(
          file_attachments.id, message.channel_id
        )
      )
  )
);

SELECT public.revoke_anon_rpc_access();
NOTIFY pgrst, 'reload schema';
