-- Company-scoped Social production workflow.
--
-- Managed-company brand material lives in a predictable `Brand kit` folder
-- directly below the company's Drive root. Until that folder exists, agents
-- may use only clearly named brand/logo/guideline files from the same company
-- tree. Social drafts preserve the creative work required for human review;
-- publishing remains in the existing explicit schedule RPC.

ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS content_channel text,
  ADD COLUMN IF NOT EXISTS content_format text,
  ADD COLUMN IF NOT EXISTS script text,
  ADD COLUMN IF NOT EXISTS visual_brief text,
  ADD COLUMN IF NOT EXISTS cta text,
  ADD COLUMN IF NOT EXISTS hashtags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS asset_refs jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_content_channel_check;
ALTER TABLE public.social_posts ADD CONSTRAINT social_posts_content_channel_check
  CHECK (content_channel IS NULL OR content_channel IN ('x', 'linkedin', 'facebook', 'pinterest', 'tiktok')) NOT VALID;
ALTER TABLE public.social_posts VALIDATE CONSTRAINT social_posts_content_channel_check;

ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_content_format_check;
ALTER TABLE public.social_posts ADD CONSTRAINT social_posts_content_format_check
  CHECK (content_format IS NULL OR content_format IN ('feed', 'carousel', 'story', 'reel', 'short_video', 'long_video')) NOT VALID;
ALTER TABLE public.social_posts VALIDATE CONSTRAINT social_posts_content_format_check;

ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_script_check;
ALTER TABLE public.social_posts ADD CONSTRAINT social_posts_script_check
  CHECK (script IS NULL OR length(script) <= 30000) NOT VALID;
ALTER TABLE public.social_posts VALIDATE CONSTRAINT social_posts_script_check;

ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_visual_brief_check;
ALTER TABLE public.social_posts ADD CONSTRAINT social_posts_visual_brief_check
  CHECK (visual_brief IS NULL OR length(visual_brief) <= 10000) NOT VALID;
ALTER TABLE public.social_posts VALIDATE CONSTRAINT social_posts_visual_brief_check;

ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_cta_check;
ALTER TABLE public.social_posts ADD CONSTRAINT social_posts_cta_check
  CHECK (cta IS NULL OR length(cta) <= 500) NOT VALID;
ALTER TABLE public.social_posts VALIDATE CONSTRAINT social_posts_cta_check;

ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_hashtags_check;
ALTER TABLE public.social_posts ADD CONSTRAINT social_posts_hashtags_check
  CHECK (cardinality(hashtags) <= 30) NOT VALID;
ALTER TABLE public.social_posts VALIDATE CONSTRAINT social_posts_hashtags_check;

ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_asset_refs_check;
ALTER TABLE public.social_posts ADD CONSTRAINT social_posts_asset_refs_check
  CHECK (jsonb_typeof(asset_refs) = 'array' AND jsonb_array_length(asset_refs) <= 12) NOT VALID;
ALTER TABLE public.social_posts VALIDATE CONSTRAINT social_posts_asset_refs_check;

CREATE INDEX IF NOT EXISTS idx_social_posts_company_workflow
  ON public.social_posts (workspace_id, company_id, status, coalesce(scheduled_at, created_at) DESC);

-- Return canonical brand assets and source documents. Company mode never uses
-- the workspace-global brand folder, so one client's brand cannot leak into
-- another client's work.
CREATE OR REPLACE FUNCTION public.agent_brand_kit_items_v2_scoped_for(
  p_actor uuid, p_workspace_id uuid, p_company_id uuid
) RETURNS TABLE(
  id uuid, name text, kind text, mime_type text, index_status text,
  source_mode text, brand_folder_id uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_root_id uuid;
  v_brand_folder_id uuid;
BEGIN
  PERFORM public.crm_validate_agent_client(p_actor, p_workspace_id, p_company_id);

  IF p_company_id IS NULL THEN
    RETURN QUERY
    SELECT item.id, item.name, item.kind, item.mime_type, source.status,
           'workspace_folder'::text, settings.brand_kit_folder_id
    FROM public.agent_brand_kit_items_for(p_actor, p_workspace_id) scoped
    JOIN public.drive_items item ON item.id = scoped.id
    JOIN public.workspace_ai_settings settings ON settings.workspace_id = p_workspace_id
    LEFT JOIN LATERAL (
      SELECT latest.status
      FROM public.knowledge_sources latest
      WHERE latest.item_id = item.id AND latest.superseded_at IS NULL
      ORDER BY latest.created_at DESC
      LIMIT 1
    ) source ON true
    ORDER BY lower(item.name), item.id
    LIMIT 100;
    RETURN;
  END IF;

  SELECT company.drive_folder_id INTO v_root_id
  FROM public.crm_companies company
  WHERE company.id = p_company_id
    AND company.workspace_id = p_workspace_id
    AND company.is_client
    AND company.client_id IS NULL;
  IF v_root_id IS NULL OR NOT public.drive_viewable_by(v_root_id, p_actor) THEN
    RETURN;
  END IF;

  SELECT folder.id INTO v_brand_folder_id
  FROM public.drive_items folder
  WHERE folder.workspace_id = p_workspace_id
    AND folder.parent_id = v_root_id
    AND folder.kind = 'folder'
    AND lower(btrim(folder.name)) = 'brand kit'
    AND folder.trashed_at IS NULL
    AND folder.purge_requested_at IS NULL
    AND public.drive_viewable_by(folder.id, p_actor)
  ORDER BY folder.created_at, folder.id
  LIMIT 1;

  IF v_brand_folder_id IS NOT NULL THEN
    RETURN QUERY
    WITH RECURSIVE brand_tree AS (
      SELECT folder.id, ARRAY[folder.id]::uuid[] AS path
      FROM public.drive_items folder
      WHERE folder.id = v_brand_folder_id
      UNION ALL
      SELECT child.id, parent.path || child.id
      FROM brand_tree parent
      JOIN public.drive_items child
        ON child.parent_id = parent.id
       AND child.workspace_id = p_workspace_id
      WHERE child.trashed_at IS NULL
        AND child.purge_requested_at IS NULL
        AND NOT child.id = ANY(parent.path)
        AND cardinality(parent.path) < 20
    )
    SELECT item.id, item.name, item.kind, item.mime_type, source.status,
           'company_brand_kit'::text, v_brand_folder_id
    FROM brand_tree scoped
    JOIN public.drive_items item ON item.id = scoped.id
    LEFT JOIN LATERAL (
      SELECT latest.status
      FROM public.knowledge_sources latest
      WHERE latest.item_id = item.id AND latest.superseded_at IS NULL
      ORDER BY latest.created_at DESC
      LIMIT 1
    ) source ON true
    WHERE item.kind <> 'folder'
      AND public.drive_viewable_by(item.id, p_actor)
    ORDER BY lower(item.name), item.id
    LIMIT 100;
    RETURN;
  END IF;

  -- Transitional fallback: only explicitly brand-like filenames from this
  -- company's Drive tree. The UI and tool both report that the canonical
  -- `Brand kit` folder is still missing.
  RETURN QUERY
  WITH RECURSIVE company_tree AS (
    SELECT root.id, ARRAY[root.id]::uuid[] AS path
    FROM public.drive_items root
    WHERE root.id = v_root_id
      AND root.trashed_at IS NULL
      AND root.purge_requested_at IS NULL
    UNION ALL
    SELECT child.id, parent.path || child.id
    FROM company_tree parent
    JOIN public.drive_items child
      ON child.parent_id = parent.id
     AND child.workspace_id = p_workspace_id
    WHERE child.trashed_at IS NULL
      AND child.purge_requested_at IS NULL
      AND NOT child.id = ANY(parent.path)
      AND cardinality(parent.path) < 20
  )
  SELECT item.id, item.name, item.kind, item.mime_type, source.status,
         'company_named_fallback'::text, NULL::uuid
  FROM company_tree scoped
  JOIN public.drive_items item ON item.id = scoped.id
  LEFT JOIN LATERAL (
    SELECT latest.status
    FROM public.knowledge_sources latest
    WHERE latest.item_id = item.id AND latest.superseded_at IS NULL
    ORDER BY latest.created_at DESC
    LIMIT 1
  ) source ON true
  WHERE item.kind <> 'folder'
    AND public.drive_viewable_by(item.id, p_actor)
    AND lower(item.name) ~ '(brand|logo|voice|tone|guideline|style[ _-]?guide|colo(u)?r|font|visual[ _-]?identity|asset)'
  ORDER BY lower(item.name), item.id
  LIMIT 50;
END $$;

-- Readiness is exposed only to authenticated members who can use Social. It
-- returns no Drive identifier that the caller cannot already open.
CREATE OR REPLACE FUNCTION public.social_company_brand_status(
  p_workspace_id uuid, p_company_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_root_id uuid;
  v_brand_folder_id uuid;
  v_asset_count integer := 0;
  v_indexed_count integer := 0;
  v_logo_count integer := 0;
  v_mode text;
BEGIN
  IF v_uid IS NULL
     OR NOT public.user_is_workspace_member(p_workspace_id, v_uid)
     OR NOT public.feature_visible_to(p_workspace_id, v_uid, 'social') THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  PERFORM public.crm_validate_agent_client(v_uid, p_workspace_id, p_company_id);

  SELECT company.drive_folder_id INTO v_root_id
  FROM public.crm_companies company
  WHERE company.id = p_company_id AND company.workspace_id = p_workspace_id;
  IF v_root_id IS NULL OR NOT public.drive_viewable_by(v_root_id, v_uid) THEN
    RETURN jsonb_build_object(
      'mode', 'drive_unavailable', 'company_drive_folder_id', NULL,
      'brand_folder_id', NULL, 'asset_count', 0, 'indexed_count', 0,
      'logo_count', 0, 'can_edit', false
    );
  END IF;

  SELECT folder.id INTO v_brand_folder_id
  FROM public.drive_items folder
  WHERE folder.workspace_id = p_workspace_id
    AND folder.parent_id = v_root_id
    AND folder.kind = 'folder'
    AND lower(btrim(folder.name)) = 'brand kit'
    AND folder.trashed_at IS NULL
    AND folder.purge_requested_at IS NULL
    AND public.drive_viewable_by(folder.id, v_uid)
  ORDER BY folder.created_at, folder.id
  LIMIT 1;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE asset.index_status = 'ready')::integer,
         count(*) FILTER (WHERE lower(asset.name) ~ 'logo')::integer
  INTO v_asset_count, v_indexed_count, v_logo_count
  FROM public.agent_brand_kit_items_v2_scoped_for(
    v_uid, p_workspace_id, p_company_id
  ) asset;

  v_mode := CASE
    WHEN v_brand_folder_id IS NOT NULL AND v_asset_count > 0 THEN 'ready'
    WHEN v_brand_folder_id IS NOT NULL THEN 'brand_kit_empty'
    WHEN v_asset_count > 0 THEN 'named_file_fallback'
    ELSE 'brand_kit_missing'
  END;
  RETURN jsonb_build_object(
    'mode', v_mode,
    'company_drive_folder_id', v_root_id,
    'brand_folder_id', v_brand_folder_id,
    'asset_count', v_asset_count,
    'indexed_count', v_indexed_count,
    'logo_count', v_logo_count,
    'can_edit', public.drive_can_edit(v_root_id, v_uid)
  );
END $$;

-- Canonicalize and authorize Drive assets before they can enter a proposal or
-- a saved draft. Labels always come from Drive, never from model output.
CREATE OR REPLACE FUNCTION public.social_validate_asset_refs(
  p_actor uuid, p_workspace_id uuid, p_company_id uuid, p_refs jsonb
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_ref jsonb;
  v_id uuid;
  v_item public.drive_items%ROWTYPE;
  v_output jsonb := '[]'::jsonb;
BEGIN
  IF p_refs IS NULL THEN RETURN v_output; END IF;
  IF jsonb_typeof(p_refs) <> 'array' OR jsonb_array_length(p_refs) > 12 THEN
    RAISE EXCEPTION 'Choose at most 12 Drive assets' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_refs) > 0 AND p_company_id IS NULL THEN
    RAISE EXCEPTION 'Choose a managed company before attaching brand assets'
      USING ERRCODE = '42501';
  END IF;
  IF p_company_id IS NOT NULL THEN
    PERFORM public.crm_validate_agent_client(p_actor, p_workspace_id, p_company_id);
  END IF;

  FOR v_ref IN SELECT value FROM jsonb_array_elements(p_refs)
  LOOP
    BEGIN
      v_id := nullif(coalesce(v_ref ->> 'item_id', v_ref ->> 'id'), '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'A Social asset id is invalid' USING ERRCODE = '22023';
    END;
    IF v_id IS NULL OR NOT public.agent_company_drive_contains_for(
      p_actor, p_workspace_id, p_company_id, v_id
    ) THEN
      RAISE EXCEPTION 'A Social asset is outside the selected managed company'
        USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_item
    FROM public.drive_items item
    WHERE item.id = v_id
      AND item.workspace_id = p_workspace_id
      AND item.kind <> 'folder'
      AND item.trashed_at IS NULL
      AND item.purge_requested_at IS NULL;
    IF v_item.id IS NULL THEN
      RAISE EXCEPTION 'A Social asset is not an available Drive file'
        USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_output) prior
      WHERE prior ->> 'item_id' = v_id::text
    ) THEN
      v_output := v_output || jsonb_build_array(jsonb_build_object(
        'item_id', v_item.id,
        'label', v_item.name,
        'mime_type', v_item.mime_type
      ));
    END IF;
  END LOOP;
  RETURN v_output;
END $$;

-- Tighten proposal normalization without replacing the existing company scope
-- implementation. This wrapper rejects portfolio-mode Social creation and
-- canonicalizes every referenced Drive asset inside the selected company.
DO $$ BEGIN
  IF to_regprocedure('public.agent_company_action_arguments_pre_social_workflow(uuid,text,jsonb)') IS NULL THEN
    ALTER FUNCTION public.agent_company_action_arguments(uuid, text, jsonb)
      RENAME TO agent_company_action_arguments_pre_social_workflow;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.agent_company_action_arguments(
  p_run_id uuid, p_action_type text, p_arguments jsonb
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_run public.agent_runs%ROWTYPE;
  v_company_id uuid;
  v_normalized jsonb;
  v_posts jsonb := '[]'::jsonb;
  v_post jsonb;
  v_hashtags jsonb;
  v_tag text;
  v_clean_tag text;
  v_clean_hashtags jsonb;
  v_channel text;
  v_format text;
BEGIN
  v_normalized := public.agent_company_action_arguments_pre_social_workflow(
    p_run_id, p_action_type, p_arguments
  );
  IF p_action_type <> 'create_social_drafts' THEN RETURN v_normalized; END IF;

  SELECT * INTO v_run FROM public.agent_runs WHERE id = p_run_id;
  v_company_id := nullif(v_run.scope ->> 'company_id', '')::uuid;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Choose a managed company before creating Social drafts'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(v_normalized -> 'posts') <> 'array'
     OR jsonb_array_length(v_normalized -> 'posts') NOT BETWEEN 1 AND 31 THEN
    RAISE EXCEPTION 'Provide between 1 and 31 Social drafts'
      USING ERRCODE = '22023';
  END IF;

  FOR v_post IN SELECT value FROM jsonb_array_elements(v_normalized -> 'posts')
  LOOP
    v_channel := nullif(btrim(coalesce(v_post ->> 'channel', '')), '');
    v_format := nullif(btrim(coalesce(v_post ->> 'format', '')), '');
    IF v_channel IS NULL OR v_channel NOT IN ('x', 'linkedin', 'facebook', 'pinterest', 'tiktok') THEN
      RAISE EXCEPTION 'Each Social draft needs a supported channel'
        USING ERRCODE = '22023';
    END IF;
    IF v_format IS NOT NULL AND v_format NOT IN ('feed', 'carousel', 'story', 'reel', 'short_video', 'long_video') THEN
      RAISE EXCEPTION 'A Social draft format is not supported'
        USING ERRCODE = '22023';
    END IF;
    IF length(coalesce(v_post ->> 'script', '')) > 30000
       OR length(coalesce(v_post ->> 'visual_brief', '')) > 10000
       OR length(coalesce(v_post ->> 'cta', '')) > 500 THEN
      RAISE EXCEPTION 'A Social draft workflow field is too long'
        USING ERRCODE = '22023';
    END IF;

    v_hashtags := coalesce(v_post -> 'hashtags', '[]'::jsonb);
    IF jsonb_typeof(v_hashtags) <> 'array' OR jsonb_array_length(v_hashtags) > 30 THEN
      RAISE EXCEPTION 'Use at most 30 hashtags per Social draft'
        USING ERRCODE = '22023';
    END IF;
    v_clean_hashtags := '[]'::jsonb;
    FOR v_tag IN SELECT value FROM jsonb_array_elements_text(v_hashtags)
    LOOP
      v_clean_tag := regexp_replace(btrim(v_tag), '^#+', '');
      IF length(v_clean_tag) NOT BETWEEN 1 AND 80 THEN
        RAISE EXCEPTION 'Each hashtag needs 1 to 80 characters'
          USING ERRCODE = '22023';
      END IF;
      IF NOT (v_clean_hashtags @> jsonb_build_array(v_clean_tag)) THEN
        v_clean_hashtags := v_clean_hashtags || jsonb_build_array(v_clean_tag);
      END IF;
    END LOOP;

    v_post := (v_post - 'company_id' - 'assets' - 'hashtags') || jsonb_build_object(
      'company_id', v_company_id,
      'channel', v_channel,
      'format', v_format,
      'hashtags', v_clean_hashtags,
      'assets', public.social_validate_asset_refs(
        v_run.requested_by, v_run.workspace_id, v_company_id,
        coalesce(v_post -> 'assets', '[]'::jsonb)
      )
    );
    v_posts := v_posts || jsonb_build_array(v_post);
  END LOOP;
  RETURN jsonb_set(v_normalized, '{posts}', v_posts, true);
END $$;

-- Preserve the structured workflow fields after the existing, cancellation-
-- safe proposal executor creates the draft rows.
DO $$ BEGIN
  IF to_regprocedure('public.agent_execute_proposal_pre_social_workflow(uuid)') IS NULL THEN
    ALTER FUNCTION public.agent_execute_proposal(uuid)
      RENAME TO agent_execute_proposal_pre_social_workflow;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.agent_execute_proposal(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_proposal public.agent_action_proposals%ROWTYPE;
  v_run public.agent_runs%ROWTYPE;
  v_result jsonb;
  v_post jsonb;
  v_post_id uuid;
  v_ordinality bigint;
BEGIN
  SELECT * INTO v_proposal
  FROM public.agent_action_proposals
  WHERE id = p_id;
  IF v_proposal.id IS NULL THEN
    RAISE EXCEPTION 'Proposal not found' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run FROM public.agent_runs WHERE id = v_proposal.run_id;

  v_result := public.agent_execute_proposal_pre_social_workflow(p_id);
  IF v_proposal.action_type <> 'create_social_drafts'
     OR jsonb_typeof(v_result -> 'post_ids') <> 'array' THEN
    RETURN v_result;
  END IF;

  FOR v_post, v_ordinality IN
    SELECT post.value, post.ordinality
    FROM jsonb_array_elements(v_proposal.arguments -> 'posts')
         WITH ORDINALITY AS post(value, ordinality)
  LOOP
    v_post_id := (v_result -> 'post_ids' ->> (v_ordinality - 1)::integer)::uuid;
    UPDATE public.social_posts
    SET content_channel = nullif(v_post ->> 'channel', ''),
        content_format = nullif(v_post ->> 'format', ''),
        script = nullif(v_post ->> 'script', ''),
        visual_brief = nullif(v_post ->> 'visual_brief', ''),
        cta = nullif(v_post ->> 'cta', ''),
        hashtags = ARRAY(
          SELECT value
          FROM jsonb_array_elements_text(coalesce(v_post -> 'hashtags', '[]'::jsonb))
        ),
        asset_refs = coalesce(v_post -> 'assets', '[]'::jsonb),
        updated_at = now()
    WHERE id = v_post_id
      AND workspace_id = v_proposal.workspace_id
      AND company_id = nullif(v_run.scope ->> 'company_id', '')::uuid
      AND status = 'draft';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A Social draft left the selected company scope'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN v_result;
END $$;

-- Save human review changes without publishing. Scheduling remains a separate
-- call to social_schedule_post and still requires explicit account selection.
CREATE OR REPLACE FUNCTION public.social_update_draft(
  p_post_id uuid, p_body text, p_link text, p_channel text,
  p_format text, p_script text, p_visual_brief text, p_cta text,
  p_hashtags text[], p_asset_refs jsonb
) RETURNS public.social_posts
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_post public.social_posts%ROWTYPE;
  v_assets jsonb;
  v_hashtags text[];
BEGIN
  SELECT * INTO v_post FROM public.social_posts WHERE id = p_post_id FOR UPDATE;
  IF v_uid IS NULL OR v_post.id IS NULL
     OR NOT public.user_is_workspace_member(v_post.workspace_id, v_uid)
     OR NOT public.feature_visible_to(v_post.workspace_id, v_uid, 'social')
     OR NOT (v_post.created_by = v_uid OR public.user_is_workspace_admin(v_post.workspace_id, v_uid)) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF v_post.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft can be edited' USING ERRCODE = '55000';
  END IF;
  IF length(btrim(coalesce(p_body, ''))) NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'A Social draft needs 1 to 10000 characters'
      USING ERRCODE = '22023';
  END IF;
  IF p_link IS NOT NULL AND nullif(btrim(p_link), '') IS NOT NULL
     AND (p_link !~* '^https?://' OR length(p_link) > 2000) THEN
    RAISE EXCEPTION 'The Social link must be an HTTP or HTTPS URL'
      USING ERRCODE = '22023';
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('x', 'linkedin', 'facebook', 'pinterest', 'tiktok') THEN
    RAISE EXCEPTION 'Choose a supported Social channel' USING ERRCODE = '22023';
  END IF;
  IF p_format IS NOT NULL AND p_format NOT IN ('feed', 'carousel', 'story', 'reel', 'short_video', 'long_video') THEN
    RAISE EXCEPTION 'Choose a supported Social format' USING ERRCODE = '22023';
  END IF;
  IF length(coalesce(p_script, '')) > 30000
     OR length(coalesce(p_visual_brief, '')) > 10000
     OR length(coalesce(p_cta, '')) > 500 THEN
    RAISE EXCEPTION 'A Social workflow field is too long' USING ERRCODE = '22023';
  END IF;
  IF cardinality(coalesce(p_hashtags, '{}')) > 30
     OR EXISTS (
       SELECT 1 FROM unnest(coalesce(p_hashtags, '{}')) hashtag
       WHERE length(regexp_replace(btrim(hashtag), '^#+', '')) NOT BETWEEN 1 AND 80
     ) THEN
    RAISE EXCEPTION 'Use up to 30 valid hashtags' USING ERRCODE = '22023';
  END IF;

  v_assets := public.social_validate_asset_refs(
    v_uid, v_post.workspace_id, v_post.company_id,
    coalesce(p_asset_refs, '[]'::jsonb)
  );
  SELECT coalesce(array_agg(cleaned ORDER BY ordinal), '{}') INTO v_hashtags
  FROM (
    SELECT DISTINCT ON (cleaned) cleaned, ordinal
    FROM (
      SELECT regexp_replace(btrim(value), '^#+', '') AS cleaned, ordinality AS ordinal
      FROM unnest(coalesce(p_hashtags, '{}')) WITH ORDINALITY AS tag(value, ordinality)
    ) normalized
    ORDER BY cleaned, ordinal
  ) unique_tags;

  UPDATE public.social_posts
  SET body = btrim(p_body),
      link = nullif(btrim(coalesce(p_link, '')), ''),
      content_channel = p_channel,
      content_format = p_format,
      script = nullif(btrim(coalesce(p_script, '')), ''),
      visual_brief = nullif(btrim(coalesce(p_visual_brief, '')), ''),
      cta = nullif(btrim(coalesce(p_cta, '')), ''),
      hashtags = v_hashtags,
      asset_refs = v_assets,
      updated_at = now()
  WHERE id = v_post.id
  RETURNING * INTO v_post;
  RETURN v_post;
END $$;

-- Teach both new and already-installed Social Media Managers the exact,
-- review-first workflow without changing private/custom agents.
UPDATE public.agent_templates
SET instructions =
  'You work in a multi-company management workspace. Require one selected managed company for every social request and never mix companies. Read the company Brand kit first; its canonical location is the Brand kit folder directly under the company Drive root. If that folder is missing, use only the clearly named company brand files returned by read_brand_kit and tell the requester to create/fill Brand kit. Research current public evidence only when enabled and useful. Build a channel-specific calendar for the requested goal, date range and frequency. Every proposed draft must include channel, caption, CTA and hashtags; include a script for video formats, a production-ready visual brief, and only Drive asset IDs returned by tools. Use propose_social_posts to create reviewable drafts. Never claim a draft was scheduled, published or sent: the requester must review it in Social, choose connected accounts, and explicitly schedule or publish it.',
    description = 'Creates company-specific calendars, scripts, captions and visual briefs from the selected company Brand kit, then prepares reviewable Social drafts.',
    capability = 'Creates a company-scoped social calendar and production package from permitted brand assets; publishing always remains a separate human-approved step.'
WHERE key = 'github_social_calendar';

DO $$
DECLARE
  v_agent record;
  v_next uuid;
  v_next_version integer;
  v_template public.agent_templates%ROWTYPE;
BEGIN
  SELECT * INTO v_template
  FROM public.agent_templates
  WHERE key = 'github_social_calendar';
  FOR v_agent IN
    SELECT agent.id, agent.workspace_id, agent.description,
           version.version_no, version.tools, version.source_scope,
           version.model, version.effort, version.max_tool_steps,
           version.created_by
    FROM public.workspace_agents agent
    JOIN public.workspace_agent_versions version
      ON version.id = agent.current_version_id
    WHERE agent.template_key = 'github_social_calendar'
      AND agent.status = 'active'
      AND agent.archived_at IS NULL
      AND version.instructions IS DISTINCT FROM v_template.instructions
  LOOP
    SELECT coalesce(max(version.version_no), 0) + 1
    INTO v_next_version
    FROM public.workspace_agent_versions version
    WHERE version.agent_id = v_agent.id;
    INSERT INTO public.workspace_agent_versions (
      agent_id, workspace_id, version_no, instructions, tools, source_scope,
      model, effort, max_tool_steps, created_by
    ) VALUES (
      v_agent.id, v_agent.workspace_id, v_next_version,
      v_template.instructions, v_agent.tools, v_agent.source_scope,
      v_agent.model, v_agent.effort, v_agent.max_tool_steps,
      v_agent.created_by
    ) RETURNING id INTO v_next;
    UPDATE public.workspace_agents
    SET current_version_id = v_next,
        description = v_template.description,
        updated_at = now()
    WHERE id = v_agent.id;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.agent_brand_kit_items_v2_scoped_for(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_brand_kit_items_v2_scoped_for(uuid, uuid, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.social_company_brand_status(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.social_company_brand_status(uuid, uuid)
  TO authenticated;

REVOKE ALL ON FUNCTION public.social_validate_asset_refs(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_company_action_arguments_pre_social_workflow(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_company_action_arguments(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_company_action_arguments(uuid, text, jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION public.agent_execute_proposal_pre_social_workflow(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_execute_proposal(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.social_update_draft(
  uuid, text, text, text, text, text, text, text, text[], jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.social_update_draft(
  uuid, text, text, text, text, text, text, text, text[], jsonb
) TO authenticated;

NOTIFY pgrst, 'reload schema';
