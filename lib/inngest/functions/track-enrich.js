// Layer 1 enrichment worker.
//
// What this worker does, per batch:
//   1. filter the batch down to rows still NULL on tracks.enriched_at
//   2. upsert artists rows (id + name only, no genres for now)
//   3. write the track_artists junction
//   4. for each track: pull Last.fm top tags, categorize outcome
//      (success / retry / give-up)
//   5. stamp enriched_at for success + give-up; leave retry tracks NULL
//   6. send Wikidata follow-up for everything that exited the queue
//
// Failure handling (migration 0006):
//   * Transient Last.fm failures used to silently stamp enriched_at = NOW()
//     with zero tags. That made transient errors indistinguishable from
//     legitimate "no Last.fm tags found" results forever.
//   * Now: per-track failures call record_lastfm_failure (atomic increment
//     of lastfm_attempt_count + last_error capture). Tracks that exceed
//     MAX_LASTFM_ATTEMPTS are stamped enriched_at as "gave up" with the
//     error preserved; sub-cap tracks stay in the queue for a later retry
//     (cron pickup, currently disabled until B2).

import { inngest } from "../client.js";
import { fetchTrackTopTags } from "@/lib/lastfm";
import {
  getUnenrichedTrackIds,
  upsertArtists,
  linkTrackArtists,
  upsertLastfmTagsForTrack,
  markTracksEnrichedSuccess,
  markTracksGaveUp,
  recordLastfmFailure,
  incrementJobCounter,
} from "@/lib/library";

// After this many failed Last.fm attempts on the same track, stop retrying
// and stamp enriched_at as a give-up (lastfm_last_error retained). Five is a
// pragmatic ceiling: enough to ride out a Last.fm degradation window
// (~minutes), few enough that a permanently-broken track-name lookup doesn't
// loop forever.
const MAX_LASTFM_ATTEMPTS = 5;

export const trackEnrich = inngest.createFunction(
  {
    id: "track-enrich",
    name: "Layer 1 enrichment (Last.fm)",
    triggers: [{ event: "tracks/enrich.requested" }],
    concurrency: [{ scope: "fn", limit: 5 }],
    retries: 3,
  },
  async ({ event, step, logger }) => {
    const incoming = event.data?.tracks ?? [];
    const jobId = event.data?.jobId ?? null;
    if (incoming.length === 0) {
      return { skipped: "empty", source: event.data?.source };
    }

    // Step 1: filter to rows that still need enrichment.
    const incomingIds = incoming.map((t) => t.id);
    const todoIds = await step.run("filter-unenriched", () =>
      getUnenrichedTrackIds(incomingIds),
    );
    if (todoIds.length === 0) {
      if (jobId) {
        await step.run("job-refund-all-enriched", () =>
          incrementJobCounter(jobId, "enrich_total", -incoming.length),
        );
      }
      return { skipped: "all-enriched", incoming: incoming.length };
    }
    const todoSet = new Set(todoIds);
    const todoTracks = incoming.filter((t) => todoSet.has(t.id));
    if (jobId) {
      const skipped = incoming.length - todoTracks.length;
      if (skipped > 0) {
        await step.run("job-refund-partial", () =>
          incrementJobCounter(jobId, "enrich_total", -skipped),
        );
      }
    }

    // Step 2: upsert artist rows. We only have id + name from /me/tracks
    // (Spotify /artists is blocked for our client_credentials — see CLAUDE.md
    // memory `spotify_client_credentials_blocked`). Genres stay empty for now.
    const artists = [];
    const seenArtists = new Set();
    for (const t of todoTracks) {
      for (const a of t.artists ?? []) {
        if (!a?.id || seenArtists.has(a.id)) continue;
        seenArtists.add(a.id);
        artists.push({ id: a.id, name: a.name });
      }
    }
    if (artists.length > 0) {
      await step.run("upsert-artists", () => upsertArtists(artists));
    }

    // Step 3: track_artists junction.
    const linkRows = todoTracks.flatMap((t) =>
      (t.artists ?? [])
        .filter((a) => a?.id)
        .map((a, position) => ({
          trackSpotifyId: t.id,
          artistSpotifyId: a.id,
          position,
        })),
    );
    if (linkRows.length > 0) {
      await step.run("link-track-artists", () => linkTrackArtists(linkRows));
    }

    // Step 4: per-track Last.fm lookup + outcome categorization.
    //
    // The fetch and the failure-recording sit inside ONE step.run so the
    // attempt counter is atomic with the fetch attempt — if the function
    // re-runs (Inngest retry), an already-resolved step returns its memoized
    // outcome and we don't double-count. The upsert is a separate step so DB
    // blips during junction-write retry independently of the Last.fm call.
    //
    // Per-track outcomes:
    //   "success"  -> tags upserted, will get enriched_at stamped, last_error cleared
    //   "give_up"  -> attempt_count >= MAX or unrecoverable error; will get
    //                 enriched_at stamped, last_error retained as audit trail
    //   "retry"    -> failure under retry cap; enriched_at stays NULL so the
    //                 track stays in tracks_unenriched_idx for a later attempt
    const outcomes = [];

    for (const t of todoTracks) {
      const result = await step.run(`lastfm-fetch-${t.id}`, async () => {
        const primaryArtist = t.artists?.[0]?.name;

        // Missing primary artist is a permanent failure — we have no way to
        // query Last.fm without an artist name. Record the failure (for the
        // audit trail) and give up immediately rather than burning retries
        // on a hopeless case.
        if (!primaryArtist) {
          await recordLastfmFailure(t.id, "missing-primary-artist");
          return { status: "give_up", tags: null };
        }

        try {
          const tags = await fetchTrackTopTags({
            artist: primaryArtist,
            track: t.name,
          });
          return { status: "success", tags };
        } catch (err) {
          const errMsg = String(err?.message ?? err);
          const attempts = await recordLastfmFailure(t.id, errMsg);
          return {
            status: attempts >= MAX_LASTFM_ATTEMPTS ? "give_up" : "retry",
            tags: null,
          };
        }
      });

      // Only upsert on success — give-up and retry leave the tags table alone.
      if (result.status === "success") {
        const safeTags = Array.isArray(result.tags)
          ? result.tags
          : (result.tags?.tags ?? []);
        await step.run(`lastfm-upsert-${t.id}`, () =>
          upsertLastfmTagsForTrack(t.id, safeTags),
        );
      } else if (result.status === "give_up") {
        logger.warn("track-enrich: giving up on Last.fm after max attempts", {
          trackId: t.id,
        });
      }

      outcomes.push({ id: t.id, status: result.status });
    }

    // Step 5: partition outcomes and apply.
    const successIds = outcomes
      .filter((o) => o.status === "success")
      .map((o) => o.id);
    const giveUpIds = outcomes
      .filter((o) => o.status === "give_up")
      .map((o) => o.id);
    const retryIds = outcomes
      .filter((o) => o.status === "retry")
      .map((o) => o.id);

    if (successIds.length > 0) {
      await step.run("mark-enriched-success", () =>
        markTracksEnrichedSuccess(successIds),
      );
    }
    if (giveUpIds.length > 0) {
      await step.run("mark-given-up", () => markTracksGaveUp(giveUpIds));
    }

    // The set of tracks that EXITED the queue in this run — both success and
    // give-up. Wikidata's gate is `enriched_at IS NOT NULL`, so both flow on.
    const completedIds = [...successIds, ...giveUpIds];

    // Step 6: job counters.
    if (jobId) {
      // enrich_done counts what crossed the finish line this run.
      if (completedIds.length > 0) {
        await step.run("job-bump-enrich-done", () =>
          incrementJobCounter(jobId, "enrich_done", completedIds.length),
        );
      }
      // For retry tracks, refund enrich_total so the user-facing progress bar
      // can reach completion. The next worker invocation (next library sync
      // or future cron) will re-add them to the total when it picks them up.
      if (retryIds.length > 0) {
        await step.run("job-refund-retries", () =>
          incrementJobCounter(jobId, "enrich_total", -retryIds.length),
        );
      }
    }

    // Step 7: hand off to the Wikidata worker for tracks that have an
    // enriched_at timestamp now (success + give-up). Give-ups still carry an
    // ISRC from /me/tracks and Wikidata may still find them — no reason to
    // skip them just because Last.fm couldn't.
    if (completedIds.length > 0) {
      await step.sendEvent("emit-wikidata", {
        name: "tracks/enrich-wikidata.requested",
        data: {
          tracks: completedIds.map((id) => ({ id })),
          jobId,
        },
      });
    }

    return {
      requested: incoming.length,
      success: successIds.length,
      gaveUp: giveUpIds.length,
      retrying: retryIds.length,
    };
  },
);
