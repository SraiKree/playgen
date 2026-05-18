-- ============================================================================
-- 0002_lockdown_anon_and_definer.sql
-- Tightens what's reachable through PostgREST / pg_graphql:
--   1. Logged-out (anon) requests should see nothing in public schema.
--      RLS doesn't help here — anon could still introspect schema and hit
--      empty tables via the auto-generated GraphQL/REST endpoints.
--      Fix: REVOKE SELECT ... FROM anon on every public table.
--   2. handle_new_user() is SECURITY DEFINER. It's meant to fire only from the
--      on_auth_user_created trigger. Without an explicit REVOKE, anon or any
--      authenticated user could call it via /rest/v1/rpc/handle_new_user.
--      Fix: REVOKE EXECUTE from public + anon + authenticated.
--
-- Flagged by mcp__supabase__get_advisors after 0001_initial_schema.
-- ============================================================================

revoke select on public.profiles          from anon;
revoke select on public.artists           from anon;
revoke select on public.tracks            from anon;
revoke select on public.track_artists     from anon;
revoke select on public.tags              from anon;
revoke select on public.track_tags_lastfm from anon;
revoke select on public.user_tags         from anon;
revoke select on public.tag_votes         from anon;
revoke select on public.user_library      from anon;
revoke select on public.user_tag_scores   from anon;

revoke execute on function public.handle_new_user() from public;
revoke execute on function public.handle_new_user() from anon;
revoke execute on function public.handle_new_user() from authenticated;
