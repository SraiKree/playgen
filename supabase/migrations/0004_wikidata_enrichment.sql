-- ============================================================================
-- 0004_wikidata_enrichment.sql
-- Layer 1 enrichment source #3: Wikidata (factual structured tags).
--
-- See CLAUDE.md §2 (two-layer enrichment) and the implementation plan at
-- C:\Users\saisr\.claude\plans\we-need-to-start-jaunty-crayon.md.
--
-- This migration:
--   1. Adds external-ID + Wikidata-enrichment-status columns to public.tracks.
--   2. Adds a junction table public.track_tags_wikidata, keyed by the Wikidata
--      property that contributed the tag (genre, producer, instrument, ...).
--      That `property` column lets future playlist-generation scoring weight
--      "genre"-derived tags differently from "producer"-derived ones WITHOUT
--      ever re-querying Wikidata.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- tracks: new columns.
--   isrc                      — International Standard Recording Code from
--                               Spotify /me/tracks (external_ids.isrc).
--                               The only external-ID we can collect right now
--                               since /tracks and /artists are 403-blocked
--                               for this app (post-audio-features-deprecation).
--   musicbrainz_recording_id  — reserved for Phase 2 (MB fallback path).
--                               Ships now so Phase 2 doesn't need a migration.
--   wikidata_qid              — the Wikidata entity URI's QID suffix
--                               (e.g. "Q221037" for Bohemian Rhapsody).
--                               NULL means "no Wikidata recording matched".
--   wikidata_enriched_at      — set after the Wikidata worker has TRIED this
--                               track, EVEN ON MISS. Misses are marked so
--                               we don't re-query forever.
-- ---------------------------------------------------------------------------
alter table public.tracks
  add column isrc                       text,
  add column musicbrainz_recording_id   text,
  add column wikidata_qid               text,
  add column wikidata_enriched_at       timestamptz;


-- ---------------------------------------------------------------------------
-- Partial indexes
-- ---------------------------------------------------------------------------

-- Lookup by ISRC (used by the Wikidata worker to map spotify_ids → ISRCs).
create index tracks_isrc_idx
  on public.tracks (isrc)
  where isrc is not null;

-- "Worker queue" for the Wikidata pass: tracks that finished Last.fm
-- (enriched_at IS NOT NULL) but not Wikidata yet. Sequential pipeline
-- guarantees we never run Wikidata on a track that hasn't completed Layer 1.
create index tracks_wikidata_pending_idx
  on public.tracks (id)
  where enriched_at is not null and wikidata_enriched_at is null;

-- Backfill queue for the ISRC cron: tracks the per-user-sync didn't yet
-- backfill (rows created before this migration existed). Trimmed by the
-- predicate so the index stays small.
create index tracks_isrc_missing_idx
  on public.tracks (id)
  where isrc is null;


-- ---------------------------------------------------------------------------
-- wikidata_property: enum of the Wikidata properties we currently extract.
-- Adding a new property in the future = `alter type ... add value '...';`
-- (safe; values are append-only in pg14+).
-- ---------------------------------------------------------------------------
create type public.wikidata_property as enum (
  'genre',           -- wdt:P136
  'instrument',      -- wdt:P870
  'language',        -- wdt:P407
  'country',         -- wdt:P495
  'producer',        -- wdt:P162
  'record_label',    -- wdt:P264
  'part_of_series'   -- wdt:P179
);


-- ---------------------------------------------------------------------------
-- track_tags_wikidata: Layer 1 frozen Wikidata tag snapshot.
-- Mirrors track_tags_lastfm but the per-relation metadata is `property` (the
-- Wikidata property that contributed this tag) rather than a count score.
--
-- PK includes `property` so the same tag can attach to the same track from
-- two different properties (e.g. "english" as both language and country),
-- which is rare but legitimate.
-- ---------------------------------------------------------------------------
create table public.track_tags_wikidata (
  track_id  bigint                    not null references public.tracks(id) on delete cascade,
  tag_id    bigint                    not null references public.tags(id)   on delete cascade,
  property  public.wikidata_property  not null,
  primary key (track_id, tag_id, property)
);

create index track_tags_wikidata_tag_id_idx on public.track_tags_wikidata (tag_id);


-- ---------------------------------------------------------------------------
-- RLS: same posture as track_tags_lastfm. Authenticated users read; writes
-- happen via service-role from the Inngest worker (service-role bypasses RLS).
-- ---------------------------------------------------------------------------
alter table public.track_tags_wikidata enable row level security;
alter table public.track_tags_wikidata force  row level security;
create policy track_tags_wikidata_select_all on public.track_tags_wikidata
  for select to authenticated using (true);
