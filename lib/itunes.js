// Pure iTunes Search API helper. No auth, no key — same shape as lib/spotify.js
// / lib/lastfm.js / lib/wikidata.js so the enrichment workers orchestrate it the
// same way.
//
// Why iTunes? Our catalog has no ISRCs, so the ISRC-keyed sources (Wikidata,
// Deezer-by-ISRC) can't match it. iTunes has no ISRC lookup but its FUZZY
// artist+track search is reliable and returns a primaryGenreName per track —
// and Apple's catalog is strong on the Indian/film/regional music that Last.fm
// and MusicBrainz cover poorly. So this is the track-level genre source that
// actually rescues the no-ISRC tail.
//
// Rate limit: Apple doesn't document a hard number; ~20 req/min per IP is the
// widely-observed soft cap, and exceeding it returns HTTP 403/429. The caller
// (the iTunes backfill cron) throttles with step.sleep; this module doesn't.

const ITUNES_SEARCH = "https://itunes.apple.com/search";
const ITUNES_TIMEOUT_MS = 15_000;

// primaryGenreName values too generic to be useful as a seed tag.
const GENERIC_GENRES = new Set(["music", "", "other"]);

// Loose normalization for comparing artist names across services: lowercase,
// strip diacritics, collapse anything non-alphanumeric to single spaces.
function normalizeForMatch(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Two artist names "match" if, after normalization, one contains the other.
// Exact for clean cases; tolerates "feat."/"The"/punctuation differences
// without being so loose it accepts an unrelated artist (which would attach a
// wrong genre to the track).
function namesRoughlyMatch(a, b) {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Look up a track's genre on iTunes by fuzzy artist+track search.
 *
 * Returns:
 *   { status: "ok", genres: string[] }   — matched; genres = [primaryGenreName]
 *   { status: "not_found" }              — no result whose artist matches ours,
 *                                          or the matched result's genre is generic
 *   { status: "skipped", reason }        — bad data (non-transient 4xx, bad JSON,
 *                                          missing inputs)
 * Throws on HTTP 429/5xx/network so Inngest retries.
 *
 * @param {{artist: string, track: string}} opts
 */
export async function fetchTrackGenre({ artist, track }) {
  if (!artist || !track) {
    return { status: "skipped", reason: "missing_artist_or_track" };
  }

  const params = new URLSearchParams({
    term: `${artist} ${track}`,
    entity: "song",
    media: "music",
    limit: "5",
  });

  let res;
  try {
    res = await fetch(`${ITUNES_SEARCH}?${params}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(ITUNES_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`iTunes fetch failed: ${err?.message ?? err}`);
  }

  if (res.status === 429 || res.status >= 500) {
    throw new Error(`iTunes ${res.status} ${res.statusText}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { status: "skipped", reason: `http_${res.status}: ${body.slice(0, 120)}` };
  }

  let json;
  try {
    // iTunes serves valid JSON under a text/javascript content-type; res.json()
    // parses the body regardless of content-type.
    json = await res.json();
  } catch (err) {
    return { status: "skipped", reason: `bad_json: ${err?.message ?? err}` };
  }

  const results = Array.isArray(json?.results) ? json.results : [];
  for (const r of results) {
    if (!namesRoughlyMatch(r.artistName, artist)) continue;
    const genre = String(r.primaryGenreName ?? "").trim();
    // Matched the artist but the genre is useless — treat as a miss so we don't
    // attach "music" to the track, but still mark it checked upstream.
    if (!genre || GENERIC_GENRES.has(genre.toLowerCase())) {
      return { status: "not_found" };
    }
    // Apple joins compound genres with "/" ("Hip-Hop/Rap", "R&B/Soul"). Split
    // into separate genres so each normalizes to a clean stem ("hip-hop",
    // "rap") that aligns with the other sources, instead of one mangled token.
    const genres = genre.split("/").map((g) => g.trim()).filter(Boolean);
    return { status: "ok", genres };
  }
  return { status: "not_found" };
}
