// Layer 1 enrichment worker.
// What this worker does, per batch:
//   1. filter the batch down to rows still NULL on tracks.enriched_at
//   2. upsert artists rows (id + name only, no genres for now)
//   3. write the track_artists junction
//   4. for each track: pull Last.fm top tags, normalize + upsert
//   5. flip tracks.enriched_at

import { inngest } from "../client.js";
import { fetchTrackTopTags } from "@/lib/lastfm";
import {
  getUnenrichedTrackIds,
  upsertArtists,
  linkTrackArtists,
  upsertLastfmTagsForTrack,
  markTracksEnriched,
  incrementJobCounter,
} from "@/lib/library";

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

    // Step 4: per-track Last.fm lookup. One step per track for retry
    // isolation and clean memoization on partial-batch failure.
    for (const t of todoTracks) {
      const primaryArtist = t.artists?.[0]?.name;
      if (!primaryArtist) {
        logger.warn("track-enrich: missing primary artist, skipping Last.fm", {
          trackId: t.id,
        });
        continue;
      }

      const tags = await step.run(`lastfm-tags-${t.id}`, async () => {
        try {
          return await fetchTrackTopTags({
            artist: primaryArtist,
            track: t.name,
          });
        } catch (err) {
          return { __error: String(err?.message ?? err), tags: [] };
        }
      });

      const safeTags = Array.isArray(tags) ? tags : (tags?.tags ?? []);

      await step.run(`upsert-lastfm-tags-${t.id}`, () =>
        upsertLastfmTagsForTrack(t.id, safeTags),
      );
    }

    // Step 5: flip enriched_at for every track we processed.
    await step.run("mark-enriched", () =>
      markTracksEnriched(todoTracks.map((t) => t.id)),
    );

    // Step 6: progress bump. One increment per worker run, after all real
    if (jobId) {
      await step.run("job-bump-enrich-done", () =>
        incrementJobCounter(jobId, "enrich_done", todoTracks.length),
      );
    }

    // Step 7: hand off to the Wikidata worker. Sequential pipeline — by
    // the time this event fires, every track id we pass has its Last.fm
    // bootstrap completed (enriched_at IS NOT NULL). The Wikidata worker
    // gates on exactly that condition (see getTracksNeedingWikidata).
    await step.sendEvent("emit-wikidata", {
      name: "tracks/enrich-wikidata.requested",
      data: {
        tracks: todoTracks.map((t) => ({ id: t.id })),
        jobId,
      },
    });

    return {
      requested: incoming.length,
      enriched: todoTracks.length,
    };
  },
);
