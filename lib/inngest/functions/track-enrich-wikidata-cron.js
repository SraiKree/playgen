// Hourly drain for Wikidata enrichment.
//
// The Wikidata worker (track-enrich-wikidata) is event-driven: track-enrich
// emits its event when a track first completes the Last.fm pass. But tracks
// whose ISRCs were backfilled LATER (migration 0016 — see
// lib/library.js:backfillTrackIsrcs) have nothing to re-trigger them now that
// the old library-backfill-isrc cron (which used to re-emit) is retired.
//
// This cron closes that gap: it finds tracks past Layer 1 (enriched_at set) that
// still have wikidata_enriched_at IS NULL and re-emits the Wikidata event so the
// worker re-evaluates them — now with an ISRC to match on. Backed by
// tracks_wikidata_pending_idx (migration 0004).

import { inngest } from "../client.js";
import { getTracksNeedingWikidataIds } from "@/lib/library";

const CRON = "45 * * * *"; // offset from the other hourly crons
const BATCH_SIZE = 100;

export const trackEnrichWikidataCron = inngest.createFunction(
  {
    id: "track-enrich-wikidata-cron",
    name: "Hourly Wikidata backfill",
    triggers: [{ cron: CRON }],
    concurrency: [{ scope: "fn", limit: 1 }],
  },
  async ({ step, logger }) => {
    const ids = await step.run("find-wikidata-pending", () =>
      getTracksNeedingWikidataIds({ limit: BATCH_SIZE }),
    );
    if (ids.length === 0) return { dispatched: 0 };

    await step.sendEvent("emit-wikidata", {
      name: "tracks/enrich-wikidata.requested",
      data: { tracks: ids.map((id) => ({ id })), source: "wikidata-cron" },
    });

    logger.info("track-enrich-wikidata-cron dispatched", { count: ids.length });
    return { dispatched: ids.length };
  },
);
