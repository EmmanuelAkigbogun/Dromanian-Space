-- Transactional Drive posts and dashboard queries, always under the caller's current access.
CREATE TABLE IF NOT EXISTS public.drive_message_requests (
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY(actor_id, request_id)
);
ALTER TABLE drive_message_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON drive_message_requests FROM anon, authenticated;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS drive_resource_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.send_drive_message(p_channel_id uuid,p_parent_id uuid,p_content text,p_item_ids uuid[],p_grant_channel boolean,p_request_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE v_ws uuid; v_id uuid;
BEGIN
  SELECT workspace_id INTO v_ws FROM channels WHERE id=p_channel_id;
  IF NOT user_is_channel_member(p_channel_id,auth.uid()) OR NOT user_is_workspace_member(v_ws,auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
  END IF;
  IF cardinality(p_item_ids) NOT BETWEEN 1 AND 20 OR length(p_content)>100000 THEN RAISE EXCEPTION 'Invalid message' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_request_id::text,0));
  SELECT message_id INTO v_id FROM drive_message_requests WHERE actor_id=auth.uid() AND request_id=p_request_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  IF p_parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM messages WHERE id=p_parent_id AND channel_id=p_channel_id AND parent_id IS NULL AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Thread not found' USING ERRCODE='42501';
  END IF;
  INSERT INTO messages(channel_id,user_id,content,parent_id) VALUES(p_channel_id,auth.uid(),coalesce(p_content,''),p_parent_id) RETURNING id INTO v_id;
  PERFORM drive_attach_to_message(v_id,p_item_ids,CASE WHEN p_grant_channel THEN 'viewer' ELSE NULL END);
  UPDATE messages SET drive_resource_count=cardinality(p_item_ids) WHERE id=v_id;
  INSERT INTO drive_message_requests VALUES(auth.uid(),p_request_id,v_ws,v_id);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION send_drive_message(uuid,uuid,text,uuid[],boolean,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION send_drive_message(uuid,uuid,text,uuid[],boolean,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.workspace_dashboard(p_workspace_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,extensions,pg_temp AS $$
SELECT jsonb_build_object(
 'tasks',(SELECT count(*) FROM tasks WHERE workspace_id=p_workspace_id AND deleted_at IS NULL AND archived_at IS NULL),
 'projects',(SELECT count(*) FROM projects WHERE workspace_id=p_workspace_id AND archived_at IS NULL),
 'members',(SELECT count(*) FROM workspace_members WHERE workspace_id=p_workspace_id),
 'approvals',(SELECT count(*) FROM agent_action_proposals WHERE workspace_id=p_workspace_id AND requested_for=auth.uid() AND status='pending' AND expires_at>now()),
 'notifications',(SELECT count(*) FROM notifications WHERE workspace_id=p_workspace_id AND user_id=auth.uid() AND NOT read),
 'recent_files',coalesce((SELECT jsonb_agg(x) FROM (SELECT i.id,i.name,i.kind FROM drive_item_views v JOIN drive_items i ON i.id=v.item_id WHERE v.user_id=auth.uid() AND v.workspace_id=p_workspace_id AND i.trashed_at IS NULL ORDER BY v.viewed_at DESC LIMIT 5) x),'[]'),
 'conversations',coalesce((SELECT jsonb_agg(x) FROM (SELECT id,title FROM agent_conversations WHERE workspace_id=p_workspace_id AND created_by=auth.uid() AND archived_at IS NULL ORDER BY last_message_at DESC LIMIT 5) x),'[]'),
 'recent_tasks',coalesce((SELECT jsonb_agg(x) FROM (SELECT id,title,status FROM tasks WHERE workspace_id=p_workspace_id AND deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 5) x),'[]')
) WHERE user_is_workspace_member(p_workspace_id,auth.uid());
$$;
REVOKE ALL ON FUNCTION workspace_dashboard(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION workspace_dashboard(uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
