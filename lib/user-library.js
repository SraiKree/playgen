// User-context reads against the user's saved library. Distinct from
// lib/library.js, which is service-role / Inngest-only: helpers here take an
// EXPLICIT user-scoped Supabase client so RLS scopes the result set.
//
// Used by app/library/page.js to render the tagging surface (Layer 2 UI) plus
// the Layer 1 reference tags (Last.fm + Wikidata) shown next to each row.

const DEFAULT_PAGE_SIZE = 50;

// PostgREST `?in=(...)` URLs get unwieldy past ~250 IDs.
const QUERY_CHUNK = 200;

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

/**
 * One page of the current user's saved tracks.
 *
 * Sort orders
 *   "top_tag" (default) — pages via user_library_with_top_tag (migration
 *     0008), ordered by top_lastfm_tag (nulls last), then added_at desc. This
 *     clusters genre-adjacent tracks together across pages so the user can
 *     scroll through one tag bucket at a time.
 *   "newest"            — pages via user_library directly, ordered by added_at
 *     desc. Kept for callers that want the original Spotify-like order.
 *
 * Implementation
 *   Two round trips, regardless of sort:
 *     1) page-of-(track_id, added_at, top_lastfm_tag) from the view/table.
 *     2) tracks + track_artists for those track_ids in a single embedded
 *        select.
 *   We stitch the two by track_id, preserving the page-1 ordering. We can't
 *   do this as a single PostgREST query because the view doesn't expose the
 *   FK to tracks in a way PostgREST embedding auto-detects.
 *
 * @param {object} client
 * @param {{userId: string, limit?: number, offset?: number, sort?: "top_tag"|"newest"}} params
 */
export async function getUserSavedTracks(
    client,
    { userId, limit = DEFAULT_PAGE_SIZE, offset = 0, sort = "top_tag" } = {},
) {
    if (!userId) throw new Error("getUserSavedTracks: userId is required");

    // Step 1: page-of-keys from either the sorting view or the bare table.
    const source = sort === "newest" ? "user_library" : "user_library_with_top_tag";
    const selectCols =
        sort === "newest"
            ? "track_id, added_at"
            : "track_id, added_at, top_lastfm_tag, top_lastfm_count";

    let pageQuery = client
        .from(source)
        .select(selectCols, { count: "exact" })
        .eq("user_id", userId);

    if (sort === "newest") {
        pageQuery = pageQuery.order("added_at", { ascending: false });
    } else {
        // nullsFirst:false → tracks with no Last.fm tags drop to the tail of
        // the listing instead of polluting the first page.
        pageQuery = pageQuery
            .order("top_lastfm_tag", { ascending: true, nullsFirst: false })
            .order("added_at", { ascending: false });
    }

    const {
        data: pageRows,
        count,
        error,
    } = await pageQuery.range(offset, offset + limit - 1);

    if (error) throw new Error(`getUserSavedTracks page failed: ${error.message}`);

    const totalCount = count ?? 0;
    if (!pageRows || pageRows.length === 0) {
        return { tracks: [], totalCount };
    }

    // Step 2: fetch tracks + artists in a single embedded select.
    const trackIds = pageRows.map((r) => r.track_id);
    const { data: trackRows, error: trackErr } = await client
        .from("tracks")
        .select(
            `
            id,
            spotify_id,
            name,
            album_name,
            album_image_url,
            duration_ms,
            track_artists (
              position,
              artist:artists ( name )
            )
            `,
        )
        .in("id", trackIds);
    if (trackErr) {
        throw new Error(`getUserSavedTracks tracks failed: ${trackErr.message}`);
    }

    const trackById = new Map((trackRows ?? []).map((r) => [r.id, r]));

    const tracks = pageRows
        .map((p) => {
            const t = trackById.get(p.track_id);
            if (!t) return null; // defensive — RLS/FK cascade make this unreachable
            const artistsLine = (t.track_artists ?? [])
                .slice()
                .sort((a, b) => a.position - b.position)
                .map((ta) => ta.artist?.name)
                .filter(Boolean)
                .join(", ");
            return {
                trackId: t.id,
                spotifyId: t.spotify_id,
                name: t.name,
                albumName: t.album_name,
                albumImageUrl: t.album_image_url,
                durationMs: t.duration_ms,
                addedAt: p.added_at,
                // Only populated under the default sort; null otherwise.
                topLastfmTag: p.top_lastfm_tag ?? null,
                artistsLine,
            };
        })
        .filter(Boolean);

    return { tracks, totalCount };
}

/**
 * Batched fetch of Layer 1 reference tags for a set of track ids.
 *
 * Returns a Map keyed by track_id. Each entry has:
 *   lastfm:   [{ name, count }]                — sorted by count desc, then name
 *   wikidata: [{ name, property }]             — sorted by property, then name
 *
 * Tracks with no Layer 1 tags are ABSENT from the map (no zero-value entry),
 * so callers should `?? { lastfm: [], wikidata: [] }` on lookup.
 *
 * @param {object} client
 * @param {number[]} trackIds
 */
export async function getLayer1TagsForTracks(client, trackIds) {
    const out = new Map();
    if (!Array.isArray(trackIds) || trackIds.length === 0) return out;

    for (const batch of chunk(trackIds, QUERY_CHUNK)) {
        const [lastfmRes, wikiRes] = await Promise.all([
            client
                .from("track_tags_lastfm")
                .select("track_id, lastfm_count, tag:tags ( name )")
                .in("track_id", batch),
            client
                .from("track_tags_wikidata")
                .select("track_id, property, tag:tags ( name )")
                .in("track_id", batch),
        ]);
        if (lastfmRes.error) {
            throw new Error(
                `getLayer1TagsForTracks lastfm failed: ${lastfmRes.error.message}`,
            );
        }
        if (wikiRes.error) {
            throw new Error(
                `getLayer1TagsForTracks wikidata failed: ${wikiRes.error.message}`,
            );
        }

        for (const row of lastfmRes.data ?? []) {
            const entry =
                out.get(row.track_id) ?? { lastfm: [], wikidata: [] };
            entry.lastfm.push({
                name: row.tag?.name ?? null,
                count: row.lastfm_count,
            });
            out.set(row.track_id, entry);
        }
        for (const row of wikiRes.data ?? []) {
            const entry =
                out.get(row.track_id) ?? { lastfm: [], wikidata: [] };
            entry.wikidata.push({
                name: row.tag?.name ?? null,
                property: row.property,
            });
            out.set(row.track_id, entry);
        }
    }

    for (const entry of out.values()) {
        entry.lastfm.sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            return (a.name ?? "").localeCompare(b.name ?? "");
        });
        entry.wikidata.sort((a, b) => {
            const p = a.property.localeCompare(b.property);
            if (p !== 0) return p;
            return (a.name ?? "").localeCompare(b.name ?? "");
        });
    }
    return out;
}

/**
 * Format a Spotify duration_ms value as "M:SS". Returns "" for null/0.
 */
export function formatDuration(durationMs) {
    if (!durationMs) return "";
    const total = Math.round(durationMs / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
}
