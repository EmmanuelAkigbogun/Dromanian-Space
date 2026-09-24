-- ============================================================================
-- RESET DATABASE (fresh schema) — run this in the Supabase SQL editor
-- ----------------------------------------------------------------------------
-- Wipes EVERYTHING in the public schema (tables, functions, views, triggers,
-- RLS, policies) and recreates it, restoring grants so the app keeps working.
--
-- NOTE:
--   * auth.users are KEPT (accounts/sessions survive). Profiles are wiped and
--     re-created for new sign-ups.
--   * After this, re-apply migrations in order: 000 -> 051.
--   * Then pick ONE:
--       - run 052_profile_backfill.sql so surviving accounts get profiles
--         back (otherwise profile lookups return 406), OR
--       - run reset/delete_all_users.sql for a true full reset — everyone
--         signs up fresh and the trigger creates profiles automatically.
-- ============================================================================

-- Drop and recreate the schema (removes ALL objects: tables, functions, views, etc.)
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

-- Revoke everything a fresh schema might still have by default
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM anon;
REVOKE ALL ON SCHEMA public FROM authenticated;
REVOKE ALL ON SCHEMA public FROM service_role;

-- Also clear any default privileges left over from before, so nothing carries forward
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, PUBLIC;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;

-- Auto-grant to tables/sequences/functions the migrations create afterward
-- (the GRANT ... ON ALL ... above only hits objects that exist right now).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
