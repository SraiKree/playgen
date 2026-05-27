// Pure Deezer API helper. No auth/key for public catalog reads — same shape as
// the other pure source modules.
//
// Two match paths:
//   1. by ISRC (exact): GET /track/isrc:{isrc} — the clean path. (Our catalog
//      has no ISRCs yet, so this is future-proofing: it lights up automatically
//      once ISRCs are backfilled.)
//   2. fuzzy search fallback: GET /search?q=artist:"..." track:"..." — used when
//      there's no ISRC or the ISRC misses. NOTE: Deezer's search endpoint is
//      known to return empty `data` (with a non-zero `total`) from some
//      datacenter IPs — an anti-scraping quirk. It works from many residential/
//      deployment IPs; where it doesn't, lookups just degrade to not_found.
//
// Genre lives on the ALBUM, not the track, so every path resolves
// track -> album.id -> GET /album/{id} -> genres.data[].name.
//
// Rate limit: ~50 req / 5s per IP; generous. The caller throttles lightly.

const DEEZER_API = "https://api.deezer.com";
const DEEZER_TIMEOUT_MS = 15_000;
const USER_AGENT = "playgen/0.1 (https://github.com/SraiKree/playgen)";

// Same 12-char ISRC shape validated in lib/wikidata.js / lib/musicbrainz.js.
const ISRC_REGEX = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

function normalizeForMatch(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function namesRoughlyMatch(a, b) {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// GET + parse. Throws on transient (429 / 5xx / network) so Inngest retries.
// Non-transient non-2xx and bad JSON return null (the caller treats as a miss).
async function getJson(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(DEEZER_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Deezer fetch failed: ${err?.message ?? err}`);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new Error(`Deezer ${res.status} ${res.statusText}`);
  }
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// Deezer reports application errors as { error: { type, message, code } }.
// code 4 (and "Quota limit exceeded" messages) are rate limits -> retry by
// throwing. code 800 (DataException "no data") is a normal miss. We throw on
// quota and return null otherwise (miss).
function checkDeezerError(json) {
  const err = json?.error;
  if (!err) return false;
  if (err.code === 4 || /quota/i.test(err.message ?? "")) {
    throw new Error(`Deezer quota: ${err.message ?? "rate limited"}`);
  }
  return true; // a non-retryable error -> treat as miss
}

async function albumGenres(albumId) {
  if (!albumId) return [];
  const alb = await getJson(`${DEEZER_API}/album/${albumId}`);
  if (!alb || checkDeezerError(alb)) return [];
  const data = alb?.genres?.data;
  return Array.isArray(data)
    ? data.map((g) => String(g?.name ?? "").trim()).filter(Boolean)
    : [];
}

/**
 * Resolve a track's genres on Deezer. ISRC-exact first, fuzzy search fallback.
 *
 * Returns:
 *   { status: "ok", genres: string[] }   — matched and the album had genres
 *   { status: "not_found" }              — no match, or matched with no genres
 * Throws on HTTP 429/5xx/network/quota so Inngest retries.
 *
 * @param {{isrc?: string|null, artist?: string|null, track?: string|null}} opts
 */
export async function fetchTrackGenres({ isrc, artist, track }) {
  // Path 1: ISRC-exact.
  if (typeof isrc === "string" && ISRC_REGEX.test(isrc)) {
    const t = await getJson(`${DEEZER_API}/track/isrc:${isrc}`);
    if (t && !checkDeezerError(t) && t.id) {
      const genres = await albumGenres(t?.album?.id);
      if (genres.length) return { status: "ok", genres };
      return { status: "not_found" };
    }
    // ISRC miss — fall through to the fuzzy search (Deezer may still know it).
  }

  // Path 2: fuzzy artist+track search.
  if (!artist || !track) return { status: "not_found" };
  const q = `artist:"${artist.replace(/"/g, "")}" track:"${track.replace(/"/g, "")}"`;
  const s = await getJson(`${DEEZER_API}/search?q=${encodeURIComponent(q)}&limit=5`);
  if (!s || checkDeezerError(s)) return { status: "not_found" };

  const data = Array.isArray(s?.data) ? s.data : [];
  for (const r of data) {
    if (!namesRoughlyMatch(r?.artist?.name, artist)) continue;
    const genres = await albumGenres(r?.album?.id);
    if (genres.length) return { status: "ok", genres };
    return { status: "not_found" };
  }
  return { status: "not_found" };
}
