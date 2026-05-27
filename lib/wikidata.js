// Pure Wikidata SPARQL helper. No Inngest, no Next.js, no DB — same shape as
// lib/spotify.js and lib/lastfm.js so the enrichment workers orchestrate it
// the same way (CLAUDE.md §4: "Pure logic lives in lib/spotify.js,
// lib/lastfm.js, lib/library.js"). This file is the third sibling.
//
// Why Wikidata? (see CLAUDE.md §2 and the plan at
// C:\Users\saisr\.claude\plans\we-need-to-start-jaunty-crayon.md)
//
//   Layer 1 today = Spotify artist genres + Last.fm top tags.
//   Coverage is thin for less-popular tracks; the community Layer 2 needs
//   factual anchors to build on. Wikidata gives us structured properties
//   (genre, instrument, language, country, producer, record label, series
//   membership) without scraping, without an LLM, and without paying.
//
// Auth model: SPARQL endpoint is open. The only requirement Wikimedia
// enforces is a real User-Agent identifying the project — anonymous bot
// traffic gets rate-limited or banned. Rate limit is generous (~60 req/min
// unauthenticated), so the worker's concurrency of 5 is comfortably under.

// Public SPARQL endpoint, response in JSON.
const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

// User-Agent: Wikimedia requires a descriptive UA with a contact path.
// Pointing at the repo gives them somewhere to reach a maintainer if our
// queries ever misbehave. If you fork this project, update the URL.
const USER_AGENT = "playgen/0.1 (https://github.com/SraiKree/playgen)";

// 15 seconds: Wikidata's public endpoint has a 60s server-side timeout, but
// we'd rather give up earlier and let Inngest retry than tie up the worker.
const SPARQL_TIMEOUT_MS = 15_000;

/**
 * Decide whether a non-2xx HTTP status from Wikidata is worth retrying.
 *
 * Retryable (caller should throw and lean on Inngest retries):
 *   - 408 Request Timeout, 425 Too Early, 429 Too Many Requests
 *   - 5xx (server side, transient)
 *
 * Everything else (400, 403, 422, …) is a deterministic rejection of *this
 * specific SPARQL body* — replaying it sends identical bytes and gets the
 * same error. Skip the offending ISRC instead of stranding the batch.
 */
function isTransientHttpStatus(status) {
  if (status >= 500) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  return false;
}

// ISRC format check. The international standard is 12 chars:
//   - 2 letters    country code (ISO 3166-1)
//   - 3 alphanumeric  registrant code
//   - 2 digits     year
//   - 5 digits     designation
// Example: GBUM71029604 (Bohemian Rhapsody).
// We validate strictly because the ISRC is string-interpolated into the
// SPARQL body (no parameterised binds at this endpoint), so untrusted
// input must be rejected here before it ever touches the query.
const ISRC_REGEX = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

// MusicBrainz recording ID (MBID): canonical 8-4-4-4-12 hex UUID. Same shape
// lib/musicbrainz.js validates. Used for the by-MBID Wikidata fallback (the
// recording is matched on wdt:P4404 instead of the ISRC's wdt:P1243). Like
// the ISRC, the MBID is string-interpolated into the SPARQL body, so it must
// be validated before it ever touches the query.
const MBID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the SPARQL query that resolves a recording by an external identifier
 * and pulls its factual properties.
 *
 * @param {string} idPredicate  the identifier property — `wdt:P1243` (ISRC)
 *                              or `wdt:P4404` (MusicBrainz recording ID).
 * @param {string} idValue      the (already-validated) identifier literal.
 *
 * `wdt:Pxxx` are direct truthy property statements — i.e. the "best" value
 * for each property. `OPTIONAL { ... }` means missing properties don't fail
 * the whole query, they just return as unbound.
 *
 * `SERVICE wikibase:label` is Wikidata's label-resolver service: given an
 * entity (e.g. Q11399 for "rock music"), it adds `?<var>Label` with the
 * English label ("rock music"). Without it we'd get back URIs and have to
 * resolve them ourselves with extra round-trips.
 *
 * LIMIT 200 is a safety net — a single recording shouldn't have hundreds of
 * properties, but if Wikidata serves us junk we don't want to allocate
 * unbounded memory parsing it.
 */
function buildQuery(idPredicate, idValue) {
  return `
SELECT ?recording ?genreLabel ?instrumentLabel ?languageLabel
       ?countryLabel ?producerLabel ?labelLabel ?seriesLabel
WHERE {
  ?recording ${idPredicate} "${idValue}" .
  OPTIONAL { ?recording wdt:P136 ?genre . }
  OPTIONAL { ?recording wdt:P870 ?instrument . }
  OPTIONAL { ?recording wdt:P407 ?language . }
  OPTIONAL { ?recording wdt:P495 ?country . }
  OPTIONAL { ?recording wdt:P162 ?producer . }
  OPTIONAL { ?recording wdt:P264 ?label . }
  OPTIONAL { ?recording wdt:P179 ?series . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 200
`.trim();
}

/**
 * Extract a Wikidata QID (e.g. "Q221037") from an entity URI.
 * Wikidata returns recordings as full URIs like
 * "http://www.wikidata.org/entity/Q221037".
 */
function uriToQid(uri) {
  if (typeof uri !== "string") return null;
  const i = uri.lastIndexOf("/");
  if (i < 0) return null;
  const tail = uri.slice(i + 1);
  return /^Q\d+$/.test(tail) ? tail : null;
}

/**
 * Top-level helper: given an ISRC, resolve one Wikidata recording entity and
 * return its factual tags grouped by property.
 *
 * Returns one of:
 *   { status: "ok",        qid, genres, instruments, languages,
 *                          countries, producers, recordLabels, partOfSeries }
 *                                          — recording matched and we
 *                                            extracted at least one usable
 *                                            field. Arrays may be empty.
 *   { status: "not_found" }                — malformed ISRC, Wikidata returned
 *                                            zero bindings, or bindings had
 *                                            no extractable QID. Caller marks
 *                                            the track as enriched-miss so we
 *                                            don't re-query.
 *   { status: "skipped",   reason }        — bad data: non-transient 4xx,
 *                                            malformed JSON. Caller logs and
 *                                            moves on without marking enriched.
 *
 * Throws on:
 *   - HTTP 5xx, 408, 425, 429 (Inngest retries)
 *   - network / DNS / TCP / timeout failures (Inngest retries)
 *
 * Multiple-QID edge case: if Wikidata has TWO recordings sharing the same
 * ISRC (rare data-quality issue, ISRC is supposed to be unique), we take
 * the lexicographically-smallest QID and silently drop the rest. The
 * alternative — failing the whole worker — is worse for tag coverage.
 *
 * Note on payload shape: the "ok" branch keeps the same flat key layout the
 * upstream library helper (upsertWikidataTagsByIsrc) already reads —
 * `payload.qid`, `payload.genres`, etc. The added `status` field is harmless
 * to that helper, which only reads specific keys it knows about.
 *
 * @param {string} isrc
 * @returns {Promise<
 *   | { status: "ok",
 *       qid: string,
 *       genres: string[], instruments: string[], languages: string[],
 *       countries: string[], producers: string[],
 *       recordLabels: string[], partOfSeries: string[] }
 *   | { status: "not_found" }
 *   | { status: "skipped", reason: string }
 * >}
 */
export async function fetchTrackTagsByIsrc(isrc) {
  // Strict input validation. We refuse to even open the connection for a
  // malformed ISRC — that's both safer (no untrusted string in the SPARQL
  // body) and faster (no round-trip just to learn we sent garbage).
  // Surface malformed ISRCs as a *skip* (not a not-found) because the row
  // shouldn't get marked wikidata_enriched_at on the back of bad input.
  if (typeof isrc !== "string" || !ISRC_REGEX.test(isrc)) {
    return { status: "skipped", reason: "invalid_isrc" };
  }
  return executeRecordingQuery(buildQuery("wdt:P1243", isrc));
}

/**
 * by-MBID sibling of fetchTrackTagsByIsrc. Resolves the Wikidata recording on
 * wdt:P4404 (MusicBrainz recording ID) instead of the ISRC's wdt:P1243.
 *
 * This is the fallback path for tracks MusicBrainz knows by MBID but stores no
 * ISRC for — without it, ISRC-less tracks could never gain Wikidata tags.
 * Same return union and payload shape as fetchTrackTagsByIsrc, so the
 * upstream upsert helper consumes either identically.
 *
 * @param {string} mbid  canonical 8-4-4-4-12 hex UUID.
 * @returns {Promise<
 *   | { status: "ok", qid: string, genres: string[], instruments: string[],
 *       languages: string[], countries: string[], producers: string[],
 *       recordLabels: string[], partOfSeries: string[] }
 *   | { status: "not_found" }
 *   | { status: "skipped", reason: string }
 * >}
 */
export async function fetchTrackTagsByMbid(mbid) {
  if (typeof mbid !== "string" || !MBID_REGEX.test(mbid)) {
    return { status: "skipped", reason: "invalid_mbid" };
  }
  return executeRecordingQuery(buildQuery("wdt:P4404", mbid));
}

/**
 * Run a recording-resolution SPARQL query and shape the response into the
 * discriminated result documented on fetchTrackTagsByIsrc. Shared by both
 * by-ISRC and by-MBID entry points — only the WHERE-clause identifier differs.
 *
 * @param {string} query  a SPARQL body from buildQuery(...).
 */
async function executeRecordingQuery(query) {
  let res;
  try {
    res = await fetch(SPARQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/sparql-query",
        Accept: "application/sparql-results+json",
        "User-Agent": USER_AGENT,
      },
      body: query,
      signal: AbortSignal.timeout(SPARQL_TIMEOUT_MS),
    });
  } catch (err) {
    // Network / abort errors: genuinely transient — throw so Inngest sees a
    // failed step and retries (the function declares retries: 3).
    throw new Error(`Wikidata SPARQL fetch failed: ${err?.message ?? err}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const snippet = body.slice(0, 500);
    if (isTransientHttpStatus(res.status)) {
      // 5xx / 408 / 425 / 429 — throw so Inngest retries the step.
      throw new Error(
        `Wikidata SPARQL ${res.status} ${res.statusText}: ${snippet}`,
      );
    }
    // Non-transient 4xx (400, 403, 422, …): replaying gets the same
    // rejection. Skip the offending ISRC.
    return {
      status: "skipped",
      reason: `http_${res.status}: ${snippet.slice(0, 200)}`,
    };
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    // 2xx but the body isn't parseable JSON. Retrying typically hits the
    // same malformed cache entry — skip.
    return {
      status: "skipped",
      reason: `bad_json: ${err?.message ?? err}`,
    };
  }

  const bindings = json?.results?.bindings;
  if (!Array.isArray(bindings) || bindings.length === 0) {
    // No Wikidata recording matched this ISRC. Caller marks this as a
    // miss; the track row's wikidata_enriched_at still gets set so we
    // never retry.
    return { status: "not_found" };
  }

  // Multi-recording dedup: pick the lexicographically-smallest QID. SPARQL
  // bindings can include OPTIONAL values, so the same ?recording often
  // appears in many rows with different optional fields populated.
  const qids = new Set();
  for (const b of bindings) {
    const qid = uriToQid(b.recording?.value);
    if (qid) qids.add(qid);
  }
  if (qids.size === 0) {
    // Bindings existed but every recording URI failed QID extraction —
    // treat as not_found (we have nothing to attach tags to). Marking the
    // track enriched-miss is appropriate here: this won't change on retry,
    // but it's a structural Wikidata response, not bad data on our side.
    return { status: "not_found" };
  }

  const chosenQid = [...qids].sort()[0];
  const chosenUriSuffix = `/${chosenQid}`;
  const matchingRows = bindings.filter((b) =>
    typeof b.recording?.value === "string" && b.recording.value.endsWith(chosenUriSuffix),
  );

  // Group label values by property, deduplicated. Sets per property keep
  // memory bounded and produce stable arrays for downstream normalization.
  const buckets = {
    genres: new Set(),
    instruments: new Set(),
    languages: new Set(),
    countries: new Set(),
    producers: new Set(),
    recordLabels: new Set(),
    partOfSeries: new Set(),
  };
  const labelKeyToBucket = {
    genreLabel:      "genres",
    instrumentLabel: "instruments",
    languageLabel:   "languages",
    countryLabel:    "countries",
    producerLabel:   "producers",
    labelLabel:      "recordLabels",
    seriesLabel:     "partOfSeries",
  };

  for (const row of matchingRows) {
    for (const [labelKey, bucketName] of Object.entries(labelKeyToBucket)) {
      const value = row[labelKey]?.value;
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed.length === 0) continue;
      // SERVICE wikibase:label falls back to the QID when no English label
      // exists. Drop those — a tag named "Q12345" is worse than no tag.
      if (/^Q\d+$/.test(trimmed)) continue;
      buckets[bucketName].add(trimmed);
    }
  }

  return {
    status: "ok",
    qid: chosenQid,
    genres:        [...buckets.genres],
    instruments:   [...buckets.instruments],
    languages:     [...buckets.languages],
    countries:     [...buckets.countries],
    producers:     [...buckets.producers],
    recordLabels:  [...buckets.recordLabels],
    partOfSeries:  [...buckets.partOfSeries],
  };
}
