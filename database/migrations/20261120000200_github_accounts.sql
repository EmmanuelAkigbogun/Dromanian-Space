-- "Connected accounts": people sign in with GitHub (VS Code style) through a
-- Darkspace GitHub App, instead of pasting tokens. The app is registered once
-- per Darkspace server (one click, via GitHub's app-manifest flow); its
-- credentials and every user token are sealed by the server.

CREATE TABLE IF NOT EXISTS public.github_app_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  app_id bigint NOT NULL,
  slug text NOT NULL,
  client_id text NOT NULL,
  secrets_sealed jsonb NOT NULL,          -- client secret, private key, webhook secret
  html_url text,
  origin text NOT NULL,                   -- the Darkspace address the app redirects to
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.github_app_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.github_app_config FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.github_app_config TO service_role;

CREATE TABLE IF NOT EXISTS public.user_github_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  github_id bigint NOT NULL,
  login text NOT NULL,
  name text,
  avatar_url text,
  token_sealed jsonb NOT NULL,            -- access + refresh token, server-only
  token_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, github_id)
);
ALTER TABLE public.user_github_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_github_accounts_own_read ON public.user_github_accounts;
CREATE POLICY user_github_accounts_own_read ON public.user_github_accounts FOR SELECT TO authenticated
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS user_github_accounts_own_delete ON public.user_github_accounts;
CREATE POLICY user_github_accounts_own_delete ON public.user_github_accounts FOR DELETE TO authenticated
  USING (user_id = auth.uid());
REVOKE ALL ON public.user_github_accounts FROM anon, authenticated;
-- Never the token column.
GRANT SELECT (id, user_id, github_id, login, name, avatar_url, created_at) ON public.user_github_accounts TO authenticated;
GRANT DELETE ON public.user_github_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_github_accounts TO service_role;

-- A linked project reads GitHub through the account that created it.
ALTER TABLE public.project_github_links
  ADD COLUMN IF NOT EXISTS github_account_id uuid REFERENCES public.user_github_accounts(id) ON DELETE SET NULL;

-- Same as before, plus the account to read through.
CREATE OR REPLACE FUNCTION public.github_link_account(p_project_id uuid, p_account_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  UPDATE public.project_github_links SET github_account_id = p_account_id WHERE project_id = p_project_id;
$$;
REVOKE ALL ON FUNCTION public.github_link_account(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.github_link_account(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
