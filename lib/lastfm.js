// Pure Last.fm Web API functions. No Inngest, no Next.js, no DB — just fetch + transforms.
// Mirrors the shape of lib/spotify.js so the enrichment workers can orchestrate both the
// same way (CLAUDE.md §4: "Pure logic lives in lib/spotify.js, lib/lastfm.js, lib/library.js").
//
// Why Last.fm at all? (CLAUDE.md §2)
//   Spotify's /audio-features endpoint was killed for new apps in Nov 2024, so we can't ask
//   Spotify "is this track danceable / acoustic / energetic". Last.fm's crowd-sourced tags
//   ("chillwave", "summer", "running", "90s") fill that gap as the Layer 1 cold-start snapshot.
//   The community tag system (Layer 2) takes over from there.
//
// Auth model: Last.fm read-methods only require an api_key on the query string. No OAuth,
// no signing, no token refresh. Much simpler than Spotify.
//
// Rate limit (CLAUDE.md §5): ~5 req/sec per API key. This module doesn't enforce that — it's
// the caller's job (the Inngest function caps concurrency at 5). Keeping rate-limiting out of
// the pure layer means this file stays trivially testable.

const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";

// Last.fm tag "count" is a 0–100 relative-popularity score (how many of the top taggers
// applied this tag). Below ~10 the long tail is mostly personal/junk tags like "seen live"
// or "my favourite". 10 is a conservative floor that keeps the genre-ish signal and drops noise.
const MIN_TAG_COUNT = 10;

/**
 * Internal: build the query string, call Last.fm, surface errors usefully.
 *
 * Last.fm has two failure modes we have to distinguish:
 *   1. HTTP-level failure (5xx, network) → res.ok is false.
 *   2. Application-level failure (e.g. "Track not found", "Invalid API key") → HTTP 200
 *      with a JSON body like `{ error: 6, message: "Track not found" }`. We re-throw these
 *      so Inngest sees them as failed steps rather than silently swallowing.
 *
 * @param {string} method   e.g. "track.getTopTags"
 * @param {Record<string,string>} params  method-specific query params (artist, track, ...)
 */
async function lastfmFetch(method, params) {
  const apiKey = process.env.LASTFM_API_KEY;
  // System-boundary validation: a missing key would manifest as a confusing "Invalid API key"
  // error from Last.fm. Fail fast and locally instead.
  if (!apiKey) {
    throw new Error("LASTFM_API_KEY not set in environment");
  }

  const search = new URLSearchParams({
    method,
    api_key: apiKey,
    format: "json",
    ...params,
  });

  const res = await fetch(`${LASTFM_API}?${search.toString()}`);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Last.fm ${res.status} ${res.statusText} on method=${method}: ${body}`);
  }

  const json = await res.json();
  if (json && typeof json.error === "number") {
    throw new Error(`Last.fm method=${method} error ${json.error}: ${json.message ?? "(no message)"}`);
  }
  return json;
}

/**
 * Top tags for a single track — the Layer 1 bootstrap snapshot (CLAUDE.md §2).
 *
 * Per CLAUDE.md §4 ("Last.fm snapshots are frozen"), the result of this call is written once
 * to the tracks cache at enrichment time and never refetched. Tag evolution after that point
 * happens only through user_tags / tag_votes (Layer 2).
 *
 * Returned tags are NOT normalized (lowercase/trim/fuzzy-merge) — that lives in lib/library.js
 * on insert, because the same normalization needs to apply to user-submitted tags too.
 *
 * Last.fm quirk: when a track has no tags, the API returns `{ toptags: { tag: '' } }` (a literal
 * empty string!) instead of `tag: []`. We coerce to an array so callers don't have to think about it.
 *
 * @param {object} opts
 * @param {string} opts.artist
 * @param {string} opts.track
 * @param {boolean} [opts.autocorrect=true]  let Last.fm fix obvious misspellings ("Beatles" → "The Beatles")
 * @returns {Promise<Array<{name: string, count: number}>>}  tags above MIN_TAG_COUNT, in Last.fm's rank order
 */
export async function fetchTrackTopTags({ artist, track, autocorrect = true }) {
  const json = await lastfmFetch("track.getTopTags", {
    artist,
    track,
    autocorrect: autocorrect ? "1" : "0",
  });

  const raw = json?.toptags?.tag;
  const arr = Array.isArray(raw) ? raw : [];

  return arr
    .map((t) => ({
      name: String(t.name ?? "").trim(),
      count: Number(t.count) || 0,
    }))
    .filter((t) => t.name.length > 0 && t.count >= MIN_TAG_COUNT);
}
