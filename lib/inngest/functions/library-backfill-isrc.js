// Backfill cron for the `tracks.isrc` column.
//
// What this fixes (the problem):
//   Migration 0004 added an `isrc` column to tracks. For freshly-discovered
//   tracks, library-sync.js fills the ISRC directly from Spotify's
//   /me/tracks payload (external_ids.isrc). But rows that existed BEFORE
//   migration 0004 stay at isrc=NULL — the upsertTracks helper uses
//   ignoreDuplicates and never updates already-present rows. Without an
//   ISRC, the Wikidata worker can't enrich them.
//
// What this does (the fix):
//   1. Find tracks with isrc IS NULL.
//   2. For each, ask MusicBrainz "what recording is linked to this Spotify
//      track URL?" — MB indexes Spotify URLs as recording URL relationships,
//      and most popular tracks have both an MBID and an ISRC in MB.
//   3. Persist whatever MB returned (mbid + isrc, or just mbid on misses).
//   4. CLEAR wikidata_enriched_at on the affected rows so the Wikidata
//      worker re-evaluates them.
//   5. Emit one batched `tracks/enrich-wikidata.requested` event so the
//      next-stage worker picks them up immediately — no waiting for the
//      next user sync.
//
// MusicBrainz constraints:
//   - Rate limit is a HARD 1 request / second per IP. MB will start
//     returning 503 / "rate limit exceeded" past that, and aggressive
//     abusers get IP-banned. We use step.sleep("rate-limit", "1s") between
//     calls (more precisely, 1.1s with a safety margin).
//   - User-Agent header is REQUIRED and must identify the project.
//   - We use the recording search endpoint with a Lucene URL-relationship
//     filter — one request returns both MBID and ISRC.
//
// Inngest interactions (worth knowing):
//   - step.sleep yields control back to Inngest. The function is RE-INVOKED
//     after the sleep, so the per-step Vercel function duration limit
//     (~10s Hobby / 60s Pro) doesn't apply across steps. A run that takes
//     50 seconds of wall-clock time uses many short invocations.
//   - step.run memoizes the result keyed by step ID. On retry, completed
//     MB lookups are NOT re-called — we only re-execute from the failure
//     point onward.
//   - concurrency: 1 — the cron self-throttles by interval, and we never
//     want two concurrent runs both spending the same MB rate-limit budget.
//
// Future direction: when refresh-token storage lands we could augment this
// with a "use a real Spotify user's token to refetch /me/tracks and read
// external_ids.isrc directly", which is faster than MB lookups. The MB
// path stays useful as a fallback for orphaned tracks (no owner).

import { inngest } from "../client.js";
import { lookupRecordingBySpotifyId } from "@/lib/musicbrainz";
import {
  getTracksMissingIsrc,
  updateTrackIsrcAndMbid,
  markTracksMusicbrainzChecked,
} from "@/lib/library";

// Hourly. Adjust if the queue grows faster than 1 batch/hour can drain.
const CRON = "0 * * * *";

// Per-run cap. With 1.1s/track (MB rate-limit aware) plus ~0.5s overhead
// per pair of steps, a batch of 30 takes ~60s of wall-clock time. Inngest
// handles the long total duration via step.sleep; this cap just bounds
// the per-run scope so failures don't spend an entire hour redoing work.
const BATCH_SIZE = 30;

// MB's documented limit is 1 req/sec; add 100ms of safety margin so a
// burst of clock drift can't push two consecutive requests under 1s apart.
const MB_RATE_LIMIT_MS = "1100ms";

export const libraryBackfillIsrc = inngest.createFunction(
  {
    id: "library-backfill-isrc",
    name: "Backfill tracks.isrc via MusicBrainz",
    triggers: [{ cron: CRON }],
    concurrency: [{ scope: "fn", limit: 1 }],
    retries: 1,
  },
  async ({ step, logger }) => {
    // Step 1: queue lookup. Only spotify_ids are needed; the userId field
    // on each row is left in for future use (refresh-token-based backfill).
    const candidates = await step.run("find-tracks-missing-isrc", () =>
      getTracksMissingIsrc({ limit: BATCH_SIZE }),
    );

    if (candidates.length === 0) {
      logger.info("library-backfill-isrc: nothing to backfill");
      return { processed: 0, filled_isrc: 0, mbid_only: 0, mb_miss: 0, mb_bad_data: 0 };
    }

    let filledIsrc = 0;
    let mbidOnly = 0;
    let mbMiss = 0;
    // Bad data from MB (4xx, malformed JSON, malformed MBID, malformed
    // input spotify_id). Previously these would throw inside step.run and
    // crash the whole batch run — now the helper returns status:"skipped"
    // so we count them, log the reason, and move to the next track.
    let mbBadData = 0;
    // Track which spotify_ids we filled SOMETHING for so we can kick the
    // Wikidata worker afterward — no point emitting for total misses.
    const refreshedSpotifyIds = [];
    // not_found spotify_ids: MusicBrainz has no record for this URL. Stamp
    // musicbrainz_checked_at so they leave the backfill queue (they can't be
    // enriched and shouldn't be re-fetched). The "ok" path stamps this via
    // updateTrackIsrcAndMbid; "skipped" (bad data) is left unstamped to retry.
    const notFoundSpotifyIds = [];

    for (let i = 0; i < candidates.length; i += 1) {
      const { spotifyId } = candidates[i];

      // Step 2: MB lookup. step.run memoizes — on retry we won't re-hit
      // MB for spotify_ids we've already successfully looked up. The helper
      // now returns a discriminated result instead of throwing on bad data;
      // see lib/musicbrainz.js for the status taxonomy.
      const mbResult = await step.run(`mb-lookup-${spotifyId}`, () =>
        lookupRecordingBySpotifyId(spotifyId),
      );

      // Step 3: branch on status.
      //   - "ok": persist whatever we got (MBID alone is still useful for
      //     the Phase 2 Wikidata-by-MBID fallback path) and queue the
      //     track for the Wikidata worker.
      //   - "not_found": legitimate miss — MB doesn't know this Spotify URL.
      //     Count and move on. (Nothing to persist; no Wikidata pass either,
      //     since no ISRC means the SPARQL lookup will miss anyway.)
      //   - "skipped": bad data from MB. Log the reason so we can spot
      //     systematic issues in the Inngest UI, then move on.
      if (mbResult.status === "ok") {
        await step.run(`db-update-${spotifyId}`, () =>
          updateTrackIsrcAndMbid(spotifyId, {
            isrc: mbResult.isrc ?? null,
            mbid: mbResult.mbid ?? null,
          }),
        );
        refreshedSpotifyIds.push(spotifyId);
        if (mbResult.isrc) filledIsrc += 1;
        else mbidOnly += 1;
      } else if (mbResult.status === "skipped") {
        mbBadData += 1;
        logger.warn("library-backfill-isrc: skipped bad data from MB", {
          spotifyId,
          reason: mbResult.reason,
        });
      } else {
        // status === "not_found"
        mbMiss += 1;
        notFoundSpotifyIds.push(spotifyId);
      }

      // Step 4: rate-limit gate. Skip the sleep after the LAST track so we
      // don't waste a step invocation at end-of-batch. Run it even when the
      // previous track was a skip — the bad-data branches still made an HTTP
      // call (except invalid_spotify_id, which is rare enough not to bother
      // optimising for).
      if (i < candidates.length - 1) {
        await step.sleep(`mb-rate-limit-${i}`, MB_RATE_LIMIT_MS);
      }
    }

    // Step 5: stamp not_found rows as MB-checked so they drain out of the
    // backfill queue (the "ok" rows were already stamped by updateTrackIsrcAndMbid).
    if (notFoundSpotifyIds.length > 0) {
      await step.run("mark-mb-not-found-checked", () =>
        markTracksMusicbrainzChecked(notFoundSpotifyIds),
      );
    }

    // Step 6: hand the refreshed tracks to the Wikidata worker. Skip if
    // nothing got filled — emitting an empty event would just waste an
    // invocation.
    if (refreshedSpotifyIds.length > 0) {
      await step.sendEvent("emit-wikidata-refresh", {
        name: "tracks/enrich-wikidata.requested",
        data: {
          tracks: refreshedSpotifyIds.map((id) => ({ id })),
          source: "library-backfill-isrc",
        },
      });
    }

    const stats = {
      processed: candidates.length,
      filled_isrc: filledIsrc,
      mbid_only: mbidOnly,
      mb_miss: mbMiss,
      mb_bad_data: mbBadData,
      wikidata_redispatched: refreshedSpotifyIds.length,
    };
    logger.info("library-backfill-isrc batch", stats);
    return stats;
  },
);
