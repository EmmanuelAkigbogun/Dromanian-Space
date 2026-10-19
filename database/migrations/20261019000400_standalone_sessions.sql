-- Sessions owned by the Dromanian Node API. Raw session and recovery tokens
-- are never stored; only SHA-256 digests are persisted.

ALTER TABLE auth.sessions
  ADD COLUMN IF NOT EXISTS token_hash text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS user_agent text;

CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_token_hash_idx
  ON auth.sessions (token_hash)
  WHERE token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS auth_sessions_active_user_idx
  ON auth.sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth.password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_active_user_idx
  ON auth.password_reset_tokens (user_id, expires_at)
  WHERE used_at IS NULL;

REVOKE ALL ON auth.sessions, auth.refresh_tokens, auth.password_reset_tokens
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON auth.sessions, auth.refresh_tokens, auth.password_reset_tokens
  TO service_role;

