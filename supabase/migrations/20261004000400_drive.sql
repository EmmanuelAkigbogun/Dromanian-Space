-- ============================================================================
-- 20261004000400_drive.sql
-- ----------------------------------------------------------------------------
-- Workspace Drive: folders, files and internal documents with independent
-- ownership, immutable versions, document revisions, typed sharing grants,
-- comments, access requests, stars and recents. See docs/PERMISSIONS.md.
--
-- Access model (one documented inheritance model):
--   * Effective role = max(owner, grants on the item and on every ancestor
--     folder reached while each node inherits). A restricted folder
--     (inherit_permissions = false) stops inheritance from its parents.
--   * Owners of an inheriting ancestor folder are editors of its contents.
--   * Grant principals: user, channel (current members), project (members),
--     workspace (all current members). Roles: viewer < commenter < editor.
--   * An active workspace membership is always required. Workspace admins get
--     no implicit access to anyone's files.
--   * Trashed items give no access (restore first); their owner and whoever
--     trashed them still see them in Trash.
--   * All writes go through the SECURITY DEFINER functions below; clients have
--     read access via RLS only.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.drive_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id uuid,
  kind text NOT NULL CHECK (kind IN ('folder', 'file', 'document')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 255 AND name !~ '[\\/\x01-\x1f]'),
  owner_id uuid NOT NULL REFERENCES auth.users(id),
  inherit_permissions boolean NOT NULL DEFAULT true,
  editors_can_share boolean NOT NULL DEFAULT false,
  mime_type text,
  size_bytes bigint NOT NULL DEFAULT 0,
  current_version_id uuid,
  current_revision_no integer NOT NULL DEFAULT 0,
  origin text NOT NULL DEFAULT 'upload'
    CHECK (origin IN ('upload', 'document', 'message_attachment', 'legacy_attachment', 'agent_output')),
  description text CHECK (description IS NULL OR length(description) <= 2000),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  trashed_at timestamptz,
  trashed_by uuid REFERENCES auth.users(id),
  trash_root_id uuid,
  purge_requested_at timestamptz,
  UNIQUE (id, workspace_id),
  CHECK (parent_id IS NULL OR parent_id <> id),
  FOREIGN KEY (parent_id, workspace_id) REFERENCES drive_items(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_drive_items_parent ON drive_items (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_drive_items_ws_owner ON drive_items (workspace_id, owner_id) WHERE trashed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_drive_items_ws_updated ON drive_items (workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_drive_items_trash ON drive_items (workspace_id, trashed_at) WHERE trashed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_drive_items_name_trgm ON drive_items USING gin (lower(name) extensions.gin_trgm_ops);

CREATE TABLE IF NOT EXISTS public.drive_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  version_no integer NOT NULL,
  storage_bucket text NOT NULL CHECK (storage_bucket IN ('drive', 'message-attachments')),
  storage_path text NOT NULL,
  original_name text NOT NULL,
  mime_type text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed', 'abandoned')),
  source text NOT NULL DEFAULT 'upload'
    CHECK (source IN ('upload', 'message_attachment', 'legacy_attachment', 'agent_output')),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  UNIQUE (item_id, version_no),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (item_id, workspace_id) REFERENCES drive_items(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_drive_versions_object ON drive_versions (storage_bucket, storage_path);
CREATE INDEX IF NOT EXISTS idx_drive_versions_pending ON drive_versions (created_at) WHERE status = 'pending';

ALTER TABLE drive_items DROP CONSTRAINT IF EXISTS drive_items_current_version_fk;
ALTER TABLE drive_items ADD CONSTRAINT drive_items_current_version_fk
  FOREIGN KEY (current_version_id, workspace_id) REFERENCES drive_versions(id, workspace_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS public.drive_document_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  revision_no integer NOT NULL,
  title text NOT NULL CHECK (length(title) <= 255),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 1000000),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'editor' CHECK (source IN ('editor', 'agent_output', 'restore', 'conflict_copy')),
  UNIQUE (item_id, revision_no),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (item_id, workspace_id) REFERENCES drive_items(id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.drive_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  item_id uuid NOT NULL,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'channel', 'project', 'workspace')),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  channel_id uuid,
  project_id uuid,
  role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'commenter', 'editor')),
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'message_attachment', 'legacy_backfill', 'access_request', 'agent_output')),
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((principal_type = 'user') = (user_id IS NOT NULL)),
  CHECK ((principal_type = 'channel') = (channel_id IS NOT NULL)),
  CHECK ((principal_type = 'project') = (project_id IS NOT NULL)),
  FOREIGN KEY (item_id, workspace_id) REFERENCES drive_items(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id, workspace_id) REFERENCES channels(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_drive_grants_principal
  ON drive_grants (item_id, principal_type, coalesce(user_id, channel_id, project_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_drive_grants_item ON drive_grants (item_id);
CREATE INDEX IF NOT EXISTS idx_drive_grants_user ON drive_grants (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_drive_grants_channel ON drive_grants (channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_drive_grants_project ON drive_grants (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_drive_grants_workspace ON drive_grants (workspace_id) WHERE principal_type = 'workspace';

CREATE TABLE IF NOT EXISTS public.drive_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  item_id uuid NOT NULL,
  version_id uuid,
  revision_no integer,
  parent_id uuid REFERENCES drive_comments(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  FOREIGN KEY (item_id, workspace_id) REFERENCES drive_items(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_drive_comments_item ON drive_comments (item_id, created_at);

CREATE TABLE IF NOT EXISTS public.drive_access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  item_id uuid NOT NULL,
  requester_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'commenter', 'editor')),
  message text CHECK (message IS NULL OR length(message) <= 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
  decided_by uuid REFERENCES auth.users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id, workspace_id) REFERENCES drive_items(id, workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_drive_access_requests_pending
  ON drive_access_requests (item_id, requester_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.drive_item_stars (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id),
  FOREIGN KEY (item_id, workspace_id) REFERENCES drive_items(id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.drive_item_views (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id),
  FOREIGN KEY (item_id, workspace_id) REFERENCES drive_items(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_drive_item_views_recent ON drive_item_views (user_id, workspace_id, viewed_at DESC);

-- Drive items referenced from messages (composer "Attach from Drive"). The
-- message points at the logical item, optionally pinned to a version.
CREATE TABLE IF NOT EXISTS public.message_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  message_id uuid NOT NULL,
  item_id uuid NOT NULL,
  version_id uuid,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, item_id),
  FOREIGN KEY (message_id, workspace_id) REFERENCES messages(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (item_id, workspace_id) REFERENCES drive_items(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (version_id, workspace_id) REFERENCES drive_versions(id, workspace_id) ON DELETE SET NULL (version_id)
);
CREATE INDEX IF NOT EXISTS idx_message_resources_item ON message_resources (item_id);

-- Every stored message attachment is backed by a Drive item (see trigger below).
CREATE TABLE IF NOT EXISTS public.file_attachment_drive_links (
  attachment_id uuid PRIMARY KEY REFERENCES file_attachments(id) ON DELETE CASCADE,
  workspace_id uuid,
  status text NOT NULL CHECK (status IN ('linked', 'link_attachment', 'missing_object', 'local_url', 'no_workspace')),
  item_id uuid,
  version_id uuid,
  storage_path text,
  note text,
  linked_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id, workspace_id) REFERENCES drive_items(id, workspace_id) ON DELETE SET NULL (item_id)
);
CREATE INDEX IF NOT EXISTS idx_fadl_item ON file_attachment_drive_links (item_id);

-- ---------------------------------------------------------------------------
-- Access functions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drive_role_rank(p_role text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_role WHEN 'owner' THEN 4 WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END;
$$;

-- Effective role of p_user_id on an item: owner | editor | commenter | viewer | NULL.
-- Internal: callable only by definer functions and the server, because it can
-- answer for any user. Clients use the self-only wrappers below.
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
       OR (g.principal_type = 'channel' AND user_is_channel_member(g.channel_id, p_user_id))
       OR (g.principal_type = 'project' AND (is_project_member(g.project_id, p_user_id) OR is_project_owner(g.project_id, p_user_id)))
  ) roles;

  RETURN CASE coalesce(v_best, 0) WHEN 3 THEN 'editor' WHEN 2 THEN 'commenter' WHEN 1 THEN 'viewer' ELSE NULL END;
END;
$$;

CREATE OR REPLACE FUNCTION public.drive_viewable_by(p_item_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT drive_role_for(p_item_id, p_user_id) IS NOT NULL;
$$;

-- Self-only predicates (used by RLS policies and client RPCs). They answer
-- only for the signed-in user, so they cannot be used to probe other people.
CREATE OR REPLACE FUNCTION public.drive_item_role(p_item_id uuid, p_user_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT CASE WHEN p_user_id = auth.uid() THEN drive_role_for(p_item_id, p_user_id) END;
$$;

CREATE OR REPLACE FUNCTION public.drive_can_view(p_item_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT p_user_id = auth.uid() AND drive_role_for(p_item_id, p_user_id) IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.drive_can_comment(p_item_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT p_user_id = auth.uid() AND drive_role_rank(drive_role_for(p_item_id, p_user_id)) >= 2;
$$;

CREATE OR REPLACE FUNCTION public.drive_can_edit(p_item_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT p_user_id = auth.uid() AND drive_role_rank(drive_role_for(p_item_id, p_user_id)) >= 3;
$$;

CREATE OR REPLACE FUNCTION public.drive_can_manage_sharing(p_item_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT p_user_id = auth.uid() AND CASE drive_role_for(p_item_id, p_user_id)
    WHEN 'owner' THEN true
    WHEN 'editor' THEN coalesce((SELECT editors_can_share FROM drive_items WHERE id = p_item_id), false)
    ELSE false END;
$$;

-- Trash visibility: the owner and the person who trashed an item see it in Trash.
CREATE OR REPLACE FUNCTION public.drive_can_see_in_trash(p_item_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT p_user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM drive_items i
    WHERE i.id = p_item_id AND i.trashed_at IS NOT NULL AND i.purge_requested_at IS NULL
      AND (i.owner_id = p_user_id OR i.trashed_by = p_user_id)
      AND user_is_workspace_member(i.workspace_id, p_user_id)
  );
$$;

-- Number of current members of a channel who cannot view an item (0 = the
-- channel audience can open it).
CREATE OR REPLACE FUNCTION public.drive_channel_access_gap(p_channel_id uuid, p_item_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT count(*)::integer FROM channel_members cm
  WHERE cm.channel_id = p_channel_id AND user_is_channel_member(p_channel_id, cm.user_id)
    AND NOT drive_viewable_by(p_item_id, cm.user_id);
$$;

-- Storage read check for objects referenced by Drive versions.
CREATE OR REPLACE FUNCTION public.drive_object_readable(p_bucket text, p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM drive_versions v
    WHERE v.storage_bucket = p_bucket AND v.storage_path = p_name
      AND (
        (v.status = 'ready' AND drive_can_view(v.item_id, auth.uid()))
        OR (v.status = 'pending' AND v.created_by = auth.uid())
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.drive_upload_target_ok(p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM drive_versions v
    WHERE v.storage_bucket = 'drive' AND v.storage_path = p_name AND v.status = 'pending'
      AND v.created_by = auth.uid() AND v.created_at > now() - interval '24 hours'
  );
$$;

-- Legacy message-attachment objects become readable through Drive grants too.
CREATE OR REPLACE FUNCTION public.storage_attachment_readable(p_name text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR p_name IS NULL THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM file_attachments fa JOIN messages m ON m.id = fa.message_id
    WHERE fa.file_url IN (p_name, 'message-attachments/' || p_name)
      AND user_is_channel_member(m.channel_id, v_uid)
  ) THEN RETURN true; END IF;
  IF drive_object_readable('message-attachments', p_name) THEN RETURN true; END IF;
  IF EXISTS (
    SELECT 1 FROM scheduled_message_attachments sa JOIN scheduled_messages s ON s.id = sa.scheduled_message_id
    WHERE sa.file_url IN (p_name, 'message-attachments/' || p_name) AND s.user_id = v_uid
  ) THEN RETURN true; END IF;
  IF p_name LIKE 'project-resources/%' AND EXISTS (
    SELECT 1 FROM project_resources pr JOIN projects p ON p.id = pr.project_id
    WHERE pr.type = 'image' AND pr.url IN (p_name, 'message-attachments/' || p_name)
      AND user_is_workspace_member(p.workspace_id, v_uid)
  ) THEN RETURN true; END IF;
  IF p_name LIKE 'automation/%' AND EXISTS (
    SELECT 1 FROM automation_actions aa
    WHERE jsonb_typeof(aa.config -> 'attachments') = 'array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(aa.config -> 'attachments') att
                  WHERE att ->> 'file_url' IN (p_name, 'message-attachments/' || p_name))
      AND can_view_automation_rule(aa.rule_id)
  ) THEN RETURN true; END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.storage_attachment_unreferenced(p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM file_attachments WHERE file_url IN (p_name, 'message-attachments/' || p_name))
     AND NOT EXISTS (SELECT 1 FROM scheduled_message_attachments WHERE file_url IN (p_name, 'message-attachments/' || p_name))
     AND NOT EXISTS (SELECT 1 FROM project_resources WHERE url IN (p_name, 'message-attachments/' || p_name))
     AND NOT EXISTS (SELECT 1 FROM drive_versions WHERE storage_bucket = 'message-attachments' AND storage_path = p_name)
     AND NOT EXISTS (
       SELECT 1 FROM automation_actions aa
       WHERE jsonb_typeof(aa.config -> 'attachments') = 'array'
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(aa.config -> 'attachments') att
                     WHERE att ->> 'file_url' IN (p_name, 'message-attachments/' || p_name)));
$$;

-- ---------------------------------------------------------------------------
-- Row level security (reads only; writes go through functions)
-- ---------------------------------------------------------------------------
ALTER TABLE drive_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_document_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_item_stars ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_item_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_attachment_drive_links ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON drive_items, drive_versions, drive_document_revisions, drive_grants,
  drive_comments, drive_access_requests, drive_item_stars, drive_item_views, message_resources,
  file_attachment_drive_links FROM anon, authenticated;

DROP POLICY IF EXISTS "drive_items_select" ON drive_items;
CREATE POLICY "drive_items_select" ON drive_items FOR SELECT TO authenticated
  USING (public.drive_can_view(id, auth.uid()) OR public.drive_can_see_in_trash(id, auth.uid()));

DROP POLICY IF EXISTS "drive_versions_select" ON drive_versions;
CREATE POLICY "drive_versions_select" ON drive_versions FOR SELECT TO authenticated
  USING ((status = 'ready' AND public.drive_can_view(item_id, auth.uid())) OR (status = 'pending' AND created_by = auth.uid()));

DROP POLICY IF EXISTS "drive_revisions_select" ON drive_document_revisions;
CREATE POLICY "drive_revisions_select" ON drive_document_revisions FOR SELECT TO authenticated
  USING (public.drive_can_view(item_id, auth.uid()));

DROP POLICY IF EXISTS "drive_grants_select" ON drive_grants;
CREATE POLICY "drive_grants_select" ON drive_grants FOR SELECT TO authenticated
  USING (public.drive_can_view(item_id, auth.uid()));

DROP POLICY IF EXISTS "drive_comments_select" ON drive_comments;
CREATE POLICY "drive_comments_select" ON drive_comments FOR SELECT TO authenticated
  USING (public.drive_can_view(item_id, auth.uid()));

DROP POLICY IF EXISTS "drive_access_requests_select" ON drive_access_requests;
CREATE POLICY "drive_access_requests_select" ON drive_access_requests FOR SELECT TO authenticated
  USING (requester_id = auth.uid() OR public.drive_can_manage_sharing(item_id, auth.uid()));

DROP POLICY IF EXISTS "drive_item_stars_select" ON drive_item_stars;
CREATE POLICY "drive_item_stars_select" ON drive_item_stars FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.drive_can_view(item_id, auth.uid()));

DROP POLICY IF EXISTS "drive_item_views_select" ON drive_item_views;
CREATE POLICY "drive_item_views_select" ON drive_item_views FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.drive_can_view(item_id, auth.uid()));

-- Channel members see that a message references an item; the item itself is
-- only visible if they can view it (otherwise the client shows "restricted").
DROP POLICY IF EXISTS "message_resources_select" ON message_resources;
CREATE POLICY "message_resources_select" ON message_resources FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM messages m WHERE m.id = message_id AND public.user_is_channel_member(m.channel_id, auth.uid())));

DROP POLICY IF EXISTS "fadl_select" ON file_attachment_drive_links;
CREATE POLICY "fadl_select" ON file_attachment_drive_links FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM file_attachments fa JOIN messages m ON m.id = fa.message_id
                 WHERE fa.id = attachment_id AND public.user_is_channel_member(m.channel_id, auth.uid())));

-- ---------------------------------------------------------------------------
-- Storage bucket "drive"
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('drive', 'drive', false, 52428800)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS "drive_objects_insert" ON storage.objects;
DROP POLICY IF EXISTS "drive_objects_select" ON storage.objects;
CREATE POLICY "drive_objects_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'drive' AND public.drive_upload_target_ok(name));
CREATE POLICY "drive_objects_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'drive' AND public.drive_object_readable('drive', name));
-- No UPDATE/DELETE policies: versions are immutable and removal happens in the
-- trusted purge job.

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drive_require_member(p_workspace_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT user_is_workspace_member(p_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not a workspace member' USING ERRCODE = '42501';
  END IF;
  RETURN auth.uid();
END $$;

CREATE OR REPLACE FUNCTION public.drive_clean_name(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT left(btrim(regexp_replace(coalesce(p_name, ''), '[\\/\x01-\x1f]+', '-', 'g')), 255);
$$;

-- Hook replaced by the knowledge migration; enqueues extraction/indexing.
CREATE OR REPLACE FUNCTION public.knowledge_enqueue_source(p_item_id uuid, p_version_id uuid, p_revision_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  RETURN;
END $$;

CREATE OR REPLACE FUNCTION public.drive_notify(p_user_id uuid, p_workspace_id uuid, p_title text, p_message text,
  p_link text, p_entity_id uuid, p_type text DEFAULT 'share')
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  INSERT INTO notifications (user_id, type, title, message, link, category, entity_type, entity_id, actor_id, workspace_id)
  SELECT p_user_id, p_type, left(p_title, 300), left(p_message, 2000), p_link, 'workspace', 'file', p_entity_id, auth.uid(), p_workspace_id
  WHERE p_user_id IS DISTINCT FROM auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.drive_audit(p_workspace_id uuid, p_action text, p_item_id uuid, p_metadata jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
  VALUES (p_workspace_id, auth.uid(), p_action, 'drive_item', p_item_id, coalesce(p_metadata, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- Folders and uploads
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drive_check_parent(p_workspace_id uuid, p_parent_id uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_parent drive_items%ROWTYPE;
BEGIN
  IF p_parent_id IS NULL THEN RETURN; END IF;
  SELECT * INTO v_parent FROM drive_items WHERE id = p_parent_id;
  IF v_parent.id IS NULL OR v_parent.workspace_id <> p_workspace_id OR v_parent.kind <> 'folder' THEN
    RAISE EXCEPTION 'Folder not found' USING ERRCODE = '42501';
  END IF;
  IF NOT drive_can_edit(p_parent_id, auth.uid()) THEN
    RAISE EXCEPTION 'You need edit access to this folder' USING ERRCODE = '42501';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.drive_create_folder(p_workspace_id uuid, p_parent_id uuid, p_name text)
RETURNS drive_items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := drive_require_member(p_workspace_id); v_row drive_items%ROWTYPE;
BEGIN
  PERFORM drive_check_parent(p_workspace_id, p_parent_id);
  INSERT INTO drive_items (workspace_id, parent_id, kind, name, owner_id, created_by, updated_by, origin)
  VALUES (p_workspace_id, p_parent_id, 'folder', drive_clean_name(p_name), v_uid, v_uid, v_uid, 'upload')
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Starts an upload: creates (or versions) an item and a pending version. The
-- client uploads to bucket "drive" at the returned path, then finalizes.
CREATE OR REPLACE FUNCTION public.drive_begin_upload(
  p_workspace_id uuid, p_parent_id uuid, p_name text, p_mime_type text, p_size_bytes bigint,
  p_item_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_uid uuid := drive_require_member(p_workspace_id);
  v_item drive_items%ROWTYPE;
  v_version_id uuid := gen_random_uuid();
  v_version_no integer;
  v_name text := drive_clean_name(p_name);
  v_limit bigint := coalesce((SELECT file_size_limit FROM storage.buckets WHERE id = 'drive'), 52428800);
  v_path text;
BEGIN
  IF v_name = '' THEN RAISE EXCEPTION 'A file name is required' USING ERRCODE = '22023'; END IF;
  IF p_size_bytes IS NULL OR p_size_bytes < 0 THEN RAISE EXCEPTION 'Invalid file size' USING ERRCODE = '22023'; END IF;
  IF p_size_bytes > v_limit THEN
    RAISE EXCEPTION 'File is larger than the % MB limit', v_limit / 1048576 USING ERRCODE = '22023';
  END IF;
  IF p_item_id IS NULL THEN
    PERFORM drive_check_parent(p_workspace_id, p_parent_id);
    INSERT INTO drive_items (workspace_id, parent_id, kind, name, owner_id, created_by, updated_by, mime_type, size_bytes, origin)
    VALUES (p_workspace_id, p_parent_id, 'file', v_name, v_uid, v_uid, v_uid, p_mime_type, p_size_bytes, 'upload')
    RETURNING * INTO v_item;
    v_version_no := 1;
  ELSE
    SELECT * INTO v_item FROM drive_items WHERE id = p_item_id AND workspace_id = p_workspace_id;
    IF v_item.id IS NULL OR v_item.kind <> 'file' OR NOT drive_can_edit(p_item_id, v_uid) THEN
      RAISE EXCEPTION 'You need edit access to upload a new version' USING ERRCODE = '42501';
    END IF;
    SELECT coalesce(max(version_no), 0) + 1 INTO v_version_no FROM drive_versions WHERE item_id = p_item_id;
  END IF;
  v_path := p_workspace_id || '/' || v_item.id || '/' || v_version_id || '/' ||
            left(regexp_replace(v_name, '[^A-Za-z0-9._-]+', '_', 'g'), 120);
  INSERT INTO drive_versions (id, item_id, workspace_id, version_no, storage_bucket, storage_path, original_name,
                              mime_type, size_bytes, status, source, created_by)
  VALUES (v_version_id, v_item.id, p_workspace_id, v_version_no, 'drive', v_path, v_name,
          coalesce(nullif(p_mime_type, ''), 'application/octet-stream'), p_size_bytes, 'pending', 'upload', v_uid);
  RETURN jsonb_build_object('item_id', v_item.id, 'version_id', v_version_id, 'bucket', 'drive', 'path', v_path,
                            'version_no', v_version_no);
END $$;

CREATE OR REPLACE FUNCTION public.drive_finalize_upload(p_version_id uuid)
RETURNS drive_items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_version drive_versions%ROWTYPE; v_object storage.objects%ROWTYPE; v_item drive_items%ROWTYPE; v_size bigint; v_mime text;
BEGIN
  SELECT * INTO v_version FROM drive_versions WHERE id = p_version_id FOR UPDATE;
  IF v_version.id IS NULL OR v_version.created_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Upload not found' USING ERRCODE = '42501';
  END IF;
  IF v_version.status = 'ready' THEN
    SELECT * INTO v_item FROM drive_items WHERE id = v_version.item_id;
    RETURN v_item;
  END IF;
  IF v_version.status <> 'pending' THEN RAISE EXCEPTION 'This upload was cancelled' USING ERRCODE = '22023'; END IF;
  PERFORM drive_require_member(v_version.workspace_id);
  SELECT * INTO v_object FROM storage.objects WHERE bucket_id = 'drive' AND name = v_version.storage_path;
  IF v_object.id IS NULL THEN RAISE EXCEPTION 'The file has not finished uploading' USING ERRCODE = '22023'; END IF;
  v_size := coalesce((v_object.metadata ->> 'size')::bigint, v_version.size_bytes);
  v_mime := coalesce(nullif(v_object.metadata ->> 'mimetype', ''), v_version.mime_type);
  UPDATE drive_versions SET status = 'ready', finalized_at = now(), size_bytes = v_size, mime_type = v_mime
  WHERE id = p_version_id;
  UPDATE drive_items SET current_version_id = p_version_id, size_bytes = v_size, mime_type = v_mime,
    updated_at = now(), updated_by = auth.uid()
  WHERE id = v_version.item_id
  RETURNING * INTO v_item;
  PERFORM knowledge_enqueue_source(v_item.id, p_version_id, NULL);
  RETURN v_item;
END $$;

CREATE OR REPLACE FUNCTION public.drive_cancel_upload(p_version_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_version drive_versions%ROWTYPE;
BEGIN
  SELECT * INTO v_version FROM drive_versions WHERE id = p_version_id AND created_by = auth.uid() AND status = 'pending' FOR UPDATE;
  IF v_version.id IS NULL THEN RETURN; END IF;
  UPDATE drive_versions SET status = 'abandoned' WHERE id = p_version_id;
  -- An item that never had a finished version disappears with its upload.
  DELETE FROM drive_items i WHERE i.id = v_version.item_id AND i.current_version_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM drive_versions v WHERE v.item_id = i.id AND v.status = 'ready');
  PERFORM enqueue_job('drive.gc_object', v_version.workspace_id, NULL,
    jsonb_build_object('bucket', 'drive', 'path', v_version.storage_path), 'gc:' || v_version.storage_path);
END $$;

-- ---------------------------------------------------------------------------
-- Documents with optimistic concurrency
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drive_create_document(p_workspace_id uuid, p_parent_id uuid, p_title text, p_body text DEFAULT '')
RETURNS drive_items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := drive_require_member(p_workspace_id); v_item drive_items%ROWTYPE; v_rev uuid;
BEGIN
  PERFORM drive_check_parent(p_workspace_id, p_parent_id);
  INSERT INTO drive_items (workspace_id, parent_id, kind, name, owner_id, created_by, updated_by, mime_type, origin, current_revision_no)
  VALUES (p_workspace_id, p_parent_id, 'document', coalesce(nullif(drive_clean_name(p_title), ''), 'Untitled document'),
          v_uid, v_uid, v_uid, 'text/markdown', 'document', 1)
  RETURNING * INTO v_item;
  INSERT INTO drive_document_revisions (item_id, workspace_id, revision_no, title, body, created_by)
  VALUES (v_item.id, p_workspace_id, 1, v_item.name, coalesce(p_body, ''), v_uid)
  RETURNING id INTO v_rev;
  UPDATE drive_items SET size_bytes = octet_length(coalesce(p_body, '')) WHERE id = v_item.id RETURNING * INTO v_item;
  PERFORM knowledge_enqueue_source(v_item.id, NULL, v_rev);
  RETURN v_item;
END $$;

-- Saves a new revision when p_base_revision_no is still current; otherwise
-- returns the conflicting revision so the client can reload, merge or copy.
CREATE OR REPLACE FUNCTION public.drive_save_document(p_item_id uuid, p_base_revision_no integer, p_title text, p_body text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_item drive_items%ROWTYPE; v_latest drive_document_revisions%ROWTYPE; v_rev uuid; v_title text;
BEGIN
  SELECT * INTO v_item FROM drive_items WHERE id = p_item_id FOR UPDATE;
  IF v_item.id IS NULL OR v_item.kind <> 'document' OR NOT drive_can_edit(p_item_id, auth.uid()) THEN
    RAISE EXCEPTION 'You need edit access to this document' USING ERRCODE = '42501';
  END IF;
  IF v_item.current_revision_no <> p_base_revision_no THEN
    SELECT * INTO v_latest FROM drive_document_revisions WHERE item_id = p_item_id AND revision_no = v_item.current_revision_no;
    RETURN jsonb_build_object('status', 'conflict', 'revision_no', v_latest.revision_no, 'title', v_latest.title,
      'body', v_latest.body, 'updated_by', v_latest.created_by, 'updated_at', v_latest.created_at);
  END IF;
  v_title := coalesce(nullif(drive_clean_name(p_title), ''), v_item.name);
  INSERT INTO drive_document_revisions (item_id, workspace_id, revision_no, title, body, created_by)
  VALUES (p_item_id, v_item.workspace_id, v_item.current_revision_no + 1, v_title, coalesce(p_body, ''), auth.uid())
  RETURNING id INTO v_rev;
  UPDATE drive_items SET current_revision_no = current_revision_no + 1, name = v_title,
    size_bytes = octet_length(coalesce(p_body, '')), updated_at = now(), updated_by = auth.uid()
  WHERE id = p_item_id;
  PERFORM knowledge_enqueue_source(p_item_id, NULL, v_rev);
  RETURN jsonb_build_object('status', 'saved', 'revision_no', v_item.current_revision_no + 1, 'revision_id', v_rev);
END $$;

-- ---------------------------------------------------------------------------
-- Organizing: rename, move (with cycle and tenant checks), trash, restore.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drive_rename(p_item_id uuid, p_name text)
RETURNS drive_items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_item drive_items%ROWTYPE; v_name text := drive_clean_name(p_name);
BEGIN
  IF v_name = '' THEN RAISE EXCEPTION 'A name is required' USING ERRCODE = '22023'; END IF;
  IF NOT drive_can_edit(p_item_id, auth.uid()) THEN RAISE EXCEPTION 'You need edit access' USING ERRCODE = '42501'; END IF;
  UPDATE drive_items SET name = v_name, updated_at = now(), updated_by = auth.uid() WHERE id = p_item_id RETURNING * INTO v_item;
  RETURN v_item;
END $$;

CREATE OR REPLACE FUNCTION public.drive_is_descendant(p_item_id uuid, p_candidate_ancestor uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  WITH RECURSIVE up AS (
    SELECT id, parent_id, 0 AS depth FROM drive_items WHERE id = p_item_id
    UNION ALL
    SELECT p.id, p.parent_id, u.depth + 1 FROM drive_items p JOIN up u ON p.id = u.parent_id WHERE u.depth < 100
  ) SELECT EXISTS (SELECT 1 FROM up WHERE id = p_candidate_ancestor);
$$;

-- Principals that can view an item (for move/share previews), as
-- (principal_type, principal_id, role, via_item_id).
CREATE OR REPLACE FUNCTION public.drive_effective_grants(p_item_id uuid, p_parent_override uuid DEFAULT NULL, p_use_override boolean DEFAULT false)
RETURNS TABLE(principal_type text, principal_id uuid, role text, via_item_id uuid, inherited boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  WITH RECURSIVE chain AS (
    SELECT i.id, CASE WHEN p_use_override THEN p_parent_override ELSE i.parent_id END AS parent_id,
           i.inherit_permissions, i.owner_id, 0 AS depth
    FROM drive_items i WHERE i.id = p_item_id
    UNION ALL
    SELECT p.id, p.parent_id, p.inherit_permissions, p.owner_id, c.depth + 1
    FROM drive_items p JOIN chain c ON p.id = c.parent_id
    WHERE c.inherit_permissions AND c.depth < 50
  )
  SELECT 'user', c.owner_id, CASE WHEN c.depth = 0 THEN 'owner' ELSE 'editor' END, c.id, c.depth > 0 FROM chain c
  UNION ALL
  SELECT g.principal_type, coalesce(g.user_id, g.channel_id, g.project_id, g.workspace_id), g.role, g.item_id, c.depth > 0
  FROM drive_grants g JOIN chain c ON c.id = g.item_id;
$$;

CREATE OR REPLACE FUNCTION public.drive_preview_move(p_item_id uuid, p_new_parent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  IF NOT drive_can_edit(p_item_id, auth.uid()) THEN RAISE EXCEPTION 'You need edit access' USING ERRCODE = '42501'; END IF;
  SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('type', principal_type, 'id', principal_id)), '[]') INTO v_before
  FROM drive_effective_grants(p_item_id);
  SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('type', principal_type, 'id', principal_id)), '[]') INTO v_after
  FROM drive_effective_grants(p_item_id, p_new_parent_id, true);
  RETURN jsonb_build_object(
    'gains', (SELECT coalesce(jsonb_agg(x), '[]') FROM jsonb_array_elements(v_after) x WHERE NOT v_before @> jsonb_build_array(x)),
    'losses', (SELECT coalesce(jsonb_agg(x), '[]') FROM jsonb_array_elements(v_before) x WHERE NOT v_after @> jsonb_build_array(x))
  );
END $$;

CREATE OR REPLACE FUNCTION public.drive_move(p_item_id uuid, p_new_parent_id uuid)
RETURNS drive_items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_item drive_items%ROWTYPE;
BEGIN
  SELECT * INTO v_item FROM drive_items WHERE id = p_item_id FOR UPDATE;
  IF v_item.id IS NULL OR NOT drive_can_edit(p_item_id, auth.uid()) THEN
    RAISE EXCEPTION 'You need edit access to move this item' USING ERRCODE = '42501';
  END IF;
  IF p_new_parent_id IS NULL THEN
    IF v_item.owner_id <> auth.uid() THEN
      RAISE EXCEPTION 'Only the owner can move an item to the top level' USING ERRCODE = '42501';
    END IF;
  ELSE
    PERFORM drive_check_parent(v_item.workspace_id, p_new_parent_id);
    IF p_new_parent_id = p_item_id OR drive_is_descendant(p_new_parent_id, p_item_id) THEN
      RAISE EXCEPTION 'A folder cannot be moved into itself' USING ERRCODE = '22023';
    END IF;
  END IF;
  UPDATE drive_items SET parent_id = p_new_parent_id, updated_at = now(), updated_by = auth.uid()
  WHERE id = p_item_id RETURNING * INTO v_item;
  PERFORM drive_audit(v_item.workspace_id, 'drive_item_moved', p_item_id, jsonb_build_object('parent_id', p_new_parent_id));
  RETURN v_item;
END $$;

CREATE OR REPLACE FUNCTION public.drive_trash(p_item_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_item drive_items%ROWTYPE;
BEGIN
  SELECT * INTO v_item FROM drive_items WHERE id = p_item_id;
  IF v_item.id IS NULL OR NOT drive_can_edit(p_item_id, auth.uid()) THEN
    RAISE EXCEPTION 'You need edit access to move this item to trash' USING ERRCODE = '42501';
  END IF;
  WITH RECURSIVE tree AS (
    SELECT id FROM drive_items WHERE id = p_item_id
    UNION ALL
    SELECT c.id FROM drive_items c JOIN tree t ON c.parent_id = t.id WHERE c.trashed_at IS NULL
  )
  UPDATE drive_items SET trashed_at = now(), trashed_by = auth.uid(), trash_root_id = p_item_id
  WHERE id IN (SELECT id FROM tree) AND trashed_at IS NULL;
  PERFORM drive_audit(v_item.workspace_id, 'drive_item_trashed', p_item_id, '{}'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.drive_restore(p_item_id uuid)
RETURNS drive_items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_item drive_items%ROWTYPE; v_parent_ok boolean;
BEGIN
  SELECT * INTO v_item FROM drive_items WHERE id = p_item_id FOR UPDATE;
  IF v_item.id IS NULL OR NOT drive_can_see_in_trash(p_item_id, auth.uid()) OR v_item.trash_root_id IS DISTINCT FROM p_item_id THEN
    RAISE EXCEPTION 'Item not found in trash' USING ERRCODE = '42501';
  END IF;
  UPDATE drive_items SET trashed_at = NULL, trashed_by = NULL, trash_root_id = NULL, updated_at = now()
  WHERE trash_root_id = p_item_id;
  -- The original folder may be trashed or inaccessible now: restore to the top level.
  SELECT v_item.parent_id IS NULL OR EXISTS (
    SELECT 1 FROM drive_items p WHERE p.id = v_item.parent_id AND p.trashed_at IS NULL AND drive_can_edit(p.id, auth.uid()))
  INTO v_parent_ok;
  IF NOT v_parent_ok THEN
    UPDATE drive_items SET parent_id = NULL WHERE id = p_item_id;
  END IF;
  SELECT * INTO v_item FROM drive_items WHERE id = p_item_id;
  PERFORM drive_audit(v_item.workspace_id, 'drive_item_restored', p_item_id, '{}'::jsonb);
  RETURN v_item;
END $$;

-- Permanent deletion is owner-only; storage objects are removed by the purge
-- job once no other version, attachment or reference uses them.
CREATE OR REPLACE FUNCTION public.drive_delete_forever(p_item_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_item drive_items%ROWTYPE;
BEGIN
  SELECT * INTO v_item FROM drive_items WHERE id = p_item_id;
  IF v_item.id IS NULL OR v_item.owner_id <> auth.uid() OR v_item.trashed_at IS NULL OR v_item.trash_root_id <> p_item_id THEN
    RAISE EXCEPTION 'Only the owner can permanently delete an item from trash' USING ERRCODE = '42501';
  END IF;
  UPDATE drive_items SET purge_requested_at = now() WHERE trash_root_id = p_item_id;
  PERFORM enqueue_job('drive.purge', v_item.workspace_id, auth.uid(), jsonb_build_object('item_id', p_item_id),
    'purge:' || p_item_id);
  PERFORM drive_audit(v_item.workspace_id, 'drive_item_purge_requested', p_item_id, '{}'::jsonb);
END $$;

-- ---------------------------------------------------------------------------
-- Sharing
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drive_share(p_item_id uuid, p_principal_type text, p_principal_id uuid, p_role text)
RETURNS drive_grants
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_item drive_items%ROWTYPE; v_grant drive_grants%ROWTYPE; v_actor text; v_channel channels%ROWTYPE;
BEGIN
  SELECT * INTO v_item FROM drive_items WHERE id = p_item_id;
  IF v_item.id IS NULL OR NOT drive_can_manage_sharing(p_item_id, auth.uid()) THEN
    RAISE EXCEPTION 'You cannot change sharing for this item' USING ERRCODE = '42501';
  END IF;
  IF p_role NOT IN ('viewer', 'commenter', 'editor') THEN RAISE EXCEPTION 'Invalid role' USING ERRCODE = '22023'; END IF;
  IF p_principal_type = 'user' THEN
    IF NOT user_is_workspace_member(v_item.workspace_id, p_principal_id) THEN
      RAISE EXCEPTION 'You can only share with members of this workspace' USING ERRCODE = '42501';
    END IF;
    IF p_principal_id = v_item.owner_id THEN RAISE EXCEPTION 'The owner already has access' USING ERRCODE = '22023'; END IF;
  ELSIF p_principal_type = 'channel' THEN
    SELECT * INTO v_channel FROM channels WHERE id = p_principal_id AND workspace_id = v_item.workspace_id;
    IF v_channel.id IS NULL OR NOT user_is_channel_member(p_principal_id, auth.uid()) THEN
      RAISE EXCEPTION 'You can only share with channels you belong to' USING ERRCODE = '42501';
    END IF;
  ELSIF p_principal_type = 'project' THEN
    IF get_project_workspace_id(p_principal_id) IS DISTINCT FROM v_item.workspace_id
       OR NOT is_project_readable(p_principal_id, auth.uid()) THEN
      RAISE EXCEPTION 'Project not found' USING ERRCODE = '42501';
    END IF;
  ELSIF p_principal_type = 'workspace' THEN
    p_principal_id := NULL;
  ELSE
    RAISE EXCEPTION 'Invalid principal' USING ERRCODE = '22023';
  END IF;

  INSERT INTO drive_grants (workspace_id, item_id, principal_type, user_id, channel_id, project_id, role, source, created_by)
  VALUES (v_item.workspace_id, p_item_id, p_principal_type,
          CASE WHEN p_principal_type = 'user' THEN p_principal_id END,
          CASE WHEN p_principal_type = 'channel' THEN p_principal_id END,
          CASE WHEN p_principal_type = 'project' THEN p_principal_id END,
          p_role, 'manual', auth.uid())
  ON CONFLICT (item_id, principal_type, coalesce(user_id, channel_id, project_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET role = EXCLUDED.role, source = 'manual', created_by = EXCLUDED.created_by
  RETURNING * INTO v_grant;

  PERFORM drive_audit(v_item.workspace_id, 'drive_shared', p_item_id,
    jsonb_build_object('principal_type', p_principal_type, 'principal_id', p_principal_id, 'role', p_role));
  IF p_principal_type = 'user' THEN
    SELECT coalesce(display_name, username, 'Someone') INTO v_actor FROM profiles WHERE id = auth.uid();
    PERFORM drive_notify(p_principal_id, v_item.workspace_id, v_actor || ' shared "' || v_item.name || '" with you',
      'You can now ' || CASE p_role WHEN 'editor' THEN 'edit' WHEN 'commenter' THEN 'comment on' ELSE 'view' END || ' it.',
      '/drive/item/' || p_item_id, p_item_id);
  END IF;
  RETURN v_grant;
END $$;

CREATE OR REPLACE FUNCTION public.drive_unshare(p_grant_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_grant drive_grants%ROWTYPE;
BEGIN
  SELECT * INTO v_grant FROM drive_grants WHERE id = p_grant_id;
  IF v_grant.id IS NULL OR NOT drive_can_manage_sharing(v_grant.item_id, auth.uid()) THEN
    RAISE EXCEPTION 'You cannot change sharing for this item' USING ERRCODE = '42501';
  END IF;
  DELETE FROM drive_grants WHERE id = p_grant_id;
  PERFORM drive_audit(v_grant.workspace_id, 'drive_unshared', v_grant.item_id,
    jsonb_build_object('principal_type', v_grant.principal_type,
                       'principal_id', coalesce(v_grant.user_id, v_grant.channel_id, v_grant.project_id), 'role', v_grant.role));
END $$;

CREATE OR REPLACE FUNCTION public.drive_set_sharing_options(p_item_id uuid, p_restricted boolean, p_editors_can_share boolean)
RETURNS drive_items
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_item drive_items%ROWTYPE;
BEGIN
  SELECT * INTO v_item FROM drive_items WHERE id = p_item_id;
  IF v_item.id IS NULL OR drive_item_role(p_item_id, auth.uid()) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the owner can change these options' USING ERRCODE = '42501';
  END IF;
  IF p_restricted IS NOT NULL AND v_item.kind <> 'folder' THEN
    RAISE EXCEPTION 'Only folders can be restricted' USING ERRCODE = '22023';
  END IF;
  UPDATE drive_items SET inherit_permissions = coalesce(NOT p_restricted, inherit_permissions),
    editors_can_share = coalesce(p_editors_can_share, editors_can_share), updated_at = now()
  WHERE id = p_item_id RETURNING * INTO v_item;
  PERFORM drive_audit(v_item.workspace_id, 'drive_sharing_options_changed', p_item_id,
    jsonb_build_object('restricted', NOT v_item.inherit_permissions, 'editors_can_share', v_item.editors_can_share));
  RETURN v_item;
END $$;

-- Sharing panel data: owner, direct and inherited grants, and audience size.
CREATE OR REPLACE FUNCTION public.drive_get_access(p_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_item drive_items%ROWTYPE; v_result jsonb;
BEGIN
  SELECT * INTO v_item FROM drive_items WHERE id = p_item_id;
  IF v_item.id IS NULL OR NOT drive_can_view(p_item_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not found' USING ERRCODE = '42501';
  END IF;
  WITH RECURSIVE chain AS (
    SELECT i.id, i.parent_id, i.inherit_permissions, i.name, 0 AS depth FROM drive_items i WHERE i.id = p_item_id
    UNION ALL
    SELECT p.id, p.parent_id, p.inherit_permissions, p.name, c.depth + 1
    FROM drive_items p JOIN chain c ON p.id = c.parent_id WHERE c.inherit_permissions AND c.depth < 50
  )
  SELECT jsonb_build_object(
    'item_id', p_item_id,
    'owner_id', v_item.owner_id,
    'restricted', NOT v_item.inherit_permissions,
    'editors_can_share', v_item.editors_can_share,
    'my_role', drive_item_role(p_item_id, auth.uid()),
    'can_manage', drive_can_manage_sharing(p_item_id, auth.uid()),
    'grants', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', g.id, 'principal_type', g.principal_type,
        'principal_id', coalesce(g.user_id, g.channel_id, g.project_id),
        'role', g.role, 'source', g.source, 'inherited', c.depth > 0, 'via_item_id', c.id, 'via_name', c.name,
        'label', CASE g.principal_type
          WHEN 'user' THEN (SELECT coalesce(pr.display_name, pr.username, pr.email) FROM profiles pr WHERE pr.id = g.user_id)
          WHEN 'channel' THEN (SELECT CASE WHEN dc.id IS NOT NULL THEN 'Direct conversation' ELSE '#' || ch.name END
                               FROM channels ch LEFT JOIN direct_conversations dc ON dc.channel_id = ch.id WHERE ch.id = g.channel_id)
          WHEN 'project' THEN (SELECT pj.name FROM projects pj WHERE pj.id = g.project_id)
          ELSE 'Everyone in the workspace' END,
        'member_count', CASE g.principal_type
          WHEN 'channel' THEN (SELECT count(*) FROM channel_members cm WHERE cm.channel_id = g.channel_id)
          WHEN 'project' THEN (SELECT count(*) FROM project_members pm WHERE pm.project_id = g.project_id)
          WHEN 'workspace' THEN (SELECT count(*) FROM workspace_members wm WHERE wm.workspace_id = v_item.workspace_id)
          ELSE 1 END
      ) ORDER BY c.depth, g.created_at)
      FROM drive_grants g JOIN chain c ON c.id = g.item_id), '[]'::jsonb),
    'audience_count', (SELECT count(*) FROM workspace_members wm
                       WHERE wm.workspace_id = v_item.workspace_id AND drive_viewable_by(p_item_id, wm.user_id))
  ) INTO v_result;
  RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- Access requests (no title or snippet is revealed to the requester)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drive_request_access(p_item_id uuid, p_role text DEFAULT 'viewer', p_message text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_item drive_items%ROWTYPE; v_req uuid; v_name text; v_manager uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_item FROM drive_items WHERE id = p_item_id;
  -- Same response whether or not the item exists or is in another workspace.
  IF v_item.id IS NULL OR v_item.trashed_at IS NOT NULL OR NOT user_is_workspace_member(v_item.workspace_id, auth.uid()) THEN
    RETURN jsonb_build_object('status', 'submitted');
  END IF;
  IF drive_can_view(p_item_id, auth.uid()) THEN RETURN jsonb_build_object('status', 'has_access'); END IF;
  INSERT INTO drive_access_requests (workspace_id, item_id, requester_id, role, message)
  VALUES (v_item.workspace_id, p_item_id, auth.uid(),
          CASE WHEN p_role IN ('viewer', 'commenter', 'editor') THEN p_role ELSE 'viewer' END, left(p_message, 1000))
  ON CONFLICT (item_id, requester_id) WHERE status = 'pending' DO UPDATE SET message = EXCLUDED.message, created_at = now()
  RETURNING id INTO v_req;
  SELECT coalesce(display_name, username, 'Someone') INTO v_name FROM profiles WHERE id = auth.uid();
  FOR v_manager IN
    SELECT v_item.owner_id
    UNION
    SELECT g.user_id FROM drive_grants g
    WHERE g.item_id = p_item_id AND g.principal_type = 'user' AND g.role = 'editor' AND v_item.editors_can_share
  LOOP
    IF user_is_workspace_member(v_item.workspace_id, v_manager) THEN
      PERFORM drive_notify(v_manager, v_item.workspace_id, v_name || ' requested access to "' || v_item.name || '"',
        coalesce(nullif(p_message, ''), 'Open the sharing settings to approve or decline.'),
        '/drive/item/' || p_item_id || '?panel=sharing', p_item_id, 'access_request');
    END IF;
  END LOOP;
  RETURN jsonb_build_object('status', 'submitted');
END $$;

CREATE OR REPLACE FUNCTION public.drive_decide_access_request(p_request_id uuid, p_approve boolean, p_role text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_req drive_access_requests%ROWTYPE; v_item drive_items%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM drive_access_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL OR v_req.status <> 'pending' OR NOT drive_can_manage_sharing(v_req.item_id, auth.uid()) THEN
    RAISE EXCEPTION 'Request not found' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_item FROM drive_items WHERE id = v_req.item_id;
  UPDATE drive_access_requests SET status = CASE WHEN p_approve THEN 'approved' ELSE 'denied' END,
    decided_by = auth.uid(), decided_at = now() WHERE id = p_request_id;
  IF p_approve THEN
    IF NOT user_is_workspace_member(v_req.workspace_id, v_req.requester_id) THEN
      RAISE EXCEPTION 'The requester is no longer a workspace member' USING ERRCODE = '42501';
    END IF;
    INSERT INTO drive_grants (workspace_id, item_id, principal_type, user_id, role, source, created_by)
    VALUES (v_req.workspace_id, v_req.item_id, 'user', v_req.requester_id, coalesce(p_role, v_req.role), 'access_request', auth.uid())
    ON CONFLICT (item_id, principal_type, coalesce(user_id, channel_id, project_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET role = EXCLUDED.role;
    PERFORM drive_audit(v_req.workspace_id, 'drive_access_request_approved', v_req.item_id,
      jsonb_build_object('requester_id', v_req.requester_id, 'role', coalesce(p_role, v_req.role)));
    PERFORM drive_notify(v_req.requester_id, v_req.workspace_id, 'Access granted to "' || v_item.name || '"',
      'Your request was approved.', '/drive/item/' || v_req.item_id, v_req.item_id);
  ELSE
    PERFORM drive_notify(v_req.requester_id, v_req.workspace_id, 'Access request declined',
      'The owner declined your request.', NULL, NULL);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Comments, stars, recents
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drive_add_comment(p_item_id uuid, p_body text, p_parent_id uuid DEFAULT NULL)
RETURNS drive_comments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_item drive_items%ROWTYPE; v_comment drive_comments%ROWTYPE; v_name text;
BEGIN
  SELECT * INTO v_item FROM drive_items WHERE id = p_item_id;
  IF v_item.id IS NULL OR NOT drive_can_comment(p_item_id, auth.uid()) THEN
    RAISE EXCEPTION 'You need comment access' USING ERRCODE = '42501';
  END IF;
  IF p_parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM drive_comments WHERE id = p_parent_id AND item_id = p_item_id) THEN
    RAISE EXCEPTION 'Reply target not found' USING ERRCODE = '22023';
  END IF;
  INSERT INTO drive_comments (workspace_id, item_id, version_id, revision_no, parent_id, author_id, body)
  VALUES (v_item.workspace_id, p_item_id, v_item.current_version_id,
          CASE WHEN v_item.kind = 'document' THEN v_item.current_revision_no END, p_parent_id, auth.uid(), btrim(p_body))
  RETURNING * INTO v_comment;
  SELECT coalesce(display_name, username, 'Someone') INTO v_name FROM profiles WHERE id = auth.uid();
  PERFORM drive_notify(v_item.owner_id, v_item.workspace_id, v_name || ' commented on "' || v_item.name || '"',
    left(btrim(p_body), 200), '/drive/item/' || p_item_id || '?panel=comments', p_item_id, 'comment');
  RETURN v_comment;
END $$;

CREATE OR REPLACE FUNCTION public.drive_delete_comment(p_comment_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  UPDATE drive_comments SET deleted_at = now(), body = '[deleted]'
  WHERE id = p_comment_id AND (author_id = auth.uid() OR drive_item_role(item_id, auth.uid()) = 'owner');
$$;

CREATE OR REPLACE FUNCTION public.drive_toggle_star(p_item_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_ws uuid;
BEGIN
  IF NOT drive_can_view(p_item_id, auth.uid()) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM drive_item_stars WHERE user_id = auth.uid() AND item_id = p_item_id) THEN
    DELETE FROM drive_item_stars WHERE user_id = auth.uid() AND item_id = p_item_id;
    RETURN false;
  END IF;
  SELECT workspace_id INTO v_ws FROM drive_items WHERE id = p_item_id;
  INSERT INTO drive_item_stars (user_id, item_id, workspace_id) VALUES (auth.uid(), p_item_id, v_ws);
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.drive_record_view(p_item_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT drive_can_view(p_item_id, auth.uid()) THEN RETURN; END IF;
  INSERT INTO drive_item_views (user_id, item_id, workspace_id)
  SELECT auth.uid(), id, workspace_id FROM drive_items WHERE id = p_item_id
  ON CONFLICT (user_id, item_id) DO UPDATE SET viewed_at = now();
END $$;

-- ---------------------------------------------------------------------------
-- Listing. Runs with the caller's rights: RLS decides visibility.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drive_list(
  p_workspace_id uuid, p_view text DEFAULT 'my', p_folder_id uuid DEFAULT NULL, p_search text DEFAULT NULL,
  p_sort text DEFAULT 'name', p_desc boolean DEFAULT false, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0,
  p_channel_id uuid DEFAULT NULL
) RETURNS TABLE(id uuid, kind text, name text, mime_type text, size_bytes bigint, owner_id uuid, owner_name text,
  parent_id uuid, origin text, created_at timestamptz, updated_at timestamptz, trashed_at timestamptz,
  current_version_id uuid, current_revision_no integer, my_role text, starred boolean, total_count bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, extensions, pg_temp AS $$
  WITH base AS (
    SELECT i.* FROM drive_items i
    WHERE i.workspace_id = p_workspace_id
      AND (i.kind <> 'file' OR i.current_version_id IS NOT NULL)
      AND CASE p_view
        WHEN 'trash' THEN i.trashed_at IS NOT NULL AND i.trash_root_id = i.id
        ELSE i.trashed_at IS NULL END
      AND CASE p_view
        WHEN 'folder' THEN i.parent_id = p_folder_id
        WHEN 'my' THEN i.owner_id = auth.uid() AND i.parent_id IS NULL
        WHEN 'shared' THEN i.owner_id <> auth.uid() AND EXISTS (
          SELECT 1 FROM drive_grants g WHERE g.item_id = i.id AND (
            (g.principal_type = 'user' AND g.user_id = auth.uid())
            OR (g.principal_type = 'channel' AND user_is_channel_member(g.channel_id, auth.uid()))
            OR (g.principal_type = 'project' AND (is_project_member(g.project_id, auth.uid()) OR is_project_owner(g.project_id, auth.uid())))))
        WHEN 'workspace' THEN EXISTS (SELECT 1 FROM drive_grants g WHERE g.item_id = i.id AND g.principal_type = 'workspace')
          AND NOT EXISTS (SELECT 1 FROM drive_grants pg JOIN drive_items par ON par.id = pg.item_id
                          WHERE par.id = i.parent_id AND pg.principal_type = 'workspace' AND i.inherit_permissions)
        WHEN 'recent' THEN EXISTS (SELECT 1 FROM drive_item_views v WHERE v.item_id = i.id AND v.user_id = auth.uid())
          OR (i.updated_by = auth.uid() AND i.updated_at > now() - interval '30 days')
        WHEN 'starred' THEN EXISTS (SELECT 1 FROM drive_item_stars s WHERE s.item_id = i.id AND s.user_id = auth.uid())
        WHEN 'channel' THEN EXISTS (SELECT 1 FROM drive_grants g WHERE g.item_id = i.id AND g.channel_id = p_channel_id)
          OR EXISTS (SELECT 1 FROM message_resources mr JOIN messages m ON m.id = mr.message_id
                     WHERE mr.item_id = i.id AND m.channel_id = p_channel_id AND m.deleted_at IS NULL)
        WHEN 'search' THEN true
        WHEN 'all' THEN true
        ELSE false END
      AND (p_search IS NULL OR p_search = '' OR lower(i.name) LIKE '%' || lower(p_search) || '%')
  )
  SELECT b.id, b.kind, b.name, b.mime_type, b.size_bytes, b.owner_id,
    coalesce(pr.display_name, pr.username, pr.email), b.parent_id, b.origin, b.created_at, b.updated_at, b.trashed_at,
    b.current_version_id, b.current_revision_no,
    CASE WHEN b.trashed_at IS NULL THEN drive_item_role(b.id, auth.uid()) END,
    EXISTS (SELECT 1 FROM drive_item_stars s WHERE s.item_id = b.id AND s.user_id = auth.uid()),
    count(*) OVER ()
  FROM base b LEFT JOIN profiles pr ON pr.id = b.owner_id
  ORDER BY
    CASE WHEN b.kind = 'folder' THEN 0 ELSE 1 END,
    CASE WHEN p_view = 'recent' THEN coalesce((SELECT v.viewed_at FROM drive_item_views v WHERE v.item_id = b.id AND v.user_id = auth.uid()), b.updated_at) END DESC NULLS LAST,
    CASE WHEN p_sort = 'name' AND NOT p_desc THEN lower(b.name) END ASC,
    CASE WHEN p_sort = 'name' AND p_desc THEN lower(b.name) END DESC,
    CASE WHEN p_sort = 'updated' AND NOT p_desc THEN b.updated_at END ASC,
    CASE WHEN p_sort = 'updated' AND p_desc THEN b.updated_at END DESC,
    CASE WHEN p_sort = 'size' AND NOT p_desc THEN b.size_bytes END ASC,
    CASE WHEN p_sort = 'size' AND p_desc THEN b.size_bytes END DESC,
    CASE WHEN p_sort = 'type' AND NOT p_desc THEN b.mime_type END ASC,
    CASE WHEN p_sort = 'type' AND p_desc THEN b.mime_type END DESC,
    CASE WHEN p_sort = 'owner' AND NOT p_desc THEN lower(coalesce(pr.display_name, pr.username)) END ASC,
    CASE WHEN p_sort = 'owner' AND p_desc THEN lower(coalesce(pr.display_name, pr.username)) END DESC,
    b.updated_at DESC
  LIMIT least(p_limit, 500) OFFSET greatest(p_offset, 0);
$$;

-- Breadcrumbs for a folder (only ancestors the caller can see).
CREATE OR REPLACE FUNCTION public.drive_breadcrumbs(p_item_id uuid)
RETURNS TABLE(id uuid, name text, depth integer)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, extensions, pg_temp AS $$
  WITH RECURSIVE up AS (
    SELECT i.id, i.parent_id, i.name, 0 AS depth FROM drive_items i WHERE i.id = p_item_id
    UNION ALL
    SELECT p.id, p.parent_id, p.name, u.depth + 1 FROM drive_items p JOIN up u ON p.id = u.parent_id WHERE u.depth < 50
  ) SELECT id, name, depth FROM up ORDER BY depth DESC;
$$;

-- ---------------------------------------------------------------------------
-- Messages <-> Drive
-- ---------------------------------------------------------------------------
-- Links one file_attachments row to a Drive item (creating the item for a new
-- object path), and grants the conversation viewer access. Rerunnable.
CREATE OR REPLACE FUNCTION public.drive_link_attachment(p_attachment_id uuid, p_source text DEFAULT 'message_attachment')
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_att file_attachments%ROWTYPE;
  v_msg messages%ROWTYPE;
  v_path text;
  v_item_id uuid;
  v_version_id uuid;
  v_owner uuid;
  v_status text;
BEGIN
  IF EXISTS (SELECT 1 FROM file_attachment_drive_links WHERE attachment_id = p_attachment_id) THEN
    RETURN (SELECT status FROM file_attachment_drive_links WHERE attachment_id = p_attachment_id);
  END IF;
  SELECT * INTO v_att FROM file_attachments WHERE id = p_attachment_id;
  IF v_att.id IS NULL THEN RETURN 'missing'; END IF;
  SELECT * INTO v_msg FROM messages WHERE id = v_att.message_id;

  IF v_att.file_type = 'application/x-link' OR v_att.file_url ~* '^https?://' THEN
    v_status := 'link_attachment';
  ELSIF v_att.file_url ~* '^(data|blob):' THEN
    v_status := 'local_url';
  ELSIF v_msg.workspace_id IS NULL THEN
    v_status := 'no_workspace';
  ELSE
    v_path := normalize_attachment_path(v_att.file_url);
    IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'message-attachments' AND o.name = v_path) THEN
      v_status := 'missing_object';
    ELSE
      v_status := 'linked';
    END IF;
  END IF;

  IF v_status <> 'linked' THEN
    INSERT INTO file_attachment_drive_links (attachment_id, workspace_id, status, storage_path, note)
    VALUES (p_attachment_id, v_msg.workspace_id, v_status, v_path,
            CASE v_status WHEN 'missing_object' THEN 'Storage object not found; left untouched for review' END)
    ON CONFLICT (attachment_id) DO NOTHING;
    RETURN v_status;
  END IF;

  -- One logical item per object path per workspace (forwards share it).
  SELECT v.item_id, v.id INTO v_item_id, v_version_id
  FROM drive_versions v JOIN drive_items i ON i.id = v.item_id
  WHERE v.storage_bucket = 'message-attachments' AND v.storage_path = v_path AND v.workspace_id = v_msg.workspace_id
  ORDER BY v.created_at LIMIT 1;

  IF v_item_id IS NULL THEN
    -- The earliest attachment row for the object identifies the uploader.
    SELECT fa.user_id INTO v_owner FROM file_attachments fa
    WHERE fa.file_url IN (v_path, 'message-attachments/' || v_path) ORDER BY fa.created_at, fa.id LIMIT 1;
    v_owner := coalesce(v_owner, v_att.user_id);
    INSERT INTO drive_items (workspace_id, kind, name, owner_id, created_by, updated_by, mime_type, size_bytes, origin, created_at, updated_at)
    VALUES (v_msg.workspace_id, 'file', coalesce(nullif(drive_clean_name(v_att.file_name), ''), 'Attachment'), v_owner, v_owner, v_owner,
            v_att.file_type, v_att.file_size,
            CASE WHEN p_source = 'legacy_backfill' THEN 'legacy_attachment' ELSE 'message_attachment' END,
            coalesce(v_att.created_at, now()), coalesce(v_att.created_at, now()))
    RETURNING id INTO v_item_id;
    INSERT INTO drive_versions (item_id, workspace_id, version_no, storage_bucket, storage_path, original_name, mime_type,
                                size_bytes, status, source, created_by, created_at, finalized_at)
    VALUES (v_item_id, v_msg.workspace_id, 1, 'message-attachments', v_path, coalesce(v_att.file_name, 'Attachment'),
            coalesce(nullif(v_att.file_type, ''), 'application/octet-stream'), coalesce(v_att.file_size, 0), 'ready',
            CASE WHEN p_source = 'legacy_backfill' THEN 'legacy_attachment' ELSE 'message_attachment' END,
            v_owner, coalesce(v_att.created_at, now()), coalesce(v_att.created_at, now()))
    RETURNING id INTO v_version_id;
    UPDATE drive_items SET current_version_id = v_version_id WHERE id = v_item_id;
    PERFORM knowledge_enqueue_source(v_item_id, v_version_id, NULL);
  END IF;

  -- Grant exactly the audience that could already see the attachment.
  INSERT INTO drive_grants (workspace_id, item_id, principal_type, channel_id, role, source, created_by)
  VALUES (v_msg.workspace_id, v_item_id, 'channel', v_msg.channel_id, 'viewer',
          CASE WHEN p_source = 'legacy_backfill' THEN 'legacy_backfill' ELSE 'message_attachment' END, v_att.user_id)
  ON CONFLICT (item_id, principal_type, coalesce(user_id, channel_id, project_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO NOTHING;

  INSERT INTO file_attachment_drive_links (attachment_id, workspace_id, status, item_id, version_id, storage_path)
  VALUES (p_attachment_id, v_msg.workspace_id, 'linked', v_item_id, v_version_id, v_path)
  ON CONFLICT (attachment_id) DO NOTHING;
  RETURN 'linked';
END $$;

CREATE OR REPLACE FUNCTION public.on_file_attachment_inserted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM drive_link_attachment(NEW.id, 'message_attachment');
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Linking must never block posting; the backfill job retries unlinked rows.
  RAISE WARNING 'drive_link_attachment failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_file_attachment_drive_link ON file_attachments;
CREATE TRIGGER trg_file_attachment_drive_link AFTER INSERT ON file_attachments
  FOR EACH ROW EXECUTE FUNCTION public.on_file_attachment_inserted();

-- When the last live message in a conversation that referenced an item goes
-- away, the automatic conversation grant goes with it (manual grants stay).
CREATE OR REPLACE FUNCTION public.drive_reconcile_conversation_grant(p_item_id uuid, p_channel_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  DELETE FROM drive_grants g
  WHERE g.item_id = p_item_id AND g.channel_id = p_channel_id AND g.principal_type = 'channel'
    AND g.source IN ('message_attachment', 'legacy_backfill')
    AND NOT EXISTS (
      SELECT 1 FROM file_attachment_drive_links l
      JOIN file_attachments fa ON fa.id = l.attachment_id
      JOIN messages m ON m.id = fa.message_id
      WHERE l.item_id = p_item_id AND m.channel_id = p_channel_id AND m.deleted_at IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM message_resources mr JOIN messages m ON m.id = mr.message_id
      WHERE mr.item_id = p_item_id AND m.channel_id = p_channel_id AND m.deleted_at IS NULL);
$$;

CREATE OR REPLACE FUNCTION public.on_file_attachment_deleted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_item uuid; v_channel uuid;
BEGIN
  SELECT item_id INTO v_item FROM file_attachment_drive_links WHERE attachment_id = OLD.id;
  SELECT channel_id INTO v_channel FROM messages WHERE id = OLD.message_id;
  IF v_item IS NOT NULL AND v_channel IS NOT NULL THEN
    DELETE FROM file_attachment_drive_links WHERE attachment_id = OLD.id;
    PERFORM drive_reconcile_conversation_grant(v_item, v_channel);
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS trg_file_attachment_drive_unlink ON file_attachments;
CREATE TRIGGER trg_file_attachment_drive_unlink BEFORE DELETE ON file_attachments
  FOR EACH ROW EXECUTE FUNCTION public.on_file_attachment_deleted();

CREATE OR REPLACE FUNCTION public.on_message_soft_deleted_drive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT l.item_id FROM file_attachments fa JOIN file_attachment_drive_links l ON l.attachment_id = fa.id
    WHERE fa.message_id = NEW.id AND l.item_id IS NOT NULL
    UNION
    SELECT mr.item_id FROM message_resources mr WHERE mr.message_id = NEW.id
  LOOP
    PERFORM drive_reconcile_conversation_grant(r.item_id, NEW.channel_id);
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_message_soft_deleted_drive ON messages;
CREATE TRIGGER trg_message_soft_deleted_drive AFTER UPDATE OF deleted_at ON messages
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.on_message_soft_deleted_drive();

-- Attach Drive items to a message the caller just posted. No access is granted
-- silently: when p_grant_role is given and the caller may manage sharing, the
-- conversation receives that role; otherwise members without access see a
-- restricted placeholder. Returns per-item access status.
CREATE OR REPLACE FUNCTION public.drive_attach_to_message(p_message_id uuid, p_item_ids uuid[], p_grant_role text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_msg messages%ROWTYPE; v_item drive_items%ROWTYPE; v_id uuid; v_result jsonb := '[]'::jsonb; v_granted boolean; v_order integer := 0;
BEGIN
  SELECT * INTO v_msg FROM messages WHERE id = p_message_id;
  IF v_msg.id IS NULL OR v_msg.user_id <> auth.uid() OR NOT user_is_channel_member(v_msg.channel_id, auth.uid()) THEN
    RAISE EXCEPTION 'Message not found' USING ERRCODE = '42501';
  END IF;
  IF p_grant_role IS NOT NULL AND p_grant_role NOT IN ('viewer', 'commenter') THEN
    RAISE EXCEPTION 'Conversations can be granted viewer or commenter access' USING ERRCODE = '22023';
  END IF;
  FOREACH v_id IN ARRAY coalesce(p_item_ids, '{}') LOOP
    SELECT * INTO v_item FROM drive_items WHERE id = v_id;
    IF v_item.id IS NULL OR v_item.workspace_id <> v_msg.workspace_id OR NOT drive_can_view(v_id, auth.uid()) THEN
      RAISE EXCEPTION 'File not found' USING ERRCODE = '42501';
    END IF;
    v_granted := false;
    IF p_grant_role IS NOT NULL AND drive_can_manage_sharing(v_id, auth.uid()) THEN
      INSERT INTO drive_grants (workspace_id, item_id, principal_type, channel_id, role, source, created_by)
      VALUES (v_item.workspace_id, v_id, 'channel', v_msg.channel_id, p_grant_role, 'message_attachment', auth.uid())
      ON CONFLICT (item_id, principal_type, coalesce(user_id, channel_id, project_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET role = CASE WHEN drive_role_rank(EXCLUDED.role) > drive_role_rank(drive_grants.role) THEN EXCLUDED.role ELSE drive_grants.role END;
      v_granted := true;
      PERFORM drive_audit(v_item.workspace_id, 'drive_shared', v_id,
        jsonb_build_object('principal_type', 'channel', 'principal_id', v_msg.channel_id, 'role', p_grant_role, 'via', 'message'));
    END IF;
    INSERT INTO message_resources (workspace_id, message_id, item_id, version_id, sort_order, created_by)
    VALUES (v_msg.workspace_id, p_message_id, v_id, CASE WHEN v_item.kind = 'file' THEN v_item.current_version_id END, v_order, auth.uid())
    ON CONFLICT (message_id, item_id) DO NOTHING;
    v_order := v_order + 1;
    v_result := v_result || jsonb_build_object('item_id', v_id, 'granted', v_granted,
      'members_without_access', drive_channel_access_gap(v_msg.channel_id, v_id));
  END LOOP;
  RETURN v_result;
END $$;

-- Pre-send check for the composer: who in the conversation could not open these items?
CREATE OR REPLACE FUNCTION public.drive_conversation_access_check(p_channel_id uuid, p_item_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_id uuid; v_out jsonb := '[]'::jsonb;
BEGIN
  IF NOT user_is_channel_member(p_channel_id, auth.uid()) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = '42501'; END IF;
  FOREACH v_id IN ARRAY coalesce(p_item_ids, '{}') LOOP
    IF drive_can_view(v_id, auth.uid()) THEN
      v_out := v_out || jsonb_build_object('item_id', v_id, 'members_without_access', drive_channel_access_gap(p_channel_id, v_id),
        'can_grant', drive_can_manage_sharing(v_id, auth.uid()));
    END IF;
  END LOOP;
  RETURN v_out;
END $$;

-- ---------------------------------------------------------------------------
-- Grants on functions
-- ---------------------------------------------------------------------------
DO $$
DECLARE f text;
BEGIN
  -- Client RPCs
  FOREACH f IN ARRAY ARRAY[
    'public.drive_create_folder(uuid, uuid, text)',
    'public.drive_begin_upload(uuid, uuid, text, text, bigint, uuid)',
    'public.drive_finalize_upload(uuid)',
    'public.drive_cancel_upload(uuid)',
    'public.drive_create_document(uuid, uuid, text, text)',
    'public.drive_save_document(uuid, integer, text, text)',
    'public.drive_rename(uuid, text)',
    'public.drive_preview_move(uuid, uuid)',
    'public.drive_move(uuid, uuid)',
    'public.drive_trash(uuid)',
    'public.drive_restore(uuid)',
    'public.drive_delete_forever(uuid)',
    'public.drive_share(uuid, text, uuid, text)',
    'public.drive_unshare(uuid)',
    'public.drive_set_sharing_options(uuid, boolean, boolean)',
    'public.drive_get_access(uuid)',
    'public.drive_request_access(uuid, text, text)',
    'public.drive_decide_access_request(uuid, boolean, text)',
    'public.drive_add_comment(uuid, text, uuid)',
    'public.drive_delete_comment(uuid)',
    'public.drive_toggle_star(uuid)',
    'public.drive_record_view(uuid)',
    'public.drive_list(uuid, text, uuid, text, text, boolean, integer, integer, uuid)',
    'public.drive_breadcrumbs(uuid)',
    'public.drive_attach_to_message(uuid, uuid[], text)',
    'public.drive_conversation_access_check(uuid, uuid[])'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
  -- Server/trigger only
  FOREACH f IN ARRAY ARRAY[
    'public.drive_link_attachment(uuid, text)',
    'public.drive_reconcile_conversation_grant(uuid, uuid)',
    'public.knowledge_enqueue_source(uuid, uuid, uuid)',
    'public.drive_notify(uuid, uuid, text, text, text, uuid, text)',
    'public.drive_audit(uuid, text, uuid, jsonb)',
    'public.drive_effective_grants(uuid, uuid, boolean)',
    'public.drive_role_for(uuid, uuid)',
    'public.drive_viewable_by(uuid, uuid)',
    'public.drive_channel_access_gap(uuid, uuid)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

-- Predicates used by policies stay callable (they only answer for the caller's own access).
GRANT EXECUTE ON FUNCTION public.drive_item_role(uuid, uuid), public.drive_can_view(uuid, uuid),
  public.drive_can_comment(uuid, uuid), public.drive_can_edit(uuid, uuid), public.drive_can_manage_sharing(uuid, uuid),
  public.drive_can_see_in_trash(uuid, uuid), public.drive_object_readable(text, text), public.drive_upload_target_ok(text)
  TO authenticated;

SELECT public.revoke_anon_rpc_access();

DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.drive_items; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.message_resources; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';
