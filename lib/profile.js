// Profile-page data layer.
//
// Aggregation lives in SQL (migration 0010) — these helpers just call the
// SECURITY INVOKER RPCs and the profiles read, then shape the result for the
// server component. Each RPC scopes itself to auth.uid(), so the caller never
// passes a user id into the query; we pass `userId` only to read the profile
// row and to keep the signature explicit.
//
// Pure derivation (rank tiers, the mainstream↔underground label) is exported
// separately so the page stays declarative.

// XP rank ladder. Ascending; the highest tier whose `min` is <= xp wins.
// Names lean into the record-curation theme rather than generic "Level N".
const RANKS = [
    { name: "Listener", min: 0 },
    { name: "Tastemaker", min: 10 },
    { name: "Curator", min: 50 },
    { name: "Archivist", min: 150 },
    { name: "Connoisseur", min: 400 },
    { name: "Aural Authority", min: 1000 },
];

/**
 * Resolve an XP total to its current rank and progress toward the next one.
 * Returns { name, min, next, toNext, progress } where progress is 0..1 across
 * the current tier (1 when maxed out).
 */
export function rankForXp(xp) {
    const x = Number.isFinite(xp) ? xp : 0;
    let idx = 0;
    for (let i = 0; i < RANKS.length; i++) {
        if (x >= RANKS[i].min) idx = i;
    }
    const current = RANKS[idx];
    const next = RANKS[idx + 1] ?? null;
    if (!next) {
        return { name: current.name, min: current.min, next: null, toNext: 0, progress: 1 };
    }
    const span = next.min - current.min;
    const into = Math.max(0, x - current.min);
    return {
        name: current.name,
        min: current.min,
        next,
        toNext: Math.max(0, next.min - x),
        progress: span > 0 ? Math.min(1, into / span) : 1,
    };
}

async function callRpc(client, fn, args = undefined) {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`${fn} failed: ${error.message}`);
    return data;
}

/**
 * Everything the /profile page needs, in one round of parallel queries.
 *
 * @param {object} client  user-scoped Supabase client (RLS enforced)
 * @param {string} userId  current auth user id (for the profile row read)
 */
export async function getProfilePageData(client, userId) {
    const [
        profileRows,
        overviewRows,
        tags,
        decades,
        xpRows,
        contribRows,
    ] = await Promise.all([
        client
            .from("profiles")
            .select("xp, spotify_user_id, created_at")
            .eq("id", userId)
            .single()
            .then(({ data, error }) => {
                if (error) throw new Error(`profiles read failed: ${error.message}`);
                return data;
            }),
        callRpc(client, "taste_overview"),
        callRpc(client, "taste_top_tags", { p_limit: 14 }),
        callRpc(client, "taste_decades"),
        callRpc(client, "xp_breakdown"),
        callRpc(client, "tagging_contribution"),
    ]);

    const overview = overviewRows?.[0] ?? {
        track_count: 0,
        artist_count: 0,
        total_duration_ms: 0,
    };
    const xp = xpRows?.[0] ?? {
        total: 0,
        as_author: 0,
        as_voter: 0,
        author_events: 0,
        voter_events: 0,
    };
    const contribution = contribRows?.[0] ?? { submitted: 0, graduated: 0 };

    return {
        profile: profileRows,
        overview: {
            trackCount: Number(overview.track_count),
            artistCount: Number(overview.artist_count),
            totalDurationMs: Number(overview.total_duration_ms),
        },
        tags: (tags ?? []).map((t) => ({
            tag: t.tag,
            weight: Number(t.weight),
        })),
        decades: (decades ?? []).map((d) => ({
            decade: Number(d.decade),
            count: Number(d.cnt),
        })),
        xp: {
            total: Number(xp.total),
            asAuthor: Number(xp.as_author),
            asVoter: Number(xp.as_voter),
            authorEvents: Number(xp.author_events),
            voterEvents: Number(xp.voter_events),
        },
        contribution: {
            submitted: Number(contribution.submitted),
            graduated: Number(contribution.graduated),
        },
    };
}
