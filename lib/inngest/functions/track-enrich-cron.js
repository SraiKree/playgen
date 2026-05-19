import { inngest } from "../client.js";
import { getStaleUnenrichedTrackIds } from "@/lib/library";

const BATCH_SIZE = 50;
const STALE_AFTER_MINUTES = 30;

const MAX_PER_TICK = 500;

export const trackEnrichCron = inngest.createFunction(
  {
    id: "track-enrich-cron",
    name: "Hourly fallback for unenriched tracks",
    triggers: [{ cron: "0 * * * *" }],
  },
  async ({ step, logger }) => {
    // Step 1: find stragglers. Step.run gives us automatic retry on transient
    // Supabase blips, and the result is memoized so step 2 doesn't redo the
    // query if it has to retry independently.
    const stale = await step.run("find-stale", () =>
      getStaleUnenrichedTrackIds({
        olderThanMinutes: STALE_AFTER_MINUTES,
        limit: MAX_PER_TICK,
      }),
    );

    if (stale.length === 0) return { stale: 0 };
    logger.warn(
      "track-enrich-cron: stragglers found but dispatch disabled until B2 (per-user refresh tokens)",
      { count: stale.length },
    );
    return { stale: stale.length, dispatched: 0, reason: "awaiting-B2" };
  },
);
