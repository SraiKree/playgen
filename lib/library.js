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
