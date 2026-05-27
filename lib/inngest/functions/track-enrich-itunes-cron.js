// Hourly backfill of iTunes genres into track_tags_external (Layer 1).
//
// iTunes has no ISRC lookup, but its fuzzy artist+track search is reliable and
// returns a primaryGenreName per track (see lib/itunes.js) — and Apple's
// catalog is strong on the Indian/film/regional music the other sources miss.
// This is the track-level genre source that actually rescues our no-ISRC tail.
//
// Rate: Apple's soft cap is ~20 req/min per IP; exceeding it returns 403/429.
// We throttle to ~18/min with a step.sleep between calls (the same self-pacing
// pattern as library-backfill-isrc's MusicBrainz 1 req/s gate). step.sleep
// yields back to Inngest, so the long wall-clock time spans many short
// invocations rather than one long-running function.

import { inngest } from "../client.js";
import { fetchTrackGenre } from "@/lib/itunes";
import {
  getTracksNeedingItunes,
  upsertExternalTagsForTrack,
  markTracksItunesChecked,
} from "@/lib/library";

const CRON = "30 * * * *"; // offset from the other hourly crons
const BATCH_SIZE = 40; // ~2.2 min of throttled calls per tick
const RATE_LIMIT_MS = "3300ms"; // ~18 req/min, under the ~20/min soft cap

export const trackEnrichItunesCron = inngest.createFunction(
  {
    id: "track-enrich-itunes-cron",
    name: "Backfill iTunes genres (track_tags_external)",
    triggers: [{ cron: CRON }],
    concurrency: [{ scope: "fn", limit: 1 }],
    retries: 1,
  },
  async ({ step, logger }) => {
    const candidates = await step.run("find-tracks-needing-itunes", () =>
      getTracksNeedingItunes({ limit: BATCH_SIZE }),
    );
    if (candidates.length === 0) return { processed: 0, hits: 0 };

    const checkedIds = [];
    let hits = 0;

    for (let i = 0; i < candidates.length; i += 1) {
      const { spotifyId, name, artist } = candidates[i];

      // Throws on 429/5xx (Inngest retries). "ok" / "not_found" / "skipped" all
      // mean "consulted" — we mark them so the queue drains and we don't re-hit
      // the rate-limited endpoint for the same track next tick.
      const result = await step.run(`itunes-${spotifyId}`, () =>
        fetchTrackGenre({ artist, track: name }),
      );

      if (result.status === "ok") {
        await step.run(`itunes-upsert-${spotifyId}`, () =>
          upsertExternalTagsForTrack(spotifyId, "itunes", result.genres),
        );
        hits += 1;
      }
      checkedIds.push(spotifyId);

      if (i < candidates.length - 1) {
        await step.sleep(`itunes-rate-${i}`, RATE_LIMIT_MS);
      }
    }

    if (checkedIds.length > 0) {
      await step.run("mark-itunes-checked", () => markTracksItunesChecked(checkedIds));
    }

    const stats = { processed: candidates.length, hits };
    logger.info("track-enrich-itunes-cron batch", stats);
    return stats;
  },
);
