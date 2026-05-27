-- ============================================================================
-- 0015_track_tags_external.sql
-- Layer 1 track-level genre sources from streaming catalogs: Deezer + iTunes.
--
-- Why a single generalized table (vs. track_tags_lastfm / track_tags_wikidata's
-- one-table-per-source pattern): these are both "a coarse genre for this track
-- from a streaming catalog", distinguished only by provenance. A `source`
-- discriminator keeps adding the next such source (e.g. another catalog) a
-- one-line CHECK change instead of a new table + new consumer branch.
--
-- Matching (see lib/deezer.js / lib/itunes.js):
--   * Deezer  — ISRC-exact when an ISRC exists (none in our catalog yet, so this
--               is future-proofing), else a fuzzy artist+track search fallback.
--   * iTunes  — fuzzy artist+track search -> primaryGenreName (no ISRC lookup).
-- Both are guarded by an artist-name match so a fuzzy hit can't attach a wrong
-- genre.
-- ============================================================================


create table public.track_tags_external (
  track_id  bigint not null references public.tracks(id) on delete cascade,
  tag_id    bigint not null references public.tags(id)   on delete cascade,
  source    text   not null check (source in ('deezer', 'itunes')),
  primary key (track_id, tag_id, source)
);

-- Reverse lookup + the consumer's "external genres for these track_ids" join.
create index track_tags_external_tag_id_idx on public.track_tags_external (tag_id);


-- Per-source "consulted" markers, mirroring tracks.wikidata_enriched_at /
-- musicbrainz_checked_at. Stamped after a lookup regardless of hit/miss so the
-- backfill queues drain and we never re-query a dead lookup.
alter table public.tracks add column deezer_checked_at timestamptz;
alter table public.tracks add column itunes_checked_at timestamptz;

create index tracks_deezer_pending_idx on public.tracks (id) where deezer_checked_at is null;
create index tracks_itunes_pending_idx on public.tracks (id) where itunes_checked_at is null;


-- RLS: read-all for authenticated; writes via service-role workers (mirror
-- track_tags_lastfm, 0001:249).
alter table public.track_tags_external enable row level security;
alter table public.track_tags_external force  row level security;
create policy track_tags_external_select_all on public.track_tags_external
  for select to authenticated using (true);
