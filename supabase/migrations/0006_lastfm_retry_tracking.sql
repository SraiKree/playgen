-- ============================================================================
-- 0006_lastfm_retry_tracking.sql
-- Layer 1 fix: track Last.fm enrichment attempts so transient failures don't
-- silently stamp tracks with zero tags.
--
-- BEFORE this migration:
--   lib/inngest/functions/track-enrich.js caught Last.fm errors INSIDE a
--   step.run callback, returned a sentinel { __error, tags: [] }, and the
--   worker stamped enriched_at anyway. A track that hit a transient Last.fm
--   500 became permanently indistinguishable from a track that legitimately
--   had no Last.fm tags. No retry path, no audit trail.
--
-- AFTER this migration:
--   * On failure  -> lastfm_attempt_count++, lastfm_last_error set,
--                    enriched_at unchanged (track stays in tracks_unenriched_idx).
--   * On success  -> enriched_at stamped, lastfm_last_error cleared.
--   * On give-up  -> enriched_at stamped AND lastfm_last_error RETAINED, so
--                    the track exits the worker queue but its failure state is
--                    auditable. Give-up is triggered when attempt_count >= the
--                    application-level MAX_LASTFM_ATTEMPTS (see track-enrich.js).
--
-- Disambiguation:
--   enriched_at NULL                                        -> pending or retrying
--   enriched_at NOT NULL  AND  lastfm_last_error NULL       -> succeeded
--   enriched_at NOT NULL  AND  lastfm_last_error NOT NULL   -> gave up
--
-- Forward-only fix per design decision: existing rows where enriched_at is
-- already stamped (some of which may be silent failures from before this
-- migration) are NOT modified. They look like legitimate "no tags" results
-- and the distinction is permanently lost. Accept that and move on.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- New columns on tracks. `if not exists` lets this re-run idempotently in
-- staging if someone applied an earlier draft.
-- ---------------------------------------------------------------------------
alter table public.tracks
    add column if not exists lastfm_attempt_count   smallint    not null default 0,
    add column if not exists lastfm_last_error      text,
    add column if not exists lastfm_last_attempt_at timestamptz;


-- ---------------------------------------------------------------------------
-- record_lastfm_failure
-- Atomic UPDATE ... RETURNING for the failure-recording path. Returns the new
-- attempt count so the worker can decide whether to retry (count < MAX) or
-- give up (count >= MAX) without a follow-up SELECT.
--
-- security definer + locked search_path so the function can write into
-- public.tracks regardless of caller role. Direct execute permission is
-- revoked from public/anon/authenticated — only service_role (Inngest) calls
-- this via RPC.
-- ---------------------------------------------------------------------------
create or replace function public.record_lastfm_failure(
    p_spotify_id     text,
    p_error_message  text
)
returns smallint
language plpgsql
security definer
set search_path = ''
as $$
declare
    new_count smallint;
begin
    update public.tracks
       set lastfm_attempt_count   = lastfm_attempt_count + 1,
           lastfm_last_error      = p_error_message,
           lastfm_last_attempt_at = now()
     where spotify_id = p_spotify_id
    returning lastfm_attempt_count into new_count;

    -- coalesce so a missing-row case (shouldn't happen — the worker only
    -- records failures for tracks it just SELECTed) returns 0 instead of NULL.
    -- A NULL return would crash the JS caller's numeric comparison silently.
    return coalesce(new_count, 0);
end;
$$;

revoke execute on function public.record_lastfm_failure(text, text) from public;
revoke execute on function public.record_lastfm_failure(text, text) from anon;
revoke execute on function public.record_lastfm_failure(text, text) from authenticated;
