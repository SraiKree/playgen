"use server";

// Layer 2 — server actions for community tagging.
//
// Lives at app/library/actions.js so it co-locates with the future /library
// page (the page is out of scope for this pass — see plan file). All actions
// verify the user via supabase.auth.getUser(), which validates the JWT against
// Supabase's auth server. We deliberately do NOT use getSession() here:
// per-write trust decisions deserve the server-verified path, even though it
// costs an extra round trip.
//
// RLS does the actual ownership enforcement; we pass user.id to the helpers
// for defense-in-depth and so the helpers stay reusable from admin-client
// callers (scripts, Inngest functions) where RLS doesn't apply.

import { createClient } from "@/lib/supabase/server";
import {
    validateTagInput,
    getOrCreateTagId,
    insertUserTag,
    setVote,
    clearVote,
    hideOwnUserTag,
} from "@/lib/community";

async function getCurrentUser() {
    const supabase = await createClient();
    const {
        data: { user },
        error,
    } = await supabase.auth.getUser();
    if (error || !user) return { supabase, user: null };
    return { supabase, user };
}

function parsePositiveInt(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Submit a tag on a track. Idempotent at the row level: re-submitting the
 * same tag on the same track returns the existing user_tag id without
 * erroring (UNIQUE constraint catches it; insertUserTag re-selects).
 *
 * @param {number|string} trackId   tracks.id (bigint, passed from the UI).
 * @param {string} tagText          Raw user input — normalized + length-checked here.
 */
export async function submitTrackTag(trackId, tagText) {
    const { supabase, user } = await getCurrentUser();
    if (!user) return { ok: false, error: "not_authenticated" };

    const trackIdNum = parsePositiveInt(trackId);
    if (trackIdNum === null) return { ok: false, error: "invalid_track_id" };

    const validated = validateTagInput(tagText);
    if (!validated.ok) return { ok: false, error: validated.error };

    try {
        const tagId = await getOrCreateTagId(supabase, validated.normalized);
        const { userTagId, created } = await insertUserTag(supabase, {
            trackId: trackIdNum,
            tagId,
            userId: user.id,
        });
        return {
            ok: true,
            userTagId,
            tagId,
            tagName: validated.normalized,
            created,
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Vote +1 or -1 on a community tag. Re-voting in the same direction is a
 * no-op at the DB level; flipping replaces the existing row.
 */
export async function voteOnTag(userTagId, direction) {
    const { supabase, user } = await getCurrentUser();
    if (!user) return { ok: false, error: "not_authenticated" };

    const idNum = parsePositiveInt(userTagId);
    if (idNum === null) return { ok: false, error: "invalid_user_tag_id" };
    if (direction !== 1 && direction !== -1) {
        return { ok: false, error: "invalid_direction" };
    }

    try {
        await setVote(supabase, { userTagId: idNum, voterId: user.id, vote: direction });
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Remove the calling user's vote on a tag. No-op if no vote exists.
 */
export async function clearVoteOnTag(userTagId) {
    const { supabase, user } = await getCurrentUser();
    if (!user) return { ok: false, error: "not_authenticated" };

    const idNum = parsePositiveInt(userTagId);
    if (idNum === null) return { ok: false, error: "invalid_user_tag_id" };

    try {
        await clearVote(supabase, { userTagId: idNum, voterId: user.id });
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Soft-delete the calling user's own submission. Audit trail preserved per
 * CLAUDE.md §6 — no hard-delete policy on user_tags.
 */
export async function hideOwnTag(userTagId) {
    const { supabase, user } = await getCurrentUser();
    if (!user) return { ok: false, error: "not_authenticated" };

    const idNum = parsePositiveInt(userTagId);
    if (idNum === null) return { ok: false, error: "invalid_user_tag_id" };

    try {
        await hideOwnUserTag(supabase, { userTagId: idNum, userId: user.id });
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}
