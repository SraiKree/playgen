// Layer 1 enrichment worker — source #3: Wikidata.
//
// This worker is the third Layer 1 bootstrap (after Spotify artist genres
// and Last.fm tags). It runs SEQUENTIALLY after track-enrich.js: that
// function emits "tracks/enrich-wikidata.requested" at the end of its
// last step, so any track this worker sees has already completed the
// Last.fm pass (tracks.enriched_at IS NOT NULL).
//
// What a single invocation does, per batch:
//   1. Filter the incoming spotify_ids to rows that still need Wikidata
//      enrichment (wikidata_enriched_at IS NULL). If a track has no ISRC,
//      it's STILL returned by this filter — we'll mark it enriched-as-miss
//      below so the worker queue keeps draining.
//   2. For each track with an ISRC: ONE SPARQL call to Wikidata
//      (lib/wikidata.js). Result is either:
//        - a payload with QID + property buckets (HIT), or
//        - null (MISS: no Wikidata entity matched this ISRC).
//   3. Upsert the tags into track_tags_wikidata via the lib/library.js
//      helper. The helper handles tag normalization + atomic inserts +
//      the (track_id, tag_id, property) PK.
//   4. Flip wikidata_enriched_at for ALL processed tracks (hits, misses,
//      and ISRC-less rows). Marking misses prevents re-querying forever.
//   5. Log structured batch stats so we can spot coverage issues.
//
// Concurrency: capped at 5. Wikidata's public SPARQL endpoint allows
// ~60 req/min unauthenticated; 5 concurrent workers is well under.
// CLAUDE.md §5 caps Spotify- and Last.fm-facing workers at 5 too — kept
// consistent here even though Wikidata's limit is more forgiving.

import { inngest } from "../client.js";
import { fetchTrackTagsByIsrc, fetchTrackTagsByMbid } from "@/lib/wikidata";
import {
  getTracksNeedingWikidata,
  upsertWikidataTagsByIsrc,
  markTracksWikidataEnriched,
} from "@/lib/library";

export const trackEnrichWikidata = inngest.createFunction(
  {
    id: "track-enrich-wikidata",
    name: "Layer 1 enrichment (Wikidata)",
    triggers: [{ event: "tracks/enrich-wikidata.requested" }],
    concurrency: [{ scope: "fn", limit: 5 }],
    retries: 3,
  },
  async ({ event, step, logger }) => {
    const incoming = event.data?.tracks ?? [];
    if (incoming.length === 0) {
      return { skipped: "empty" };
    }

    // Step 1: filter to rows that still need a Wikidata pass. The helper
    // also returns each row's ISRC so we don't have to look it up again.
    const incomingIds = incoming.map((t) => t.id).filter(Boolean);
    const todo = await step.run("filter-pending", () =>
      getTracksNeedingWikidata(incomingIds),
    );
    if (todo.length === 0) {
      return { skipped: "all-enriched", incoming: incoming.length };
    }

    // Counters for the batch log line at the end.
    let hits = 0;
    let noIdentifier = 0;
    let sparqlNoMatch = 0;
    // Bad data from Wikidata (4xx, malformed JSON). Previously these threw
    // and crashed the worker run; now lib/wikidata.js returns status:"skipped"
    // so we count, log, and continue. Crucially, skipped tracks are NOT
    // marked wikidata_enriched_at — we *want* them to get re-tried on the
    // next sync, since the bad-data condition may be transient (e.g. an
    // intermediate proxy cached a malformed response that later expires).
    let wikidataBadData = 0;
    // spotify_ids we should write wikidata_enriched_at for at the end of the
    // batch. Excludes skipped rows.
    const idsToMarkEnriched = [];

    // Step 2 + 3: per-track SPARQL + upsert. One step per track for retry
    // isolation — a single bad ISRC won't roll back the whole batch.
    for (const { spotifyId, isrc, mbid } of todo) {
      // Tracks with neither an ISRC nor an MBID can't be resolved on Wikidata
      // (both lookups key on an external identifier). Skip the fetch but still
      // mark them enriched below so the worker queue keeps draining — that's
      // why they go into idsToMarkEnriched instead of being treated as bad data.
      if (!isrc && !mbid) {
        noIdentifier += 1;
        idsToMarkEnriched.push(spotifyId);
        continue;
      }

      // Prefer the ISRC lookup (wdt:P1243); fall back to the MBID lookup
      // (wdt:P4404) for tracks MusicBrainz knows by MBID but stores no ISRC for.
      // step.run memoizes the result — on retry the SPARQL call is skipped and
      // the upsert step picks up from the cached payload. Both helpers return a
      // discriminated result on bad data (instead of throwing) so one poisoned
      // identifier can't crash the whole batch.
      const result = await step.run(`wikidata-${spotifyId}`, () =>
        isrc ? fetchTrackTagsByIsrc(isrc) : fetchTrackTagsByMbid(mbid),
      );

      if (result.status === "skipped") {
        wikidataBadData += 1;
        logger.warn("track-enrich-wikidata: skipped bad data from Wikidata", {
          spotifyId,
          isrc,
          reason: result.reason,
        });
        // Intentionally NOT pushed to idsToMarkEnriched — leave the row
        // available for a future retry once the bad-data condition clears.
        continue;
      }

      if (result.status === "not_found") {
        // Wikidata genuinely has no entity for this ISRC. Mark enriched so
        // we don't re-query a dead lookup every sync cycle.
        sparqlNoMatch += 1;
        idsToMarkEnriched.push(spotifyId);
        continue;
      }

      // status === "ok"
      await step.run(`upsert-wikidata-${spotifyId}`, () =>
        upsertWikidataTagsByIsrc(spotifyId, result),
      );
      hits += 1;
      idsToMarkEnriched.push(spotifyId);
    }

    // Step 4: mark hits, misses, and ISRC-less rows as wikidata-enriched —
    // but NOT bad-data skips (those get retried on the next sync).
    if (idsToMarkEnriched.length > 0) {
      await step.run("mark-wikidata-enriched", () =>
        markTracksWikidataEnriched(idsToMarkEnriched),
      );
    }

    // Step 5: batch log so we can eyeball coverage in Inngest's UI.
    const stats = {
      processed: todo.length,
      hits,
      no_identifier: noIdentifier,
      sparql_no_match: sparqlNoMatch,
      wikidata_bad_data: wikidataBadData,
    };
    logger.info("track-enrich-wikidata batch", stats);

    return stats;
  },
);
