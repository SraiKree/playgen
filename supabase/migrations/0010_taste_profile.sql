-- ============================================================================
-- 0010_taste_profile.sql
-- Read-only aggregation functions powering the /profile "taste profile".
--
-- All are SECURITY INVOKER (run as the calling user) + STABLE, so existing RLS
-- does the access control: user_library is owner-scoped (user can only read
-- their own rows), and tracks/artists/tags/track_tags_lastfm are select-all to
-- authenticated. Each function scopes to (select auth.uid()) so the result is
-- always "my library". Aggregating in SQL keeps payloads tiny vs. shipping the
-- whole library to the app and counting there.
--
-- search_path='' per Supabase guidance — every object is schema-qualified.
-- ============================================================================


-- Top Spotify genres across the user's saved tracks. Genres live as a text[]
-- on artists; unnest + count gives a histogram. position is ignored — a
-- track's featured artist still contributes its genres.
create or replace function public.taste_top_genres(p_limit int default 8)
returns table (genre text, cnt bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select g.genre, count(*)::bigint as cnt
  from public.user_library ul
  join public.track_artists ta on ta.track_id = ul.track_id
  join public.artists a        on a.id = ta.artist_id
  cross join lateral unnest(a.genres) as g(genre)
  where ul.user_id = (select auth.uid())
  group by g.genre
  order by cnt desc, g.genre asc
  limit greatest(p_limit, 0);
$$;


-- Top Last.fm tags (the "sonic signature"). Weight = summed lastfm_count
-- across the library, so a tag that's strong on many tracks rises highest.
create or replace function public.taste_top_tags(p_limit int default 14)
returns table (tag text, weight bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select t.name as tag, sum(ttl.lastfm_count)::bigint as weight
  from public.user_library ul
  join public.track_tags_lastfm ttl on ttl.track_id = ul.track_id
  join public.tags t                 on t.id = ttl.tag_id
  where ul.user_id = (select auth.uid())
  group by t.name
  order by weight desc, t.name asc
  limit greatest(p_limit, 0);
$$;


-- Release-decade distribution. Tracks without a release_date are excluded.
create or replace function public.taste_decades()
returns table (decade int, cnt bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select (extract(year from tr.release_date)::int / 10) * 10 as decade,
         count(*)::bigint as cnt
  from public.user_library ul
  join public.tracks tr on tr.id = ul.track_id
  where ul.user_id = (select auth.uid())
    and tr.release_date is not null
  group by 1
  order by 1 asc;
$$;


-- Single-row library overview: size, distinct artists, average Spotify
-- popularity (0–100, the mainstream↔underground axis), total runtime.
create or replace function public.taste_overview()
returns table (
  track_count        bigint,
  artist_count       bigint,
  avg_popularity     numeric,
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
    coalesce(round(avg(tr.popularity)), 0)::numeric                      as avg_popularity,
    coalesce(sum(tr.duration_ms), 0)::bigint                             as total_duration_ms
  from public.user_library ul
  join public.tracks tr on tr.id = ul.track_id
  where ul.user_id = (select auth.uid());
$$;


-- XP standing: total, plus the author/voter split from the ledger and how
-- many ledger events fed each. profiles.xp is the cached total; we recompute
-- the split here so the page can narrate "earned X as an author".
create or replace function public.xp_breakdown()
returns table (
  total          integer,
  as_author      bigint,
  as_voter       bigint,
  author_events  bigint,
  voter_events   bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    coalesce((select p.xp from public.profiles p
               where p.id = (select auth.uid())), 0)                     as total,
    coalesce(sum(e.amount) filter (where e.source_type = 'tag_vote_author'), 0)::bigint as as_author,
    coalesce(sum(e.amount) filter (where e.source_type = 'tag_vote_voter'),  0)::bigint as as_voter,
    count(*) filter (where e.source_type = 'tag_vote_author')::bigint    as author_events,
    count(*) filter (where e.source_type = 'tag_vote_voter')::bigint     as voter_events
  from public.xp_events e
  where e.user_id = (select auth.uid());
$$;


-- Tagging contribution: how many community tags the user has authored (not
-- soft-hidden), and how many have graduated past the score≥2 threshold.
create or replace function public.tagging_contribution()
returns table (submitted bigint, graduated bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    count(*)::bigint                                  as submitted,
    count(*) filter (where s.score >= 2)::bigint      as graduated
  from public.user_tag_scores s
  where s.submitted_by = (select auth.uid())
    and s.hidden = false;
$$;


-- ============================================================================
-- Lockdown: these read auth.uid() data, so keep them off anon/public and
-- grant only to authenticated. Mirrors the 0002 definer-revoke pattern.
-- ============================================================================
revoke execute on function public.taste_top_genres(int)    from public, anon;
revoke execute on function public.taste_top_tags(int)       from public, anon;
revoke execute on function public.taste_decades()           from public, anon;
revoke execute on function public.taste_overview()          from public, anon;
revoke execute on function public.xp_breakdown()            from public, anon;
revoke execute on function public.tagging_contribution()    from public, anon;

grant execute on function public.taste_top_genres(int)    to authenticated;
grant execute on function public.taste_top_tags(int)       to authenticated;
grant execute on function public.taste_decades()           to authenticated;
grant execute on function public.taste_overview()          to authenticated;
grant execute on function public.xp_breakdown()            to authenticated;
grant execute on function public.tagging_contribution()    to authenticated;
