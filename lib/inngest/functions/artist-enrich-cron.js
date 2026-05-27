// Hourly backstop for the artist genre floor (Layer 1.5).
//
// The fan-out from track-enrich.js already covers artists as their tracks are
// synced. This cron drains the rest:
//   * artists that predate the floor (libraries synced before migration 0014),
//   * artists a fan-out batch missed (e.g. a mid-run worker failure that never
//     reached the mark-enriched step).
//
// Unlike library-backfill-isrc, this needs NO per-user Spotify token —
// artist.getTopTags keys on the artist NAME, which is already stored on the
// artists row — so it is ENABLED, not gated on per-user refresh tokens (B2).
//
// Division of labour: this cron only FINDS artists and dispatches one event;
// the artist-enrich worker does the Last.fm calls under the shared "lastfm"
// concurrency cap (5). Keeping the cron at concurrency 1 stops two ticks from
// double-dispatching the same backlog.

import { inngest } from "../client.js";
import { getArtistsNeedingTags } from "@/lib/library";

const CRON = "0 * * * *"; // hourly

// Per tick. The worker's shared lastfm cap (5) paces the actual API calls; this
// just bounds how many we hand off at once. New artists trickle in via the
// per-sync fan-out, so the steady-state backlog is small.
const BATCH_SIZE = 50;

export const artistEnrichCron = inngest.createFunction(
  {
    id: "artist-enrich-cron",
    name: "Hourly artist genre floor backstop",
    triggers: [{ cron: CRON }],
    concurrency: [{ scope: "fn", limit: 1 }],
  },
  async ({ step, logger }) => {
    const artists = await step.run("find-artists-needing-tags", () =>
      getArtistsNeedingTags({ limit: BATCH_SIZE }),
    );

    if (artists.length === 0) {
      return { dispatched: 0 };
    }

    // Hand the batch to the worker. We don't mark them here — the worker stamps
    // tags_enriched_at after processing. If a tick re-selects an in-flight
    // artist before the worker finishes, getUnenrichedArtistIds + idempotent
    // upserts make the double-processing harmless.
    await step.sendEvent("emit-artist-enrich", {
      name: "artists/enrich.requested",
      data: {
        artists: artists.map((a) => ({ id: a.spotifyId, name: a.name })),
        source: "artist-enrich-cron",
      },
    });

    logger.info("artist-enrich-cron dispatched", { count: artists.length });
    return { dispatched: artists.length };
  },
);
