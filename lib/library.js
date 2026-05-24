// Pure DB operations for tracks / user_library. Service-role client only —
// these are called from Inngest workers and scripts, never from the browser.

import { createAdminClient } from "./supabase/admin.js";

// PostgREST's `?in=(...)` query string gets unwieldy past ~250 IDs;
// 200 keeps URLs comfortably under the 8 KB nginx default.
const QUERY_CHUNK = 200;

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

/**
 * Spotify returns release_date in three precisions:
 *   "2014"       (year)
 *   "2014-05"    (month)
 *   "2014-05-12" (day)
 * Postgres `date` only accepts full YYYY-MM-DD, so pad the shorter forms.
 * Original granularity is preserved in tracks.release_date_precision.
 */
function parseSpotifyReleaseDate(value, precision) {
    if (!value) return null;
    if (precision === "day") return value;
    if (precision === "month") return `${value}-01`;
    if (precision === "year") return `${value}-01-01`;
    // Fallback: trust whatever Spotify sent; if malformed, Postgres will reject the row.
    return value;
}

function normalizeTrack(track) {
    return {
        spotify_id: track.id,
        name: track.name,
        album_name: track.album?.name ?? null,
        album_image_url: track.album?.images?.[0]?.url ?? null,
        duration_ms: track.duration_ms ?? null,
        popularity: track.popularity ?? null,
        release_date: parseSpotifyReleaseDate(
            track.album?.release_date,
            track.album?.release_date_precision,
        ),
        release_date_precision: track.album?.release_date_precision ?? null,
        preview_url: track.preview_url ?? null,
        // ISRC from Spotify's /me/tracks payload. Only present on freshly-inserted
        // rows — existing rows are NOT updated by upsertTracks (ignoreDuplicates),
        // so already-cached tracks get backfilled by library-backfill-isrc instead.
        isrc: track.external_ids?.isrc ?? null,
    };
}

/**
 * Insert raw Spotify track objects into the global `tracks` cache.
 *
 * Semantics: INSERT ... ON CONFLICT (spotify_id) DO NOTHING.
 * Rows are inserted with enriched_at = NULL; the enrichment worker fills it later.
 *
 * @param {object[]} spotifyTracks  Raw track objects from fetchSavedTracks / fetchTracksBatch.
 *                                  Items with falsy .id (local files, unavailable tracks) are skipped.
 * @param {object} [client]         Optional Supabase client; defaults to a fresh admin client.
 */
export async function upsertTracks(spotifyTracks, client = createAdminClient()) {
    const rows = spotifyTracks.filter((t) => t?.id).map(normalizeTrack);
    if (rows.length === 0) return;

    for (const batch of chunk(rows, QUERY_CHUNK)) {
        const { error } = await client
            .from("tracks")
            .upsert(batch, { onConflict: "spotify_id", ignoreDuplicates: true });
        if (error) throw new Error(`upsertTracks failed: ${error.message}`);
    }
}

/**
 * Link a Supabase user to tracks in their Spotify "Liked Songs".
 *
 * Caller must have already `upsertTracks`-ed the same batch — this function
 * resolves spotify_ids to internal bigint track_ids via a SELECT and silently
 * drops any spotify_id that isn't present in `tracks`.
 *
 * Idempotent: re-running the sync after the user likes more songs will not
 * duplicate or error on rows already linked (PK is (user_id, track_id)).
 *
 * @param {string} userId   Supabase auth UUID.
 * @param {{spotifyId: string, addedAt: string}[]} items
 *                          addedAt is Spotify's "when the user liked this" timestamp.
 * @param {object} [client]
 */
export async function linkTracksToUser(userId, items, client = createAdminClient()) {
    if (items.length === 0) return;

    const addedAtBySpotifyId = new Map(items.map((i) => [i.spotifyId, i.addedAt]));
    const spotifyIds = [...addedAtBySpotifyId.keys()];

    const idMap = new Map(); // spotify_id -> bigint track id
    for (const batch of chunk(spotifyIds, QUERY_CHUNK)) {
        const { data, error } = await client
            .from("tracks")
            .select("id, spotify_id")
            .in("spotify_id", batch);
        if (error) throw new Error(`linkTracksToUser lookup failed: ${error.message}`);
        for (const row of data) idMap.set(row.spotify_id, row.id);
    }

    const rows = [];
    for (const [spotifyId, addedAt] of addedAtBySpotifyId) {
        const trackId = idMap.get(spotifyId);
        if (trackId === undefined) continue;
        rows.push({ user_id: userId, track_id: trackId, added_at: addedAt });
    }
    if (rows.length === 0) return;

    for (const batch of chunk(rows, QUERY_CHUNK)) {
        const { error } = await client
            .from("user_library")
            .upsert(batch, { onConflict: "user_id,track_id", ignoreDuplicates: true });
        if (error) throw new Error(`linkTracksToUser insert failed: ${error.message}`);
    }
}

/**
 * Given a batch of spotify_ids, return the subset whose tracks row exists AND
 * has enriched_at IS NULL — i.e. the set the enrichment worker should pick up.
 *
 * Uses the partial index tracks_unenriched_idx (migration 0001 line 58).
 * IDs not present in `tracks` are excluded; in practice the orchestrator runs
 * upsertTracks first so every input id is guaranteed to exist.
 *
 * @param {string[]} spotifyIds
 * @param {object} [client]
 * @returns {Promise<string[]>}
 */
export async function getUnenrichedTrackIds(spotifyIds, client = createAdminClient()) {
    if (spotifyIds.length === 0) return [];

    const out = [];
    for (const batch of chunk(spotifyIds, QUERY_CHUNK)) {
        const { data, error } = await client
            .from("tracks")
            .select("spotify_id")
            .in("spotify_id", batch)
            .is("enriched_at", null);
        if (error) throw new Error(`getUnenrichedTrackIds failed: ${error.message}`);
        for (const row of data) out.push(row.spotify_id);
    }
    return out;
}

// Layer 1 enrichment helpers

/**
 * Canonicalize a tag string so "Chill", "chill ", "CHILL", "Chillout!", and
 * "chîllout" all collapse to one stable key before hitting the `tags` table.
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeTag(name) {
    return String(name ?? "")
        .toLowerCase()
        .trim()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")      // combining diacritical marks
        .replace(/[^\p{L}\p{N}\s-]/gu, "")    // keep letters, digits, whitespace, hyphen
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * @param {object} client
 * @param {"tracks"|"artists"} table
 * @param {string[]} spotifyIds
 * @returns {Promise<Map<string, number>>}
 */
async function lookupIdsBySpotifyId(client, table, spotifyIds) {
    const out = new Map();
    if (spotifyIds.length === 0) return out;
    for (const batch of chunk(spotifyIds, QUERY_CHUNK)) {
        const { data, error } = await client
            .from(table)
            .select("id, spotify_id")
            .in("spotify_id", batch);
        if (error) throw new Error(`lookupIdsBySpotifyId(${table}) failed: ${error.message}`);
        for (const row of data) out.set(row.spotify_id, row.id);
    }
    return out;
}

/**
 * Upsert artist rows from Spotify's /artists?ids=... response.
 *
 * @param {object[]} spotifyArtists  raw artist objects from fetchArtistsBatch
 * @param {object} [client]
 */
export async function upsertArtists(spotifyArtists, client = createAdminClient()) {
    const rows = spotifyArtists
        .filter((a) => a?.id)
        .map((a) => ({
            spotify_id: a.id,
            name: a.name,
            genres: a.genres ?? [],
            popularity: a.popularity ?? null,
            enriched_at: new Date().toISOString(),
        }));
    if (rows.length === 0) return;

    for (const batch of chunk(rows, QUERY_CHUNK)) {
        const { error } = await client
            .from("artists")
            .upsert(batch, { onConflict: "spotify_id" });
        if (error) throw new Error(`upsertArtists failed: ${error.message}`);
    }
}

/**
 * Write track_artists junction rows.
 * Idempotent: PK is (track_id, artist_id) and we use ignoreDuplicates.
 *
 * @param {{trackSpotifyId: string, artistSpotifyId: string, position: number}[]} links
 * @param {object} [client]
 */
export async function linkTrackArtists(links, client = createAdminClient()) {
    if (links.length === 0) return;

    const trackSpotifyIds = [...new Set(links.map((l) => l.trackSpotifyId))];
    const artistSpotifyIds = [...new Set(links.map((l) => l.artistSpotifyId))];

    const trackIdMap = await lookupIdsBySpotifyId(client, "tracks", trackSpotifyIds);
    const artistIdMap = await lookupIdsBySpotifyId(client, "artists", artistSpotifyIds);

    const rows = links
        .map((l) => ({
            track_id: trackIdMap.get(l.trackSpotifyId),
            artist_id: artistIdMap.get(l.artistSpotifyId),
            position: l.position,
        }))
        .filter((r) => r.track_id !== undefined && r.artist_id !== undefined);

    if (rows.length === 0) return;

    for (const batch of chunk(rows, QUERY_CHUNK)) {
        const { error } = await client
            .from("track_artists")
            .upsert(batch, { onConflict: "track_id,artist_id", ignoreDuplicates: true });
        if (error) throw new Error(`linkTrackArtists failed: ${error.message}`);
    }
}

/**
 * @param {string} trackSpotifyId
 * @param {{name: string, count: number}[]} lastfmTags  output of fetchTrackTopTags
 * @param {object} [client]
 */
export async function upsertLastfmTagsForTrack(trackSpotifyId, lastfmTags, client = createAdminClient()) {
    // (1) Normalize + dedup. byName: normalized-name → max raw count seen.
    const byName = new Map();
    for (const t of lastfmTags) {
        const norm = normalizeTag(t?.name);
        if (norm.length === 0) continue;
        const count = Number(t?.count) || 0;
        const prev = byName.get(norm);
        if (prev === undefined || count > prev) byName.set(norm, count);
    }
    if (byName.size === 0) return;

    const names = [...byName.keys()];

    // (2) Ensure tag rows exist. Atomic upsert per CLAUDE.md §4 (no SELECT-then-INSERT).
    for (const batch of chunk(names.map((name) => ({ name })), QUERY_CHUNK)) {
        const { error } = await client
            .from("tags")
            .upsert(batch, { onConflict: "name", ignoreDuplicates: true });
        if (error) throw new Error(`upsertLastfmTagsForTrack tag insert failed: ${error.message}`);
    }

    // (3) Resolve names → tag PKs.
    const tagIdMap = new Map();
    for (const batch of chunk(names, QUERY_CHUNK)) {
        const { data, error } = await client
            .from("tags")
            .select("id, name")
            .in("name", batch);
        if (error) throw new Error(`upsertLastfmTagsForTrack tag lookup failed: ${error.message}`);
        for (const row of data) tagIdMap.set(row.name, row.id);
    }

    // (4) Resolve trackSpotifyId → track PK. If the track row vanished between
    const { data: trackRow, error: tErr } = await client
        .from("tracks")
        .select("id")
        .eq("spotify_id", trackSpotifyId)
        .maybeSingle();
    if (tErr) throw new Error(`upsertLastfmTagsForTrack track lookup failed: ${tErr.message}`);
    if (!trackRow) return;

    // (5) Build junction rows. Clamp count to smallint range defensively;
    const rows = [...byName.entries()]
        .map(([name, lastfm_count]) => ({
            track_id: trackRow.id,
            tag_id: tagIdMap.get(name),
            lastfm_count: Math.max(0, Math.min(100, Math.trunc(lastfm_count))),
        }))
        .filter((r) => r.tag_id !== undefined);

    if (rows.length === 0) return;

    const { error } = await client
        .from("track_tags_lastfm")
        .upsert(rows, { onConflict: "track_id,tag_id", ignoreDuplicates: true });
    if (error) throw new Error(`upsertLastfmTagsForTrack junction insert failed: ${error.message}`);
}

/**
 * Mark tracks as successfully Last.fm-enriched. Stamps enriched_at AND clears
 * lastfm_last_error — successful refresh wipes any previous failure note.
 *
 * Note: a successful Last.fm call that returns an EMPTY tag list still counts
 * as success ("the API said: zero tags for this track"). Only API/network
 * errors flow through recordLastfmFailure / markTracksGaveUp.
 *
 * @param {string[]} spotifyIds
 * @param {object} [client]
 */
export async function markTracksEnrichedSuccess(spotifyIds, client = createAdminClient()) {
    if (spotifyIds.length === 0) return;

    const enrichedAt = new Date().toISOString();
    for (const batch of chunk(spotifyIds, QUERY_CHUNK)) {
        const { error } = await client
            .from("tracks")
            .update({ enriched_at: enrichedAt, lastfm_last_error: null })
            .in("spotify_id", batch);
        if (error) throw new Error(`markTracksEnrichedSuccess failed: ${error.message}`);
    }
}

/**
 * Mark tracks as "gave up" — they hit MAX_LASTFM_ATTEMPTS without a clean
 * Last.fm response, so we stamp enriched_at to let them exit the worker queue
 * (and proceed to Wikidata) but RETAIN lastfm_last_error as the audit signal.
 *
 * Disambiguation:
 *   enriched_at NOT NULL  AND  lastfm_last_error NULL       -> success
 *   enriched_at NOT NULL  AND  lastfm_last_error NOT NULL   -> gave up
 *   enriched_at NULL                                        -> pending/retrying
 *
 * @param {string[]} spotifyIds
 * @param {object} [client]
 */
export async function markTracksGaveUp(spotifyIds, client = createAdminClient()) {
    if (spotifyIds.length === 0) return;

    const enrichedAt = new Date().toISOString();
    for (const batch of chunk(spotifyIds, QUERY_CHUNK)) {
        const { error } = await client
            .from("tracks")
            .update({ enriched_at: enrichedAt })
            .in("spotify_id", batch);
        if (error) throw new Error(`markTracksGaveUp failed: ${error.message}`);
    }
}

/**
 * Record a Last.fm enrichment failure on a single track. Atomically
 * increments lastfm_attempt_count, stores the latest error message, and
 * timestamps the attempt. Does NOT touch enriched_at — the caller decides
 * whether to stamp (give up) based on the returned new attempt count.
 *
 * Uses the record_lastfm_failure SECURITY DEFINER RPC (migration 0006) so
 * the UPDATE + RETURNING happens in a single round trip, which is needed for
 * the worker's "retry vs give up" decision branch.
 *
 * @param {string} spotifyId
 * @param {string} errorMessage  Trimmed; PostgreSQL text column has no length cap, but keep callers honest.
 * @param {object} [client]
 * @returns {Promise<number>}    New attempt count after this increment.
 */
export async function recordLastfmFailure(spotifyId, errorMessage, client = createAdminClient()) {
    const { data, error } = await client.rpc("record_lastfm_failure", {
        p_spotify_id: spotifyId,
        p_error_message: String(errorMessage ?? "").slice(0, 500),
    });
    if (error) throw new Error(`recordLastfmFailure(${spotifyId}) failed: ${error.message}`);
    return Number(data) || 0;
}

/**
 * Cron fallback query (lib/inngest/functions/track-enrich-cron.js).
 *
 * Returns spotify_ids of rows that are STILL unenriched AND were created at
 *
 * Uses the partial index tracks_unenriched_idx — the `created_at` filter is
 * a tablescan over only those (tiny) rows.
 *
 * @param {{olderThanMinutes?: number, limit?: number}} [opts]
 * @param {object} [client]
 * @returns {Promise<string[]>}
 */
export async function getStaleUnenrichedTrackIds(
    { olderThanMinutes = 30, limit = 500 } = {},
    client = createAdminClient(),
) {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
    const { data, error } = await client
        .from("tracks")
        .select("spotify_id")
        .is("enriched_at", null)
        .lt("created_at", cutoff)
        .limit(limit);
    if (error) throw new Error(`getStaleUnenrichedTrackIds failed: ${error.message}`);
    return data.map((r) => r.spotify_id);
}


// ---------------------------------------------------------------------------
// playlist_jobs — progress row for one /create submission.
// Migration: supabase/migrations/0003_playlist_jobs.sql
// The Inngest functions update these rows; the generating page polls them.
// ---------------------------------------------------------------------------

/**
 * Insert a fresh playlist_jobs row in status='queued'. The server action calls
 * this right before firing the Inngest event so the UI has an id to poll on.
 *
 * @param {string}   userId  Supabase auth UUID.
 * @param {string[]} tags    User's chosen tags (carried for a future selection algorithm).
 * @param {object}   [client]
 * @returns {Promise<string>} the new job id (uuid)
 */
export async function createPlaylistJob(userId, tags, client = createAdminClient()) {
    const { data, error } = await client
        .from("playlist_jobs")
        .insert({ user_id: userId, tags: tags ?? [] })
        .select("id")
        .single();
    if (error) throw new Error(`createPlaylistJob failed: ${error.message}`);
    return data.id;
}

/**
 * Generic UPDATE for non-counter fields: status transitions, error_message,
 * library_total set-once, completed_at, etc. Counters that race across workers
 * MUST go through incrementJobCounter instead — see migration 0003.
 *
 * @param {string} jobId
 * @param {object} patch  Any subset of playlist_jobs columns.
 * @param {object} [client]
 */
export async function updatePlaylistJob(jobId, patch, client = createAdminClient()) {
    const { error } = await client
        .from("playlist_jobs")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", jobId);
    if (error) throw new Error(`updatePlaylistJob failed: ${error.message}`);
}

/**
 * Atomic counter bump via the increment_job_counter RPC. Many trackEnrich runs
 * may try to bump enrich_done at once — let Postgres serialize it inside one
 * UPDATE statement so no increments are lost.
 *
 * @param {string} jobId
 * @param {"library_done"|"library_total"|"enrich_done"|"enrich_total"} column
 * @param {number} by  May be negative (e.g., correcting enrich_total after a no-op batch).
 * @param {object} [client]
 */
export async function incrementJobCounter(jobId, column, by = 1, client = createAdminClient()) {
    if (by === 0) return;
    const { error } = await client.rpc("increment_job_counter", {
        p_job: jobId,
        p_column: column,
        p_by: by,
    });
    if (error) throw new Error(`incrementJobCounter(${column}, ${by}) failed: ${error.message}`);
}

/**
 * Fetch one job scoped to a user. The /api/jobs/[id] route uses this. RLS
 * already enforces the user_id check from a user-context client; we also pass
 * user_id explicitly here as defense in depth since this is the service-role
 * client (which bypasses RLS).
 *
 * @param {string} jobId
 * @param {string} userId
 * @param {object} [client]
 * @returns {Promise<null | {
 *   id: string,
 *   status: string,
 *   library_total: number, library_done: number,
 *   enrich_total: number,  enrich_done: number,
 *   error_message: string | null,
 *   started_at: string, completed_at: string | null,
 * }>}
 */
// ---------------------------------------------------------------------------
// Wikidata (Layer 1 enrichment source #3)
//
// Mirrors the Last.fm helpers above but writes to track_tags_wikidata, which
// has a `property` column (genre / instrument / language / ...) instead of
// a `count` score. The wikidata_qid column on tracks is filled at the same
// time, and wikidata_enriched_at is flipped by markTracksWikidataEnriched
// AFTER both hits and misses so we never re-query a dead lookup.
//
// See lib/wikidata.js for the SPARQL helper that produces `wikidataPayload`.
// ---------------------------------------------------------------------------

// Maps the keys returned by lib/wikidata.js → enum values in the DB type
// public.wikidata_property. New properties: add a row here AND extend the
// enum in a migration. Keeping the map declarative makes adding a property
// a 3-line change instead of a code-flow change.
const WIKIDATA_PROPERTY_KEYS = [
    ["genres",         "genre"],
    ["instruments",    "instrument"],
    ["languages",      "language"],
    ["countries",      "country"],
    ["producers",      "producer"],
    ["recordLabels",   "record_label"],
    ["partOfSeries",   "part_of_series"],
];

/**
 * Resolve ISRCs for a batch of tracks that still need a Wikidata pass.
 *
 * Filters to rows where:
 *   - enriched_at IS NOT NULL  (Last.fm completed; sequential gate)
 *   - wikidata_enriched_at IS NULL
 *
 * The Wikidata worker calls this once per event to figure out which tracks
 * to query and what ISRC to use. Rows without an ISRC are still returned
 * (isrc: null) so the worker can mark them enriched-as-miss instead of
 * leaving them in the queue forever.
 *
 * @param {string[]} spotifyIds
 * @param {object} [client]
 * @returns {Promise<Array<{spotifyId: string, isrc: string | null}>>}
 */
export async function getTracksNeedingWikidata(spotifyIds, client = createAdminClient()) {
    if (spotifyIds.length === 0) return [];

    const out = [];
    for (const batch of chunk(spotifyIds, QUERY_CHUNK)) {
        const { data, error } = await client
            .from("tracks")
            .select("spotify_id, isrc")
            .in("spotify_id", batch)
            .not("enriched_at", "is", null)
            .is("wikidata_enriched_at", null);
        if (error) throw new Error(`getTracksNeedingWikidata failed: ${error.message}`);
        for (const row of data) {
            out.push({ spotifyId: row.spotify_id, isrc: row.isrc ?? null });
        }
    }
    return out;
}

/**
 * Write Wikidata tags + QID for ONE track.
 *
 * Pattern mirrors upsertLastfmTagsForTrack:
 *   1. Flatten payload into [{ name, property }] pairs and normalize names
 *      via normalizeTag (so "Rock", "rock", "Rock " all collapse to "rock").
 *   2. Atomic upsert into tags (CLAUDE.md §4: ON CONFLICT DO NOTHING, never
 *      SELECT-then-INSERT).
 *   3. Resolve track + tag PKs via SELECT.
 *   4. Atomic upsert into track_tags_wikidata.
 *   5. Update tracks.wikidata_qid (separate UPDATE — only fires if qid present).
 *
 * Called even on misses with payload === null? No — the worker short-circuits
 * misses before this helper, then still calls markTracksWikidataEnriched.
 *
 * @param {string} trackSpotifyId
 * @param {{ qid: string | null,
 *           genres: string[],
 *           instruments: string[],
 *           languages: string[],
 *           countries: string[],
 *           producers: string[],
 *           recordLabels: string[],
 *           partOfSeries: string[] }} wikidataPayload
 * @param {object} [client]
 */
export async function upsertWikidataTagsByIsrc(
    trackSpotifyId,
    wikidataPayload,
    client = createAdminClient(),
) {
    if (!wikidataPayload) return;

    // (1) Flatten + normalize + dedup. byKey: "name||property" → row payload.
    // Same name under two properties is allowed (e.g. "english" as both
    // language and country), so dedup key includes property.
    const byKey = new Map();
    for (const [payloadKey, propertyEnum] of WIKIDATA_PROPERTY_KEYS) {
        const values = wikidataPayload[payloadKey];
        if (!Array.isArray(values)) continue;
        for (const raw of values) {
            const norm = normalizeTag(raw);
            if (norm.length === 0) continue;
            byKey.set(`${norm}||${propertyEnum}`, { name: norm, property: propertyEnum });
        }
    }

    // Track lookup happens whether or not byKey is empty — we still need to
    // set wikidata_qid for a track that matched a Wikidata entity but had
    // zero of our extracted properties populated.
    const { data: trackRow, error: tErr } = await client
        .from("tracks")
        .select("id")
        .eq("spotify_id", trackSpotifyId)
        .maybeSingle();
    if (tErr) throw new Error(`upsertWikidataTagsByIsrc track lookup failed: ${tErr.message}`);
    if (!trackRow) return;

    // (5) Persist QID. Done early so that a partial failure in tag inserts
    // doesn't lose the QID (and so we don't re-resolve the same Wikidata
    // entity on retry).
    if (wikidataPayload.qid) {
        const { error } = await client
            .from("tracks")
            .update({ wikidata_qid: wikidataPayload.qid })
            .eq("spotify_id", trackSpotifyId);
        if (error) throw new Error(`upsertWikidataTagsByIsrc qid update failed: ${error.message}`);
    }

    if (byKey.size === 0) return;

    const uniqueNames = [...new Set([...byKey.values()].map((r) => r.name))];

    // (2) Ensure tag rows exist.
    for (const batch of chunk(uniqueNames.map((name) => ({ name })), QUERY_CHUNK)) {
        const { error } = await client
            .from("tags")
            .upsert(batch, { onConflict: "name", ignoreDuplicates: true });
        if (error) throw new Error(`upsertWikidataTagsByIsrc tag insert failed: ${error.message}`);
    }

    // (3) Resolve names → tag PKs.
    const tagIdMap = new Map();
    for (const batch of chunk(uniqueNames, QUERY_CHUNK)) {
        const { data, error } = await client
            .from("tags")
            .select("id, name")
            .in("name", batch);
        if (error) throw new Error(`upsertWikidataTagsByIsrc tag lookup failed: ${error.message}`);
        for (const row of data) tagIdMap.set(row.name, row.id);
    }

    // (4) Build junction rows.
    const rows = [...byKey.values()]
        .map(({ name, property }) => ({
            track_id: trackRow.id,
            tag_id: tagIdMap.get(name),
            property,
        }))
        .filter((r) => r.tag_id !== undefined);

    if (rows.length === 0) return;

    for (const batch of chunk(rows, QUERY_CHUNK)) {
        const { error } = await client
            .from("track_tags_wikidata")
            .upsert(batch, { onConflict: "track_id,tag_id,property", ignoreDuplicates: true });
        if (error) {
            throw new Error(`upsertWikidataTagsByIsrc junction insert failed: ${error.message}`);
        }
    }
}

/**
 * Flip wikidata_enriched_at = NOW() for ALL given spotify_ids — hits, misses,
 * and ISRC-less rows alike. Marking misses is the whole point: it keeps the
 * Wikidata worker queue (tracks_wikidata_pending_idx) draining instead of
 * re-querying dead lookups every cron tick.
 *
 * @param {string[]} spotifyIds
 * @param {object} [client]
 */
export async function markTracksWikidataEnriched(spotifyIds, client = createAdminClient()) {
    if (spotifyIds.length === 0) return;

    const enrichedAt = new Date().toISOString();
    for (const batch of chunk(spotifyIds, QUERY_CHUNK)) {
        const { error } = await client
            .from("tracks")
            .update({ wikidata_enriched_at: enrichedAt })
            .in("spotify_id", batch);
        if (error) throw new Error(`markTracksWikidataEnriched failed: ${error.message}`);
    }
}

/**
 * Backfill ISRC + MBID for one track and CLEAR the Wikidata enrichment flag.
 *
 * Why clear wikidata_enriched_at + wikidata_qid here? Because most of the
 * tracks that hit this code path were already processed by the Wikidata
 * worker WITHOUT an ISRC and marked enriched-as-miss. If we don't reset
 * those flags, the now-ISRC-bearing track would never be re-evaluated.
 * Resetting puts it back on the worker queue (tracks_wikidata_pending_idx)
 * so the next tracks/enrich-wikidata.requested event picks it up.
 *
 * Either field may be null — we only overwrite a column when its value is
 * non-null, except wikidata_qid (we always clear it to keep the row
 * consistent with the cleared flag).
 *
 * @param {string} spotifyId
 * @param {{ isrc?: string | null, mbid?: string | null }} payload
 * @param {object} [client]
 */
export async function updateTrackIsrcAndMbid(
    spotifyId,
    { isrc = null, mbid = null } = {},
    client = createAdminClient(),
) {
    if (!spotifyId) return;
    if (!isrc && !mbid) return; // Nothing to write.

    const patch = {
        // Reset Wikidata status so the worker re-evaluates this track.
        wikidata_enriched_at: null,
        wikidata_qid: null,
    };
    if (isrc) patch.isrc = isrc;
    if (mbid) patch.musicbrainz_recording_id = mbid;

    const { error } = await client
        .from("tracks")
        .update(patch)
        .eq("spotify_id", spotifyId);
    if (error) throw new Error(`updateTrackIsrcAndMbid failed: ${error.message}`);
}

/**
 * Find tracks still missing an ISRC. Used by library-backfill-isrc.
 *
 * Joined to user_library so we only return rows at least one user owns —
 * a track nobody saves anymore has no path to re-fetch its ISRC anyway.
 *
 * @param {{limit?: number}} [opts]
 * @param {object} [client]
 * @returns {Promise<Array<{spotifyId: string, userId: string}>>}
 *   One representative owner per track (Postgres picks; order undefined).
 */
export async function getTracksMissingIsrc(
    { limit = 500 } = {},
    client = createAdminClient(),
) {
    // PostgREST can't express "first owner per track" cleanly. Pull the
    // candidate tracks, then a separate lookup for owners. Two cheap
    // indexed queries beat trying to fold this into one.
    const { data: trackRows, error: tErr } = await client
        .from("tracks")
        .select("spotify_id, id")
        .is("isrc", null)
        .limit(limit);
    if (tErr) throw new Error(`getTracksMissingIsrc tracks query failed: ${tErr.message}`);
    if (!trackRows || trackRows.length === 0) return [];

    const idToSpotify = new Map(trackRows.map((r) => [r.id, r.spotify_id]));
    const { data: ownerRows, error: oErr } = await client
        .from("user_library")
        .select("track_id, user_id")
        .in("track_id", [...idToSpotify.keys()]);
    if (oErr) throw new Error(`getTracksMissingIsrc owners query failed: ${oErr.message}`);

    // First owner wins (arbitrary but deterministic per query).
    const firstOwner = new Map();
    for (const row of ownerRows ?? []) {
        if (!firstOwner.has(row.track_id)) firstOwner.set(row.track_id, row.user_id);
    }

    const out = [];
    for (const [trackId, spotifyId] of idToSpotify) {
        const userId = firstOwner.get(trackId);
        if (!userId) continue; // Orphaned track — no one owns it; skip.
        out.push({ spotifyId, userId });
    }
    return out;
}

export async function getPlaylistJob(jobId, userId, client = createAdminClient()) {
    const { data, error } = await client
        .from("playlist_jobs")
        .select(
            "id, status, library_total, library_done, enrich_total, enrich_done, error_message, started_at, completed_at",
        )
        .eq("id", jobId)
        .eq("user_id", userId)
        .maybeSingle();
    if (error) throw new Error(`getPlaylistJob failed: ${error.message}`);
    return data ?? null;
}
