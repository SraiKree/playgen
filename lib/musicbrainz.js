// Pure MusicBrainz Web API helper. No Inngest, no Next.js, no DB — same
// shape as lib/spotify.js / lib/lastfm.js / lib/wikidata.js so the
// enrichment workers can orchestrate it the same way.
//
// Why MusicBrainz? Migration 0004 added an `isrc` column to tracks. For
// rows discovered AFTER the migration, library-sync.js fills the ISRC
// directly from Spotify's /me/tracks payload (external_ids.isrc). But
// rows that existed BEFORE the migration stay at isrc=NULL — and we
// can't refetch from Spotify because /tracks is 403-blocked for this app
// (post-audio-features deprecation, see CLAUDE.md §8).
//
// MusicBrainz indexes Spotify URLs as URL relationships on recordings.
// Querying "find the recording whose URL relationship points to
// https://open.spotify.com/track/<id>" returns that recording's MBID
// AND, very often, its ISRCs. The cron at
// lib/inngest/functions/library-backfill-isrc.js uses this to backfill.
//
// Rate limit (MB, strict): 1 req/sec per IP. The cron uses step.sleep
// between calls to stay under the limit — this file is the pure layer
// and doesn't enforce it.
//
// User-Agent: MB requires a real UA with a contact path. Same string we
// use for Wikidata.
//
// Return shape (discriminated union):
//   { status: "ok",        mbid, isrc }     — recording matched; isrc may be null
//   { status: "not_found" }                  — MB has no record for this URL
//   { status: "skipped",   reason }          — bad data; caller must NOT retry
//
// Why the discriminator: previously bad data (e.g. HTTP 400, malformed
// JSON, MBID that isn't a UUID) was thrown — Inngest then retried the
// step, exhausted retries, and crashed the entire batch run. One
// poisoned row stranded the other 29 in the cron's batch for an hour.
// The "skipped" status lets the worker count + log the issue and move on
// to the next track in the same run.

const MB_ENDPOINT = "https://musicbrainz.org/ws/2/recording";
const USER_AGENT = "playgen/0.1 (https://github.com/SraiKree/playgen)";
const MB_TIMEOUT_MS = 15_000;

// Spotify track IDs are base62 (0-9 a-z A-Z), exactly 22 characters.
// We validate strictly because the id is string-interpolated into a Lucene
// query (no parameterised binds), so untrusted input must be rejected here.
const SPOTIFY_TRACK_ID_REGEX = /^[A-Za-z0-9]{22}$/;

// ISRC sanity check, same regex as lib/wikidata.js. MB sometimes returns
// non-conforming strings (data quality issue); we drop those quietly.
const ISRC_REGEX = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

// MBID format: lowercase canonical UUID v4-ish (MB doesn't strictly use v4
// but always emits 8-4-4-4-12 hex with dashes). We don't care about version
// bits — only that what we persist looks like a UUID.
const MBID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decide whether a non-2xx HTTP status from MB is worth retrying.
 *
 * Retryable (caller should throw and lean on Inngest retries):
 *   - 408 Request Timeout  (transient)
 *   - 425 Too Early        (transient)
 *   - 429 Too Many Requests (rate limit — retry after backoff)
 *   - 5xx                  (server side, transient)
 *
 * Everything else (400, 401, 403, 410, 422, …) is a deterministic rejection
 * of *this specific request*. Replaying it sends identical bytes and gets
 * the same error — we want to skip the offending track instead.
 *
 * Note: 404 is handled separately upstream as "not_found", not "skipped",
 * because MB documents 404 as the natural "no record matches" response on
 * some routes — it's a normal miss, not a data-quality issue.
 */
function isTransientHttpStatus(status) {
  if (status >= 500) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  return false;
}

/**
 * Given a Spotify track ID, ask MusicBrainz which recording (if any) is
 * linked to that Spotify URL and return its MBID + first valid ISRC.
 *
 * Returns one of:
 *   { status: "ok",        mbid, isrc }   — match; isrc may be null when MB
 *                                            knows the recording but stores
 *                                            no ISRC for it (MBID alone is
 *                                            still useful for the Wikidata
 *                                            P4404 fallback path).
 *   { status: "not_found" }                — malformed input, 404, empty
 *                                            recordings array, or top
 *                                            recording has no id field.
 *   { status: "skipped",   reason }        — bad data: 4xx (non-transient),
 *                                            malformed JSON, or the MBID
 *                                            we got back isn't a valid UUID.
 *                                            Caller logs `reason` and moves on.
 *
 * Throws on:
 *   - HTTP 5xx, 408, 425, 429 (Inngest retries)
 *   - network / DNS / TCP / timeout failures (Inngest retries)
 *
 * @param {string} spotifyId
 * @returns {Promise<
 *   | { status: "ok", mbid: string, isrc: string | null }
 *   | { status: "not_found" }
 *   | { status: "skipped", reason: string }
 * >}
 */
export async function lookupRecordingBySpotifyId(spotifyId) {
  if (typeof spotifyId !== "string" || !SPOTIFY_TRACK_ID_REGEX.test(spotifyId)) {
    // Programming error from the caller: our worker pulls spotify_ids from
    // our own DB, so anything malformed here is upstream data corruption.
    // Surface it as "skipped" so the worker logs the offending value rather
    // than silently treating it as a miss.
    return { status: "skipped", reason: "invalid_spotify_id" };
  }

  // Lucene phrase query. Special chars inside double quotes are treated
  // literally (except " and \, which a Spotify URL doesn't contain), so we
  // can interpolate safely after the regex check above.
  const luceneQuery = `url:"https://open.spotify.com/track/${spotifyId}"`;

  const url = new URL(MB_ENDPOINT);
  url.searchParams.set("query", luceneQuery);
  url.searchParams.set("fmt", "json");
  // Asking for just one is enough; if there are multiple matches we'd take
  // the first anyway, and limit=1 keeps the response small.
  url.searchParams.set("limit", "1");

  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(MB_TIMEOUT_MS),
    });
  } catch (err) {
    // Network / abort / timeout: genuinely transient. Throw so Inngest
    // retries the step on the assumption it'll succeed in a minute or two.
    throw new Error(`MusicBrainz fetch failed: ${err?.message ?? err}`);
  }

  if (res.status === 404) {
    // MB documents 404 as "not found" on some routes. Treat as a natural
    // miss — distinct from "skipped" because it isn't a data quality issue.
    return { status: "not_found" };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const snippet = body.slice(0, 500);
    if (isTransientHttpStatus(res.status)) {
      // 5xx / 408 / 425 / 429 — throw so Inngest retries.
      throw new Error(
        `MusicBrainz ${res.status} ${res.statusText}: ${snippet}`,
      );
    }
    // Non-transient 4xx (400, 401, 403, 410, 422, …): retrying sends the
    // identical request and gets the identical rejection. Skip.
    return {
      status: "skipped",
      reason: `http_${res.status}: ${snippet.slice(0, 200)}`,
    };
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    // MB responded 2xx but the body isn't JSON (truncated stream, HTML
    // error page from an intermediate proxy, etc.). A retry will almost
    // certainly hit the same malformed cache entry, so skip.
    return {
      status: "skipped",
      reason: `bad_json: ${err?.message ?? err}`,
    };
  }

  const recordings = json?.recordings;
  if (!Array.isArray(recordings) || recordings.length === 0) {
    return { status: "not_found" };
  }

  // Take the first recording. MB's search ranks by Lucene score, but for
  // a URL-relationship match there's effectively one canonical recording
  // per Spotify track in practice. If MB ever returns more than one we'd
  // need a tiebreaker — for v1 just trust the rank.
  const top = recordings[0];
  const rawMbid = typeof top?.id === "string" ? top.id : null;
  if (!rawMbid) {
    // MB returned a recording object but without an id. Genuinely strange
    // and worth tracking — but no usable handle to persist either way.
    return { status: "not_found" };
  }
  if (!MBID_REGEX.test(rawMbid)) {
    // Previously we'd happily store this bogus value in tracks.mbid; now
    // we surface it as bad data so it can be inspected via logs.
    return {
      status: "skipped",
      reason: `malformed_mbid: ${rawMbid.slice(0, 80)}`,
    };
  }

  // Pick first valid ISRC if any. MB returns "isrcs" as an array of strings.
  // We silently drop malformed entries — this is a long-standing MB data
  // quality issue, not something the caller needs to act on per-track.
  let isrc = null;
  const isrcs = Array.isArray(top?.isrcs) ? top.isrcs : [];
  for (const candidate of isrcs) {
    if (typeof candidate === "string" && ISRC_REGEX.test(candidate)) {
      isrc = candidate;
      break;
    }
  }

  return { status: "ok", mbid: rawMbid, isrc };
}
