-- ============================================================================
-- 0016_backfill_track_isrcs.sql
-- Fix: ISRCs were never populated for tracks synced before ISRC capture.
--
-- Root cause: upsertTracks (lib/library.js) uses INSERT ... ON CONFLICT DO
-- NOTHING (CLAUDE.md §4), so rows inserted before migration 0004 added the
-- isrc column keep isrc = NULL forever — re-syncing never updates them. Yet
-- Spotify's /me/tracks payload DOES carry external_ids.isrc (verified: tracks
-- synced after capture have valid ISRCs). The two attempted server-side
-- fallbacks are both dead ends for this app:
--   * Spotify /v1/tracks (app token) -> 403 (blocked post-deprecation).
--   * MusicBrainz recording search by Spotify URL -> matches spam recordings
--     whose *title* is a Spotify URL, returning junk MBIDs and zero ISRCs.
--     (That cron, library-backfill-isrc, is being retired.)
--
-- So the one real ISRC source is the sync payload. This function lets
-- library-sync backfill isrc for existing rows on every sync, filling ONLY
-- NULL values so a present isrc is never overwritten and no other column or
-- enrichment marker is touched.
--
-- Security mirrors record_lastfm_failure (0006): SECURITY DEFINER, locked
-- search_path, execute revoked from public/anon/authenticated (service-role
-- Inngest worker is the only caller).
-- ============================================================================

create or replace function public.backfill_track_isrcs(p_pairs jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    n integer;
begin
    with pairs as (
        select
            elem->>'spotify_id' as spotify_id,
            elem->>'isrc'       as isrc
        from jsonb_array_elements(p_pairs) as elem
    ),
    updated as (
        update public.tracks t
           set isrc = p.isrc
          from pairs p
         where t.spotify_id = p.spotify_id
           and t.isrc is null          -- fill only; never clobber a present value
           and p.isrc is not null
        returning t.id
    )
    select count(*) into n from updated;
    return coalesce(n, 0);
end;
$$;

revoke execute on function public.backfill_track_isrcs(jsonb) from public;
revoke execute on function public.backfill_track_isrcs(jsonb) from anon;
revoke execute on function public.backfill_track_isrcs(jsonb) from authenticated;
