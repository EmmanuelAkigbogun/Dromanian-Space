-- Forward fixes found by connected workflow tests.
CREATE OR REPLACE FUNCTION public.send_drive_message(p_channel_id uuid,p_parent_id uuid,p_content text,p_item_ids uuid[],p_grant_channel boolean,p_request_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE v_ws uuid; v_id uuid; v_item uuid;
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
  FOREACH v_item IN ARRAY p_item_ids LOOP
    IF drive_channel_access_gap(p_channel_id,v_item)>0 AND (NOT p_grant_channel OR NOT drive_can_manage_sharing(v_item,auth.uid())) THEN
      RAISE EXCEPTION 'Explicit permission to grant channel access is required' USING ERRCODE='42501';
    END IF;
  END LOOP;
  INSERT INTO messages(channel_id,user_id,content,parent_id) VALUES(p_channel_id,auth.uid(),coalesce(p_content,''),p_parent_id) RETURNING id INTO v_id;
  PERFORM drive_attach_to_message(v_id,p_item_ids,CASE WHEN p_grant_channel THEN 'viewer' ELSE NULL END);
  UPDATE messages SET drive_resource_count=cardinality(p_item_ids) WHERE id=v_id;
  INSERT INTO drive_message_requests VALUES(auth.uid(),p_request_id,v_ws,v_id);
  RETURN v_id;
END $$;
-- Public predicate answers only for the current caller, never an arbitrary actor.
CREATE OR REPLACE FUNCTION crm_link_task_visible(p_task_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT task_visible_to(p_task_id,auth.uid());
$$;
REVOKE ALL ON FUNCTION crm_link_task_visible(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION crm_link_task_visible(uuid) TO authenticated;
DROP POLICY links_read ON crm_links;
DROP POLICY links_create ON crm_links;
CREATE POLICY links_read ON crm_links FOR SELECT TO authenticated USING(user_is_workspace_member(workspace_id,auth.uid()) AND
 (item_id IS NULL OR drive_can_view(item_id,auth.uid())) AND (task_id IS NULL OR crm_link_task_visible(task_id)) AND (channel_id IS NULL OR user_is_channel_member(channel_id,auth.uid())));
CREATE POLICY links_create ON crm_links FOR INSERT TO authenticated WITH CHECK(created_by=auth.uid() AND user_is_workspace_member(workspace_id,auth.uid()) AND
 (item_id IS NULL OR drive_can_view(item_id,auth.uid())) AND (task_id IS NULL OR crm_link_task_visible(task_id)) AND (channel_id IS NULL OR user_is_channel_member(channel_id,auth.uid())));
NOTIFY pgrst,'reload schema';
