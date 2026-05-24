// Layer 2 — community tagging helpers.
//
// Pattern: every helper takes an explicit `client` arg (no default). Writes
// must use the user-scoped client (lib/supabase/server.js -> createClient())
// so RLS enforces ownership; reads can use either client depending on whether
// the caller is a server action (user-scoped) or an Inngest worker / script
// (admin).
//
// See CLAUDE.md §6 for the rules these helpers encode:
//   * Identity = Supabase user (one vote per user per tag).
//   * Minimum confidence threshold gates community tags from search results.
//   * Vote weight by account age — handled by the user_tag_scores VIEW in SQL.
//   * Soft-delete only (`hidden = true`); no DELETE policy on user_tags.

import { normalizeTag } from "./library.js";

// PostgREST `?in=(...)` URLs get unwieldy past ~250 IDs.
const QUERY_CHUNK = 200;

// Postgres unique-violation SQLSTATE. Supabase surfaces this on `.code`.
const PG_UNIQUE_VIOLATION = "23505";

// Tag text length limits, measured AFTER normalize. 40 chars fits
// "instrumental hip hop" without inviting essays.
const MIN_TAG_LENGTH = 1;
const MAX_TAG_LENGTH = 40;

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

function toPositiveInt(value, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`${label} must be a positive integer (got ${value})`);
    }
    return n;
}

/**
 * Validate and normalize a raw tag string.
 *
 * Length is checked AFTER normalizeTag() (lowercase, NFD diacritical stripping,
 * punctuation removal, whitespace collapse) — so the limit measures the
 * canonical form, not the raw input. This means "  CHILL!!  " (10 chars)
 * normalizes to "chill" (5 chars) and passes.
 *
 * @param {unknown} raw
 * @returns {{ok: true, normalized: string} | {ok: false, error: string}}
 */
export function validateTagInput(raw) {
    const normalized = normalizeTag(raw);
    if (normalized.length < MIN_TAG_LENGTH) {
        return { ok: false, error: "tag_empty" };
    }
    if (normalized.length > MAX_TAG_LENGTH) {
        return { ok: false, error: "tag_too_long" };
    }
    return { ok: true, normalized };
}

/**
 * Ensure a row exists in `tags` for the (already-normalized) name and return
 * its bigint id. Atomic per CLAUDE.md §4: INSERT ... ON CONFLICT DO NOTHING
 * then SELECT — never SELECT-then-INSERT.
 *
 * Caller must pass a name that has already been through normalizeTag(). This
 * helper does NOT re-normalize, so it cannot accidentally insert a duplicate
 * variant if the caller forgot to normalize first.
 *
 * @param {object} client          Supabase client (any role).
 * @param {string} normalizedName  Output of normalizeTag(), non-empty.
 * @returns {Promise<number>}      Tag bigint id.
 */
export async function getOrCreateTagId(client, normalizedName) {
    if (!normalizedName) throw new Error("getOrCreateTagId: normalizedName is empty");

    const { error: upsertErr } = await client
        .from("tags")
        .upsert({ name: normalizedName }, { onConflict: "name", ignoreDuplicates: true });
    if (upsertErr) throw new Error(`getOrCreateTagId upsert failed: ${upsertErr.message}`);

    const { data, error: selErr } = await client
        .from("tags")
        .select("id")
        .eq("name", normalizedName)
        .single();
    if (selErr) throw new Error(`getOrCreateTagId select failed: ${selErr.message}`);
    return data.id;
}

/**
 * Insert a user_tags row. Idempotent: if the user has already submitted the
 * same (track_id, tag_id), the existing row's id is returned instead of
 * raising — the UNIQUE constraint is the source of truth, not a JS pre-check.
 *
 * @param {object} client
 * @param {{trackId: number, tagId: number, userId: string}} params
 * @returns {Promise<{userTagId: number, created: boolean}>}
 *          `created` is true iff this call inserted; false iff the row already existed.
 */
export async function insertUserTag(client, { trackId, tagId, userId }) {
    toPositiveInt(trackId, "trackId");
    toPositiveInt(tagId, "tagId");
    if (!userId) throw new Error("insertUserTag: userId is required");

    const { data, error } = await client
        .from("user_tags")
        .insert({ track_id: trackId, tag_id: tagId, submitted_by: userId })
        .select("id")
        .single();

    if (!error) return { userTagId: data.id, created: true };

    // 23505 = unique violation. The user has already submitted this exact tag
    // on this track — look up the existing row and return it.
    if (error.code === PG_UNIQUE_VIOLATION) {
        const { data: existing, error: selErr } = await client
            .from("user_tags")
            .select("id")
            .eq("track_id", trackId)
            .eq("tag_id", tagId)
            .eq("submitted_by", userId)
            .single();
        if (selErr) throw new Error(`insertUserTag re-select failed: ${selErr.message}`);
        return { userTagId: existing.id, created: false };
    }

    throw new Error(`insertUserTag failed: ${error.message}`);
}

/**
 * Set the calling user's vote on a user_tag. Idempotent on direction:
 * re-voting +1 over an existing +1 is a no-op; voting -1 over an existing +1
 * flips it in one statement via the UNIQUE (user_tag_id, voter_id) constraint.
 *
 * @param {object} client
 * @param {{userTagId: number, voterId: string, vote: 1 | -1}} params
 */
export async function setVote(client, { userTagId, voterId, vote }) {
    toPositiveInt(userTagId, "userTagId");
    if (!voterId) throw new Error("setVote: voterId is required");
    if (vote !== 1 && vote !== -1) {
        throw new Error(`setVote: vote must be 1 or -1 (got ${vote})`);
    }

    const { error } = await client
        .from("tag_votes")
        .upsert(
            { user_tag_id: userTagId, voter_id: voterId, vote },
            { onConflict: "user_tag_id,voter_id" },
        );
    if (error) throw new Error(`setVote failed: ${error.message}`);
}

/**
 * Remove the calling user's vote on a user_tag. No-op if no vote exists.
 *
 * @param {object} client
 * @param {{userTagId: number, voterId: string}} params
 */
export async function clearVote(client, { userTagId, voterId }) {
    toPositiveInt(userTagId, "userTagId");
    if (!voterId) throw new Error("clearVote: voterId is required");

    const { error } = await client
        .from("tag_votes")
        .delete()
        .eq("user_tag_id", userTagId)
        .eq("voter_id", voterId);
    if (error) throw new Error(`clearVote failed: ${error.message}`);
}

/**
 * Soft-delete a user_tag the calling user submitted. RLS already blocks
 * updates on rows the user didn't submit; the explicit submitted_by predicate
 * is defense-in-depth and lets admin-client callers enforce the same scope.
 *
 * @param {object} client
 * @param {{userTagId: number, userId: string}} params
 */
export async function hideOwnUserTag(client, { userTagId, userId }) {
    toPositiveInt(userTagId, "userTagId");
    if (!userId) throw new Error("hideOwnUserTag: userId is required");

    const { error } = await client
        .from("user_tags")
        .update({ hidden: true })
        .eq("id", userTagId)
        .eq("submitted_by", userId);
    if (error) throw new Error(`hideOwnUserTag failed: ${error.message}`);
}

async function fetchTagNames(client, tagIds) {
    const out = new Map();
    if (tagIds.length === 0) return out;
    for (const batch of chunk(tagIds, QUERY_CHUNK)) {
        const { data, error } = await client
            .from("tags")
            .select("id, name")
            .in("id", batch);
        if (error) throw new Error(`fetchTagNames failed: ${error.message}`);
        for (const row of data) out.set(row.id, row.name);
    }
    return out;
}

async function fetchCurrentUserVotes(client, userTagIds, currentUserId) {
    const out = new Map();
    if (!currentUserId || userTagIds.length === 0) return out;
    for (const batch of chunk(userTagIds, QUERY_CHUNK)) {
        const { data, error } = await client
            .from("tag_votes")
            .select("user_tag_id, vote")
            .eq("voter_id", currentUserId)
            .in("user_tag_id", batch);
        if (error) throw new Error(`fetchCurrentUserVotes failed: ${error.message}`);
        for (const row of data) out.set(row.user_tag_id, row.vote);
    }
    return out;
}

function buildTagEntry(row, tagNameById, voteByUserTagId) {
    return {
        userTagId: row.user_tag_id,
        tagId: row.tag_id,
        tagName: tagNameById.get(row.tag_id) ?? null,
        submittedBy: row.submitted_by,
        score: Number(row.score),
        voteCount: Number(row.vote_count),
        currentUserVote: voteByUserTagId.get(row.user_tag_id) ?? 0,
    };
}

function sortTagsByScore(tags) {
    tags.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const an = a.tagName ?? "";
        const bn = b.tagName ?? "";
        return an.localeCompare(bn);
    });
}

/**
 * Visible community tags for one track, filtered by score threshold.
 *
 * Default threshold of 2 matches CLAUDE.md §6 ("upvotes − downvotes ≥ 2"). The
 * filter happens at the view level so below-threshold tags are never shipped
 * to the client — they exist but stay private until they accumulate confidence.
 *
 * Returns an array sorted by score desc, then by tag name for stable order.
 *
 * @param {object} client
 * @param {{trackId: number, currentUserId?: string|null, threshold?: number}} params
 */
export async function getCommunityTagsForTrack(
    client,
    { trackId, currentUserId = null, threshold = 2 },
) {
    toPositiveInt(trackId, "trackId");

    const { data: scoreRows, error } = await client
        .from("user_tag_scores")
        .select("user_tag_id, track_id, tag_id, submitted_by, hidden, score, vote_count")
        .eq("track_id", trackId)
        .eq("hidden", false)
        .gte("score", threshold);
    if (error) throw new Error(`getCommunityTagsForTrack failed: ${error.message}`);
    if (scoreRows.length === 0) return [];

    const tagIds = [...new Set(scoreRows.map((r) => r.tag_id))];
    const userTagIds = scoreRows.map((r) => r.user_tag_id);

    const [tagNameById, voteByUserTagId] = await Promise.all([
        fetchTagNames(client, tagIds),
        fetchCurrentUserVotes(client, userTagIds, currentUserId),
    ]);

    const out = scoreRows.map((r) => buildTagEntry(r, tagNameById, voteByUserTagId));
    sortTagsByScore(out);
    return out;
}

/**
 * Batched version of getCommunityTagsForTrack. Returns a Map keyed by
 * track_id. Tracks with no above-threshold tags are absent from the map (not
 * present with an empty array), so callers should `?? []` on lookup.
 *
 * @param {object} client
 * @param {{trackIds: number[], currentUserId?: string|null, threshold?: number}} params
 * @returns {Promise<Map<number, Array<object>>>}
 */
export async function getCommunityTagsForTracks(
    client,
    { trackIds, currentUserId = null, threshold = 2 },
) {
    if (!Array.isArray(trackIds) || trackIds.length === 0) return new Map();
    for (const id of trackIds) toPositiveInt(id, "trackIds[]");

    const allRows = [];
    for (const batch of chunk(trackIds, QUERY_CHUNK)) {
        const { data, error } = await client
            .from("user_tag_scores")
            .select("user_tag_id, track_id, tag_id, submitted_by, hidden, score, vote_count")
            .in("track_id", batch)
            .eq("hidden", false)
            .gte("score", threshold);
        if (error) throw new Error(`getCommunityTagsForTracks failed: ${error.message}`);
        for (const row of data) allRows.push(row);
    }
    if (allRows.length === 0) return new Map();

    const tagIds = [...new Set(allRows.map((r) => r.tag_id))];
    const userTagIds = allRows.map((r) => r.user_tag_id);
    const [tagNameById, voteByUserTagId] = await Promise.all([
        fetchTagNames(client, tagIds),
        fetchCurrentUserVotes(client, userTagIds, currentUserId),
    ]);

    const byTrack = new Map();
    for (const row of allRows) {
        const entry = buildTagEntry(row, tagNameById, voteByUserTagId);
        const list = byTrack.get(row.track_id);
        if (list) list.push(entry);
        else byTrack.set(row.track_id, [entry]);
    }
    for (const list of byTrack.values()) sortTagsByScore(list);
    return byTrack;
}

/**
 * The calling user's own submissions on a track, REGARDLESS of score or
 * hidden state. Lets the UI distinguish "I submitted this, it's pending more
 * votes" from "I submitted this, then hid it" from "I haven't submitted X yet".
 *
 * @param {object} client
 * @param {{trackId: number, currentUserId: string}} params
 */
export async function getOwnSubmissionsForTrack(client, { trackId, currentUserId }) {
    toPositiveInt(trackId, "trackId");
    if (!currentUserId) throw new Error("getOwnSubmissionsForTrack: currentUserId is required");

    const { data: ownRows, error } = await client
        .from("user_tags")
        .select("id, tag_id, hidden, created_at")
        .eq("track_id", trackId)
        .eq("submitted_by", currentUserId);
    if (error) throw new Error(`getOwnSubmissionsForTrack failed: ${error.message}`);
    if (ownRows.length === 0) return [];

    const tagIds = [...new Set(ownRows.map((r) => r.tag_id))];
    const userTagIds = ownRows.map((r) => r.id);

    const tagNameById = await fetchTagNames(client, tagIds);

    // Pull scores for the user's own rows from the same view, but with NO
    // threshold filter — we want to surface zero-score submissions
    // ("waiting for votes") in the UI.
    const scoresById = new Map();
    for (const batch of chunk(userTagIds, QUERY_CHUNK)) {
        const { data, error: sErr } = await client
            .from("user_tag_scores")
            .select("user_tag_id, score, vote_count")
            .in("user_tag_id", batch);
        if (sErr) throw new Error(`getOwnSubmissionsForTrack scores failed: ${sErr.message}`);
        for (const row of data) scoresById.set(row.user_tag_id, row);
    }

    return ownRows
        .map((r) => {
            const scoreRow = scoresById.get(r.id);
            return {
                userTagId: r.id,
                tagId: r.tag_id,
                tagName: tagNameById.get(r.tag_id) ?? null,
                hidden: r.hidden,
                createdAt: r.created_at,
                score: scoreRow ? Number(scoreRow.score) : 0,
                voteCount: scoreRow ? Number(scoreRow.vote_count) : 0,
            };
        })
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
