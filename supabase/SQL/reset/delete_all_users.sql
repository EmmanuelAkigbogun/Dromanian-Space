-- ============================================================================
-- DELETE ALL USERS (true full reset)
-- ----------------------------------------------------------------------------
-- Run AFTER reset.sql, INSTEAD of the 052 profile backfill. reset.sql keeps
-- auth.users (sessions survive); this wipes every account so the next sign-up
-- is brand new and the on_auth_user_created trigger creates the profile
-- automatically. No backfill needed.
--
-- NOTE: all logged-in browser/app sessions become invalid immediately.
-- ============================================================================

-- Delete children before parents so no orphaned auth rows remain.
DELETE FROM auth.refresh_tokens;
DELETE FROM auth.sessions;
DELETE FROM auth.identities;

-- Cascades to public.profiles (id REFERENCES auth.users ON DELETE CASCADE)
-- and every other table referencing auth.users.
DELETE FROM auth.users;
