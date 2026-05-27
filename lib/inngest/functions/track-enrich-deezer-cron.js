// Hourly backfill of Deezer genres into track_tags_external (Layer 1).
//
// Deezer matches a track by ISRC (exact) when one exists, else a fuzzy
// artist+track search (see lib/deezer.js). Our catalog currently has no ISRCs,
// so this leans on the search fallback today and lights up further once ISRCs
// are backfilled. Genres are coarse (album-level) but a useful seed for the
// no-ISRC tail. Cron-drained (not fanned out) like library-backfill-isrc — new
// tracks land with deezer_checked_at NULL and get picked up on the next tick.
//
// Rate: Deezer allows ~50 req/5s; a short step.sleep keeps us well under even
// though each track costs up to ~3 calls (track/search + album).

import { inngest } from "../client.js";
import { fetchTrackGenres } from "@/lib/deezer";
import {
  getTracksNeedingDeezer,
  upsertExternalTagsForTrack,
  markTracksDeezerChecked,
} from "@/lib/library";

const CRON = "15 * * * *"; // offset from the other hourly crons
const BATCH_SIZE = 50;
const RATE_LIMIT_MS = "200ms";

export const trackEnrichDeezerCron = inngest.createFunction(
  {
    id: "track-enrich-deezer-cron",
    name: "Backfill Deezer genres (track_tags_external)",
    triggers: [{ cron: CRON }],
    concurrency: [{ scope: "fn", limit: 1 }],
    retries: 1,
  },
  async ({ step, logger }) => {
    const candidates = await step.run("find-tracks-needing-deezer", () =>
      getTracksNeedingDeezer({ limit: BATCH_SIZE }),
    );
    if (candidates.length === 0) return { processed: 0, hits: 0 };

    const checkedIds = [];
    let hits = 0;

    for (let i = 0; i < candidates.length; i += 1) {
      const { spotifyId, isrc, name, artist } = candidates[i];

      // fetchTrackGenres throws only on transient errors (429/5xx/quota), so a
      // failure here fails the step and Inngest retries; non-throwing results
      // (ok / not_found) all count as "consulted" and get marked below.
      const result = await step.run(`deezer-${spotifyId}`, () =>
        fetchTrackGenres({ isrc, artist, track: name }),
      );

      if (result.status === "ok") {
        await step.run(`deezer-upsert-${spotifyId}`, () =>
          upsertExternalTagsForTrack(spotifyId, "deezer", result.genres),
        );
        hits += 1;
      }
      checkedIds.push(spotifyId);

      if (i < candidates.length - 1) {
        await step.sleep(`deezer-rate-${i}`, RATE_LIMIT_MS);
      }
    }

    if (checkedIds.length > 0) {
      await step.run("mark-deezer-checked", () => markTracksDeezerChecked(checkedIds));
    }

    const stats = { processed: candidates.length, hits };
    logger.info("track-enrich-deezer-cron batch", stats);
    return stats;
  },
);
