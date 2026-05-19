// Background sync of one user's Spotify "Liked Songs" into the global tracks
// cache + their personal user_library link rows.
//
// This file ORCHESTRATES — it never contains raw fetch() or supabase.from(...)
// calls. All Spotify and DB work goes through the pure helpers in
// lib/spotify.js and lib/library.js (CLAUDE.md §4).
//
// Step granularity: one Inngest step per page (fetch / upsert / link). Steps
// are memoized — if the worker crashes mid-sync, only the failed page reruns
// on retry; finished pages are replayed from cache. Per CLAUDE.md §4: "Each
// Inngest step processes one page / batch only" (Vercel function timeouts
// are strict).

import { inngest } from "../client.js";
import { fetchSavedTracks } from "@/lib/spotify";
import { upsertTracks, linkTracksToUser } from "@/lib/library";

// One page of Spotify's /me/tracks. Must match the BATCH_LIMIT in lib/spotify.js
// (50) — Spotify caps that endpoint at 50 and CLAUDE.md §5 applies that as the
// project-wide chunk size. Kept local so we don't import an unexported constant.
const PAGE_SIZE = 50;

export const librarySync = inngest.createFunction(
  {
    id: "library-sync",
    name: "Sync a user's Spotify saved tracks",
    // Inngest v4 collapsed the old (config, trigger, handler) signature into
    // (config, handler) with triggers living on the config object.
    triggers: [{ event: "library/sync.requested" }],
    // CLAUDE.md §5 — global cap of 5 concurrent Spotify-facing workers to
    // stay clear of /me/tracks 429s; plus one-per-user so back-to-back
    // triggers from the UI don't run overlapping syncs for the same person.
    concurrency: [
      { scope: "fn", limit: 5 },
      { scope: "fn", key: "event.data.userId", limit: 1 },
    ],
    // 24h dedup window keyed on userId — defends against double-clicks and
    // Inngest's at-least-once event delivery.
    idempotency: "event.data.userId",
    retries: 3,
  },
  async ({ event, step }) => {
    const { userId, accessToken } = event.data;

    let offset = 0;
    let total = 0;
    let pages = 0;

    // Manual pagination: Spotify's /me/tracks returns { items, next, total }.
    // We stop when `next` is null. Each page is its own trio of steps so the
    // run timeline stays readable and any single failure has a small blast radius.
    while (true) {
      const page = await step.run(`fetch-page-${offset}`, () =>
        fetchSavedTracks(accessToken, { offset, limit: PAGE_SIZE }),
      );

      // Spotify's saved-tracks items are { added_at, track }. Drop local
      // files / region-blocked tracks where track or track.id is null.
      const items = (page?.items ?? []).filter((i) => i?.track?.id);
      const tracks = items.map((i) => i.track);
      const linkRows = items.map((i) => ({
        spotifyId: i.track.id,
        addedAt: i.added_at,
      }));

      if (tracks.length > 0) {
        await step.run(`upsert-page-${offset}`, () => upsertTracks(tracks));
        await step.run(`link-page-${offset}`, () =>
          linkTracksToUser(userId, linkRows),
        );
      }

      total += tracks.length;
      pages += 1;

      if (!page?.next) break;
      offset += PAGE_SIZE;
    }

    return { userId, pages, total };
  },
);
