-- ============================================================================
-- 0012_drop_genres_popularity.sql
-- Remove the Spotify-genres + track-popularity features and their columns.
--
-- Both are sourced from Spotify's /artists and /tracks endpoints, which are
-- 403-blocked for this app (post audio-features deprecation, CLAUDE.md §8).
-- So artists.genres has always been '{}' and tracks.popularity always NULL.
-- The profile sections they backed ("What you reach for", "Mainstream <->
-- Underground") rendered misleading empty/zero states, so they're removed in
-- the app; this migration drops the now-dead SQL surface + columns.
-- ============================================================================

-- The genres histogram function has no remaining caller.
drop function if exists public.taste_top_genres(int);

-- taste_overview loses its avg_popularity column. Return-type changes can't be
-- done with CREATE OR REPLACE, so drop + recreate. The remaining columns
-- (track/artist counts, total runtime) still power the profile masthead.
drop function if exists public.taste_overview();

create function public.taste_overview()
returns table (
  track_count        bigint,
  artist_count       bigint,
  total_duration_ms  bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    count(distinct ul.track_id)::bigint                                  as track_count,
    (select count(distinct ta.artist_id)
       from public.user_library u2
       join public.track_artists ta on ta.track_id = u2.track_id
      where u2.user_id = (select auth.uid()))::bigint                    as artist_count,
    coalesce(sum(tr.duration_ms), 0)::bigint                             as total_duration_ms
  from public.user_library ul
  join public.tracks tr on tr.id = ul.track_id
  where ul.user_id = (select auth.uid());
$$;

revoke execute on function public.taste_overview() from public, anon;
grant  execute on function public.taste_overview() to authenticated;

-- Drop the defunct columns. taste_overview no longer references popularity,
-- so the tracks.popularity drop is safe to run after the recreate above.
alter table public.artists drop column genres;
alter table public.artists drop column popularity;
alter table public.tracks  drop column popularity;
