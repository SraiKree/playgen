-- ============================================================================
-- 0013_musicbrainz_checked_marker.sql
-- Unstall the ISRC backfill + open the Wikidata-by-MBID path.
--
-- Problem: library-backfill-isrc queued tracks via `isrc IS NULL`. When
-- MusicBrainz returned an MBID but no ISRC (or a not-found), the row stayed
-- isrc-NULL and was re-fetched every tick — the queue never drained, and the
-- Wikidata worker (ISRC-only) produced zero tags for those MBID-only tracks.
--
-- Fix: mark a track once MusicBrainz has been consulted (hit, mbid-only, or
-- miss) via musicbrainz_checked_at, and queue on `isrc IS NULL AND
-- musicbrainz_checked_at IS NULL` so checked tracks leave the queue. The
-- Wikidata worker gains a by-MBID (wdt:P4404) fallback for ISRC-less rows.
--
-- No data backfill needed: the ~59 existing MBID-only tracks have
-- musicbrainz_checked_at IS NULL, so they re-enter the queue once, get
-- stamped, and (carrying an MBID) flow into the new by-MBID Wikidata path.
-- ============================================================================

alter table public.tracks add column musicbrainz_checked_at timestamptz;

-- New backfill queue: tracks MusicBrainz hasn't been asked about yet.
create index tracks_mb_unchecked_idx
  on public.tracks (id)
  where isrc is null and musicbrainz_checked_at is null;

-- Superseded by the predicate above (mbid-only rows must NOT stay queued).
drop index if exists public.tracks_isrc_missing_idx;
