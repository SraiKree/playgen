// Layer 1.5 enrichment worker — the artist genre FLOOR.
//
// Why this exists (measured: 379 of 698 tracks — 54% — had zero seed tags):
// Last.fm track.getTopTags is empty for most non-hit tracks, and Wikidata only
// matches notable recordings. artist.getTopTags almost always returns genre
// tags for any artist with a Last.fm presence, so we enrich each artist ONCE
// (CLAUDE.md §2 "Enrich Once, Query Infinite") and let every track by that
// artist inherit the genres downstream when its own track-level tags are sparse.
//
// Fanned out from track-enrich.js (per library sync) and topped up by
// artist-enrich-cron.js (hourly backstop for already-synced libraries).
//
// What a single invocation does, per batch:
//   1. Dedup incoming artists, then filter to those still needing a pass
//      (tags_enriched_at IS NULL) via getUnenrichedArtistIds.
//   2. One Last.fm artist.getTopTags per artist — one step each (memoized on
//      retry), for retry isolation so one failed lookup can't roll back the batch.
//   3. Upsert hits into artist_tags.
//   4. Stamp tags_enriched_at for hits AND empty misses so the work queue drains
//      and we never re-query. (If the run fails before this step, the cron will
//      re-process the affected artists — upserts are idempotent, so it's a
//      harmless redo.)
//
// Concurrency: shares one virtual "lastfm" queue (scope: env) with track-enrich
// so their COMBINED in-flight Last.fm calls stay <= 5 (CLAUDE.md §5). retries: 3
// rides out transient Last.fm blips; fetchArtistTopTags swallows "artist not
// found" (Last.fm code 6) as an empty miss, so a bad artist name never loops.

import { inngest } from "../client.js";
import { fetchArtistTopTags } from "@/lib/lastfm";
import {
  getUnenrichedArtistIds,
  upsertArtistTags,
  markArtistsTagsEnriched,
} from "@/lib/library";

export const artistEnrich = inngest.createFunction(
  {
    id: "artist-enrich",
    name: "Layer 1.5 enrichment (Last.fm artist floor)",
    triggers: [{ event: "artists/enrich.requested" }],
    // Same shared "lastfm" virtual queue as track-enrich — see that file.
    concurrency: [{ scope: "env", key: '"lastfm"', limit: 5 }],
    retries: 3,
  },
  async ({ event, step, logger }) => {
    const incoming = event.data?.artists ?? [];
    if (incoming.length === 0) {
      return { skipped: "empty", source: event.data?.source };
    }

    // Step 1: dedup (the same artist appears across many tracks) and keep a
    // spotify_id -> name map so we can call Last.fm without a DB round trip.
    const nameById = new Map();
    for (const a of incoming) {
      if (a?.id && !nameById.has(a.id)) nameById.set(a.id, a.name ?? null);
    }
    const incomingIds = [...nameById.keys()];

    const todoIds = await step.run("filter-unenriched-artists", () =>
      getUnenrichedArtistIds(incomingIds),
    );
    if (todoIds.length === 0) {
      return { skipped: "all-enriched", incoming: incoming.length };
    }

    // Step 2 + 3: per-artist Last.fm lookup + upsert.
    const processedIds = [];
    let hits = 0;
    let empty = 0;

    for (const artistId of todoIds) {
      const name = nameById.get(artistId);

      // No name (shouldn't happen — track-enrich forwards it and the cron
      // selects it from the DB). Can't query Last.fm without it, so mark
      // processed to drop it from the queue rather than loop forever.
      if (!name) {
        empty += 1;
        processedIds.push(artistId);
        continue;
      }

      // Memoized by step id: on an Inngest retry, artists already resolved this
      // run return their cached tags instead of re-hitting Last.fm.
      const tags = await step.run(`lastfm-artist-${artistId}`, () =>
        fetchArtistTopTags({ artist: name }),
      );

      if (Array.isArray(tags) && tags.length > 0) {
        await step.run(`upsert-artist-tags-${artistId}`, () =>
          upsertArtistTags(artistId, tags),
        );
        hits += 1;
      } else {
        // Successful call, zero tags above the floor — a terminal miss. Still
        // gets marked enriched below so we never re-query it.
        empty += 1;
      }
      processedIds.push(artistId);
    }

    // Step 4: stamp tags_enriched_at for everything processed (hits + misses).
    if (processedIds.length > 0) {
      await step.run("mark-artists-tags-enriched", () =>
        markArtistsTagsEnriched(processedIds),
      );
    }

    const stats = { processed: todoIds.length, hits, empty };
    logger.info("artist-enrich batch", stats);
    return stats;
  },
);
