-- ============================================================================
-- 0008_user_library_top_tag_view.sql
-- View used by /library to paginate a user's saved tracks pre-sorted by their
-- dominant Last.fm tag. Lets the UI cluster genre-adjacent tracks together
-- across page boundaries without pulling the entire library client-side.
--
-- Implementation notes
--   * `security_invoker = true` makes the view inherit the caller's RLS. Since
--     user_library has user_library_select_own (migration 0001), only the
--     caller's own rows are visible — no cross-user leakage.
--   * The lateral subquery picks the single highest-count Last.fm tag per
--     track (ties broken by tag name, deterministic). It's index-friendly:
--     track_tags_lastfm.PK is (track_id, tag_id) so `where track_id = X` is
--     a PK-prefix scan.
--   * Tracks with no Last.fm tags yield top_lastfm_tag = NULL. Callers sort
--     these to the end with `nulls last`.
-- ============================================================================

create or replace view public.user_library_with_top_tag
with (security_invoker = true)
as
select
  ul.user_id,
  ul.track_id,
  ul.added_at,
  top_tag.tag_name        as top_lastfm_tag,
  top_tag.lastfm_count    as top_lastfm_count
from public.user_library ul
left join lateral (
  select t.name as tag_name, ttl.lastfm_count
  from public.track_tags_lastfm ttl
  join public.tags t on t.id = ttl.tag_id
  where ttl.track_id = ul.track_id
  order by ttl.lastfm_count desc, t.name asc
  limit 1
) top_tag on true;
