"use client";

// One row of the /library track list. Collapsed state shows artwork + title +
// artist + a few top community-tag chips plus a hint at any suggested tags.
// Clicking the row toggles an expanded drawer that surfaces the Layer 2
// tagging UI (CLAUDE.md §6):
//
//   - Add-a-tag input (server action: submitTrackTag)
//   - "Suggested tags" — every below-threshold tag from ANY user, score desc,
//     with up/down vote arrows. This is where new tags accumulate the votes
//     they need to graduate; surfacing them to everyone (not just the
//     submitter) is what breaks the chicken-and-egg bootstrap problem. No
//     rejection — negative-score tags stay listed.
//   - Community tags list (score ≥ threshold) with up/down vote arrows
//     (server actions: voteOnTag / clearVoteOnTag). A tag crossing the
//     threshold graduates here on the next refresh and starts counting toward
//     playlist generation.
//   - Hide-your-own-tag button (server action: hideOwnTag)
//
// All writes use useTransition + router.refresh() so the server component
// re-fetches authoritative community state after each action. This is
// intentionally simpler than useOptimistic — vote-state is global, not
// per-client, and we'd rather show the real number than guess. The one local
// touch: a just-submitted tag is shown immediately (score 0) until the refresh
// lands it in the server-driven suggested list.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
    submitTrackTag,
    voteOnTag,
    clearVoteOnTag,
    hideOwnTag,
} from "@/app/library/actions";

const MAX_INLINE_COMMUNITY = 2;
const MAX_INLINE_LASTFM = 3;
const MAX_INLINE_SUGGESTED = 1;
const TAG_INPUT_MAX = 60; // generous; validateTagInput caps the normalized form at 40 server-side

// Pretty labels for the Wikidata property enum. Keys mirror the enum values
// declared in migration 0004.
const WIKIDATA_PROPERTY_LABEL = {
    genre: "Genre",
    instrument: "Instrument",
    language: "Language",
    country: "Country",
    producer: "Producer",
    record_label: "Label",
    part_of_series: "Series",
};

// Server actions return short error codes; map to user-facing copy here.
function humanizeError(code) {
    switch (code) {
        case "not_authenticated":
            return "Please sign in again.";
        case "invalid_track_id":
            return "This track is no longer in your library.";
        case "invalid_user_tag_id":
            return "That tag is no longer available.";
        case "invalid_direction":
            return "Invalid vote direction.";
        case "tag_empty":
            return "Type a tag first.";
        case "tag_too_long":
            return "Tag is too long (40 characters max after cleanup).";
        default:
            return code || "Something went wrong. Try again.";
    }
}

export function LibraryTrackRow({
    track,
    communityTags,
    suggestedTags = [],
    layer1Tags = { lastfm: [], wikidata: [] },
    currentUserId,
}) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [expanded, setExpanded] = useState(false);
    const [tagInput, setTagInput] = useState("");
    const [errorMsg, setErrorMsg] = useState(null);

    // A just-submitted tag is a real DB row (we have its userTagId) but sits at
    // score 0 — below threshold — so it belongs in the suggested list. Until
    // router.refresh() refetches and the server includes it in `suggestedTags`,
    // we show it locally so the user sees their tag land immediately.
    const [justSubmitted, setJustSubmitted] = useState([]);
    // Locally hidden tags so a chip disappears immediately on click without
    // waiting for the refresh round-trip. Applies to both server-driven and
    // just-submitted suggested entries.
    const [locallyHidden, setLocallyHidden] = useState(new Set());

    function runAction(actionFn) {
        setErrorMsg(null);
        startTransition(async () => {
            const res = await actionFn();
            if (!res?.ok) {
                setErrorMsg(humanizeError(res?.error));
                return;
            }
            router.refresh();
        });
    }

    function handleSubmit(event) {
        event.preventDefault();
        const text = tagInput.trim();
        if (!text) return;

        setErrorMsg(null);
        startTransition(async () => {
            const res = await submitTrackTag(track.trackId, text);
            if (!res.ok) {
                setErrorMsg(humanizeError(res.error));
                return;
            }

            // If the tag is already a community chip (above threshold) or
            // already in the server suggested list, the refresh alone will
            // surface it — no need to track it locally. Otherwise hold it in
            // justSubmitted so it appears immediately at score 0.
            const alreadyShown =
                communityTags.some((c) => c.tagName === res.tagName) ||
                suggestedTags.some((s) => s.userTagId === res.userTagId);
            if (!alreadyShown) {
                setJustSubmitted((prev) =>
                    prev.some((p) => p.userTagId === res.userTagId)
                        ? prev
                        : [
                              ...prev,
                              { userTagId: res.userTagId, tagName: res.tagName },
                          ],
                );
            }
            setTagInput("");
            router.refresh();
        });
    }

    function handleVote(userTagId, direction, currentUserVote) {
        runAction(() =>
            currentUserVote === direction
                ? clearVoteOnTag(userTagId)
                : voteOnTag(userTagId, direction),
        );
    }

    // Hide one of the user's own tags. Optimistically removes the chip, then
    // calls the server; rolls back on failure. Works for both community and
    // suggested entries since both are real user_tags rows.
    function handleHideOwnTag(userTagId) {
        setErrorMsg(null);
        setLocallyHidden((prev) => new Set(prev).add(userTagId));
        startTransition(async () => {
            const res = await hideOwnTag(userTagId);
            if (!res?.ok) {
                setLocallyHidden((prev) => {
                    const next = new Set(prev);
                    next.delete(userTagId);
                    return next;
                });
                setErrorMsg(humanizeError(res?.error));
                return;
            }
            router.refresh();
        });
    }

    // The suggested list shown to the user: server-driven below-threshold tags,
    // plus any just-submitted ones the refresh hasn't picked up yet, minus
    // anything hidden this session. Re-sorted score desc, then name asc, to
    // match the server ordering when optimistic entries are mixed in.
    const communityNames = new Set(communityTags.map((c) => c.tagName));
    const serverSuggestedIds = new Set(suggestedTags.map((s) => s.userTagId));
    const optimisticSuggested = justSubmitted
        .filter(
            (p) =>
                !serverSuggestedIds.has(p.userTagId) &&
                !communityNames.has(p.tagName),
        )
        .map((p) => ({
            userTagId: p.userTagId,
            tagId: null,
            tagName: p.tagName,
            submittedBy: currentUserId,
            score: 0,
            voteCount: 0,
            currentUserVote: 0,
        }));
    const visibleSuggested = [...suggestedTags, ...optimisticSuggested]
        .filter((s) => !locallyHidden.has(s.userTagId))
        .sort((a, b) =>
            b.score !== a.score
                ? b.score - a.score
                : (a.tagName ?? "").localeCompare(b.tagName ?? ""),
        );

    // Inline chip strategy: lead with up to 2 community chips (accent, the
    // active signal), then fill with up to 3 Last.fm chips (muted, the
    // reference signal), then hint at 1 suggested tag (dashed, "vote me").
    // Anything beyond gets folded into "+N" / "+N suggested" indicators.
    const inlineCommunity = communityTags.slice(0, MAX_INLINE_COMMUNITY);
    const inlineLastfm = layer1Tags.lastfm.slice(0, MAX_INLINE_LASTFM);
    const inlineSuggested = visibleSuggested.slice(0, MAX_INLINE_SUGGESTED);
    const moreSuggestedCount = visibleSuggested.length - inlineSuggested.length;
    const hiddenChipCount =
        communityTags.length -
        inlineCommunity.length +
        layer1Tags.lastfm.length -
        inlineLastfm.length;
    const hasAnyInline =
        inlineCommunity.length > 0 ||
        inlineLastfm.length > 0 ||
        inlineSuggested.length > 0;

    // Wikidata: group by property for the drawer section.
    const wikidataByProperty = new Map();
    for (const w of layer1Tags.wikidata) {
        const list = wikidataByProperty.get(w.property);
        if (list) list.push(w.name);
        else wikidataByProperty.set(w.property, [w.name]);
    }

    return (
        <li className="border-b border-border last:border-b-0">
            <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                aria-expanded={expanded}
                className="grid w-full grid-cols-[40px_1fr_auto] items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-surface sm:grid-cols-[40px_minmax(0,1fr)_auto_24px] sm:gap-4 sm:px-4"
            >
                {track.albumImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={track.albumImageUrl}
                        alt=""
                        className="h-10 w-10 flex-shrink-0 rounded object-cover"
                        loading="lazy"
                    />
                ) : (
                    <div
                        aria-hidden
                        className="h-10 w-10 flex-shrink-0 rounded bg-surface-strong"
                    />
                )}

                <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                        {track.name}
                    </p>
                    <p className="truncate text-xs text-foreground-muted">
                        {track.artistsLine || "Unknown artist"}
                    </p>
                </div>

                <div className="hidden items-center gap-1.5 sm:flex">
                    {inlineCommunity.map((c) => (
                        <span
                            key={`c-${c.userTagId}`}
                            title="Community tag"
                            className="inline-flex items-center rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent"
                        >
                            {c.tagName}
                        </span>
                    ))}
                    {inlineLastfm.map((l) => (
                        <span
                            key={`l-${l.name}`}
                            title="Last.fm reference tag"
                            className="inline-flex items-center rounded-full border border-border bg-background px-2 py-0.5 text-xs text-foreground-muted"
                        >
                            {l.name}
                        </span>
                    ))}
                    {hiddenChipCount > 0 && (
                        <span className="text-xs tabular text-foreground-subtle">
                            +{hiddenChipCount}
                        </span>
                    )}
                    {inlineSuggested.map((s) => (
                        <span
                            key={`s-${s.userTagId}`}
                            title="Suggested tag — open the row to vote"
                            className="inline-flex items-center gap-1 rounded-full border border-dashed border-border-strong px-2 py-0.5 text-xs text-foreground-muted"
                        >
                            {s.tagName}
                            <span className="tabular text-foreground-subtle">
                                {s.score}
                            </span>
                        </span>
                    ))}
                    {moreSuggestedCount > 0 && (
                        <span className="text-xs tabular text-foreground-subtle">
                            +{moreSuggestedCount} suggested
                        </span>
                    )}
                    {!hasAnyInline && (
                        <span className="text-xs text-foreground-subtle">
                            untagged
                        </span>
                    )}
                </div>

                <span
                    aria-hidden
                    className={`hidden text-foreground-subtle transition-transform sm:inline ${
                        expanded ? "rotate-180" : ""
                    }`}
                >
                    ▾
                </span>
            </button>

            {expanded && (
                <div className="space-y-5 border-t border-border bg-background px-3 py-4 sm:px-6 sm:py-5">
                    {layer1Tags.lastfm.length > 0 && (
                        <div>
                            <p className="eyebrow text-foreground-subtle">
                                Last.fm signals
                            </p>
                            <p className="mt-1 text-xs text-foreground-muted">
                                Top tags from Last.fm at enrichment time.
                                Reference only — frozen, not voted on.
                            </p>
                            <ul className="mt-2 flex flex-wrap gap-1.5">
                                {layer1Tags.lastfm.map((l) => (
                                    <li
                                        key={l.name}
                                        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background-elevated px-2 py-0.5 text-xs text-foreground-muted"
                                    >
                                        <span>{l.name}</span>
                                        <span className="tabular text-foreground-subtle">
                                            {l.count}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {wikidataByProperty.size > 0 && (
                        <div>
                            <p className="eyebrow text-foreground-subtle">
                                Wikidata signals
                            </p>
                            <p className="mt-1 text-xs text-foreground-muted">
                                Structured facts (genre, language, instruments,
                                &hellip;) sourced from Wikidata.
                            </p>
                            <dl className="mt-2 space-y-2">
                                {[...wikidataByProperty.entries()].map(
                                    ([property, names]) => (
                                        <div
                                            key={property}
                                            className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5"
                                        >
                                            <dt className="min-w-16 text-xs font-medium uppercase tracking-wider text-foreground-subtle">
                                                {WIKIDATA_PROPERTY_LABEL[
                                                    property
                                                ] ?? property}
                                            </dt>
                                            <dd className="flex flex-wrap gap-1.5">
                                                {names.map((n) => (
                                                    <span
                                                        key={n}
                                                        className="inline-flex items-center rounded-full border border-border bg-background-elevated px-2 py-0.5 text-xs text-foreground-muted"
                                                    >
                                                        {n}
                                                    </span>
                                                ))}
                                            </dd>
                                        </div>
                                    ),
                                )}
                            </dl>
                        </div>
                    )}

                    {layer1Tags.lastfm.length === 0 &&
                        layer1Tags.wikidata.length === 0 && (
                            <p className="text-xs text-foreground-subtle">
                                No reference tags yet — enrichment may still be
                                pending for this track.
                            </p>
                        )}

                    <form
                        onSubmit={handleSubmit}
                        className="flex flex-wrap items-center gap-2"
                    >
                        <label
                            htmlFor={`tag-input-${track.trackId}`}
                            className="eyebrow text-foreground-subtle"
                        >
                            Add a tag
                        </label>
                        <input
                            id={`tag-input-${track.trackId}`}
                            type="text"
                            value={tagInput}
                            onChange={(e) => setTagInput(e.target.value)}
                            maxLength={TAG_INPUT_MAX}
                            placeholder="e.g. late-night drive"
                            disabled={isPending}
                            className="min-w-0 flex-1 rounded-full border border-border-strong bg-background-elevated px-3 py-1.5 text-sm text-foreground placeholder:text-foreground-subtle focus:border-accent focus:outline-none"
                        />
                        <button
                            type="submit"
                            disabled={isPending || !tagInput.trim()}
                            className="rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-accent-ink transition-opacity hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            Submit
                        </button>
                    </form>

                    {errorMsg && (
                        <p
                            role="alert"
                            className="text-xs text-accent"
                        >
                            {errorMsg}
                        </p>
                    )}

                    {visibleSuggested.length > 0 && (
                        <div>
                            <div className="flex items-baseline justify-between">
                                <p className="eyebrow text-foreground-subtle">
                                    Suggested tags
                                </p>
                                <p className="text-xs text-foreground-subtle">
                                    {visibleSuggested.length} pending
                                </p>
                            </div>
                            <p className="mt-1 text-xs text-foreground-muted">
                                Vote these up. At a score of{" "}
                                <span className="tabular text-foreground">
                                    2
                                </span>{" "}
                                a tag graduates to a community tag and starts
                                counting toward playlist generation.
                            </p>
                            <ul className="mt-3 flex flex-wrap gap-2">
                                {visibleSuggested.map((t) => {
                                    const isMine =
                                        t.submittedBy === currentUserId;
                                    const upActive = t.currentUserVote === 1;
                                    const downActive = t.currentUserVote === -1;
                                    return (
                                        <li
                                            key={t.userTagId}
                                            className="flex items-center gap-0.5 rounded-full border border-dashed border-border-strong bg-background-elevated py-0.5 pl-1 pr-2 text-xs"
                                        >
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    handleVote(
                                                        t.userTagId,
                                                        1,
                                                        t.currentUserVote,
                                                    )
                                                }
                                                disabled={isPending}
                                                aria-pressed={upActive}
                                                aria-label={`Upvote ${t.tagName}`}
                                                className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
                                                    upActive
                                                        ? "text-accent"
                                                        : "text-foreground-subtle hover:text-foreground"
                                                }`}
                                            >
                                                ▲
                                            </button>
                                            <span
                                                className={`tabular px-1 ${
                                                    t.score > 0
                                                        ? "text-foreground"
                                                        : "text-foreground-subtle"
                                                }`}
                                            >
                                                {t.score}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    handleVote(
                                                        t.userTagId,
                                                        -1,
                                                        t.currentUserVote,
                                                    )
                                                }
                                                disabled={isPending}
                                                aria-pressed={downActive}
                                                aria-label={`Downvote ${t.tagName}`}
                                                className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
                                                    downActive
                                                        ? "text-accent"
                                                        : "text-foreground-subtle hover:text-foreground"
                                                }`}
                                            >
                                                ▼
                                            </button>
                                            <span className="px-2 font-medium text-foreground">
                                                {t.tagName}
                                            </span>
                                            {isMine && (
                                                <span
                                                    title="You submitted this"
                                                    className="rounded-full bg-surface px-1.5 text-[10px] uppercase tracking-wide text-foreground-subtle"
                                                >
                                                    yours
                                                </span>
                                            )}
                                            {isMine && (
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        handleHideOwnTag(
                                                            t.userTagId,
                                                        )
                                                    }
                                                    disabled={isPending}
                                                    aria-label={`Hide your submission ${t.tagName}`}
                                                    title="Hide your submission"
                                                    className="ml-0.5 text-foreground-subtle transition-colors hover:text-foreground"
                                                >
                                                    ×
                                                </button>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    )}

                    <div>
                        <div className="flex items-baseline justify-between">
                            <p className="eyebrow text-foreground-subtle">
                                Community tags
                            </p>
                            {communityTags.length > 0 && (
                                <p className="text-xs text-foreground-subtle">
                                    {communityTags.length} above threshold
                                </p>
                            )}
                        </div>

                        {communityTags.length === 0 ? (
                            <p className="mt-2 text-xs text-foreground-muted">
                                Nothing here yet. Add the first tag.
                            </p>
                        ) : (
                            <ul className="mt-3 flex flex-wrap gap-2">
                                {communityTags.map((t) => {
                                    const isMine =
                                        t.submittedBy === currentUserId;
                                    const upActive = t.currentUserVote === 1;
                                    const downActive = t.currentUserVote === -1;
                                    return (
                                        <li
                                            key={t.userTagId}
                                            className="flex items-center gap-0.5 rounded-full border border-border-strong bg-background-elevated py-0.5 pl-1 pr-2 text-xs"
                                        >
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    handleVote(
                                                        t.userTagId,
                                                        1,
                                                        t.currentUserVote,
                                                    )
                                                }
                                                disabled={isPending}
                                                aria-pressed={upActive}
                                                aria-label={`Upvote ${t.tagName}`}
                                                className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
                                                    upActive
                                                        ? "text-accent"
                                                        : "text-foreground-subtle hover:text-foreground"
                                                }`}
                                            >
                                                ▲
                                            </button>
                                            <span
                                                className={`tabular px-1 ${
                                                    t.score > 0
                                                        ? "text-foreground"
                                                        : "text-foreground-subtle"
                                                }`}
                                            >
                                                {t.score}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    handleVote(
                                                        t.userTagId,
                                                        -1,
                                                        t.currentUserVote,
                                                    )
                                                }
                                                disabled={isPending}
                                                aria-pressed={downActive}
                                                aria-label={`Downvote ${t.tagName}`}
                                                className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
                                                    downActive
                                                        ? "text-accent"
                                                        : "text-foreground-subtle hover:text-foreground"
                                                }`}
                                            >
                                                ▼
                                            </button>
                                            <span className="px-2 font-medium text-foreground">
                                                {t.tagName}
                                            </span>
                                            {isMine && (
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        handleHideOwnTag(
                                                            t.userTagId,
                                                        )
                                                    }
                                                    disabled={isPending}
                                                    aria-label={`Hide your submission ${t.tagName}`}
                                                    title="Hide your submission"
                                                    className="ml-0.5 text-foreground-subtle transition-colors hover:text-foreground"
                                                >
                                                    ×
                                                </button>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </div>
            )}
        </li>
    );
}
