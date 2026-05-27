-- ============================================================================
-- 0014_artist_tags.sql
-- Layer 1.5: the artist genre FLOOR.
--
-- The problem this solves (measured: 379 of 698 tracks — 54% — have zero seed
-- tags): Last.fm track.getTopTags is empty for most non-hit tracks, and
-- Wikidata only matches notable *recordings*. The original Layer 1 genre floor
-- was Spotify artist genres, but /artists is 403-blocked for this app, so
-- migration 0012 dropped artists.genres and nothing replaced it.
--
-- The fix (per CLAUDE.md §2 "Enrich Once, Query Infinite"): enrich each ARTIST
-- once with Last.fm artist.getTopTags, and let every track by that artist
-- inherit those genres as a lower-weighted seed tag. One API call per artist
-- rescues all of that artist's tracks.
--
-- Design mirrors track_tags_lastfm (0001:92) but keyed by artist, plus a
-- per-artist "tags fetched" marker on artists.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- artist_tags — the genre floor. One row per (artist, tag, source).
--
-- Why a `source` column (vs. a per-source table like track_tags_lastfm /
-- track_tags_wikidata): the artist floor is conceptually ONE signal ("what
-- genre is this artist") that we may later corroborate from MusicBrainz or
-- Wikidata. Keeping them in one table with a discriminator means adding a
-- source later is a one-line CHECK extension + a new fetch path, not a table
-- redesign. Today only 'lastfm' is allowed.
--
-- lastfm_count is Last.fm's raw 0–100 artist tag score (how many top taggers
-- applied it), same semantics as track_tags_lastfm.lastfm_count.
-- ---------------------------------------------------------------------------
create table public.artist_tags (
  artist_id    bigint   not null references public.artists(id) on delete cascade,
  tag_id       bigint   not null references public.tags(id)    on delete cascade,
  source       text     not null default 'lastfm' check (source in ('lastfm')),
  lastfm_count smallint not null default 0,
  primary key (artist_id, tag_id, source)
);

-- Reverse lookup (all artists carrying a given tag) + the consumer's
-- "tags for these artist_ids" join. PK already covers artist_id-first lookups.
create index artist_tags_tag_id_idx on public.artist_tags (tag_id);


-- ---------------------------------------------------------------------------
-- artists.tags_enriched_at — "the Last.fm artist pass has run for this artist".
--
-- Distinct from artists.enriched_at, which lib/library.js:upsertArtists stamps
-- on every upsert (so it means "row first seen", not "tags fetched"). The
-- artist-enrich worker sets THIS column after a fetch (hit or empty miss), so
-- a NULL value is the work-queue signal. upsertArtists never writes this
-- column, so re-syncing a user's library can't reset an artist's floor.
-- ---------------------------------------------------------------------------
alter table public.artists add column tags_enriched_at timestamptz;

-- Partial work-queue index: only artists still needing a Last.fm artist pass.
-- Tiny and self-shrinking — rows leave the index as they get enriched.
create index artists_tags_unenriched_idx
  on public.artists (id) where tags_enriched_at is null;


-- ---------------------------------------------------------------------------
-- Row Level Security — read-all for authenticated users; writes happen via the
-- service-role Inngest worker (which bypasses RLS). Mirrors track_tags_lastfm
-- (0001:249).
-- ---------------------------------------------------------------------------
alter table public.artist_tags enable row level security;
alter table public.artist_tags force  row level security;
create policy artist_tags_select_all on public.artist_tags
  for select to authenticated using (true);
