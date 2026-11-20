-- Agents can read the requester's connected GitHub repositories, and people
-- can rename or delete their own past agent conversations from History.

CREATE OR REPLACE FUNCTION public.agent_known_tools()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['search_workspace', 'search_knowledge', 'read_file', 'read_conversation', 'list_tasks',
               'search_crm', 'search_crm_notes', 'read_crm_record', 'crm_report', 'compute_csv_metrics', 'list_drive',
               'web_search', 'browser_scrape', 'propose_task', 'propose_document', 'propose_drive_action',
               'propose_social_posts', 'propose_channel_message', 'propose_crm_update', 'read_calendar',
               'propose_calendar_event', 'workspace_metrics', 'read_brand_kit', 'fetch_site_page',
               'read_personal_notes', 'save_personal_note', 'delegate_to_specialists',
               'submit_tasks_for_approval', 'list_github_repos', 'read_github_repo'];
$$;

-- Removes it from History (the run records stay for usage accounting).
CREATE OR REPLACE FUNCTION public.agent_conversation_archive(p_conversation_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.agent_conversations SET archived_at = now()
  WHERE id = p_conversation_id AND created_by = auth.uid() AND archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conversation not found' USING ERRCODE = '42501'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.agent_conversation_rename(p_conversation_id uuid, p_title text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE clean text := btrim(coalesce(p_title, ''));
BEGIN
  IF length(clean) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Use a title of 1 to 200 characters' USING ERRCODE = '22023'; END IF;
  UPDATE public.agent_conversations SET title = clean
  WHERE id = p_conversation_id AND created_by = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Conversation not found' USING ERRCODE = '42501'; END IF;
END $$;

REVOKE ALL ON FUNCTION public.agent_conversation_archive(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.agent_conversation_rename(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_conversation_archive(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_conversation_rename(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
