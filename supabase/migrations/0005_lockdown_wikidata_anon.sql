-- ============================================================================
-- 0005_lockdown_wikidata_anon.sql
-- Mirrors migration 0002 for the table added by 0004. Without this revoke,
-- pg_graphql exposes public.track_tags_wikidata to logged-out (anon) traffic
-- (flagged by mcp__supabase__get_advisors right after 0004 applied).
-- ============================================================================

revoke select on public.track_tags_wikidata from anon;
