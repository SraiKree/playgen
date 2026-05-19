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
 *
 * @param {string[]} spotifyIds
 * @param {object} [client]
 */
export async function markTracksEnriched(spotifyIds, client = createAdminClient()) {
    if (spotifyIds.length === 0) return;

    const enrichedAt = new Date().toISOString();
    for (const batch of chunk(spotifyIds, QUERY_CHUNK)) {
        const { error } = await client
            .from("tracks")
            .update({ enriched_at: enrichedAt })
            .in("spotify_id", batch);
        if (error) throw new Error(`markTracksEnriched failed: ${error.message}`);
    }
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
