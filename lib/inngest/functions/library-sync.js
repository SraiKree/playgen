// Background sync of one user's Spotify "Liked Songs" into the global tracks
// cache + their personal user_library link rows.
//
// This file ORCHESTRATES — it never contains raw fetch() or supabase.from(...)
// calls.
import { inngest } from "../client.js";
import { fetchSavedTracks } from "@/lib/spotify";
import {
  upsertTracks,
  backfillTrackIsrcs,
  linkTracksToUser,
  updatePlaylistJob,
  incrementJobCounter,
} from "@/lib/library";

// One page of Spotify's /me/tracks. Must match the BATCH_LIMIT in lib/spotify.js
const PAGE_SIZE = 50;

export const librarySync = inngest.createFunction(
  {
    id: "library-sync",
    name: "Sync a user's Spotify saved tracks",
    triggers: [{ event: "library/sync.requested" }],
    concurrency: [
      { scope: "fn", limit: 5 },
      { scope: "fn", key: "event.data.userId", limit: 1 },
    ],
    idempotency: "event.data.jobId",
    retries: 3,
  },
  async ({ event, step }) => {
    const { userId, accessToken, jobId } = event.data;
    try {
      if (jobId) {
        await step.run("job-start", () =>
          updatePlaylistJob(jobId, { status: "syncing" }),
        );
      }

      let offset = 0;
      let total = 0;
      let pages = 0;
      let totalRecorded = false;

      // Manual pagination: Spotify's /me/tracks returns { items, next, total }.
      while (true) {
        const page = await step.run(`fetch-page-${offset}`, () =>
          fetchSavedTracks(accessToken, { offset, limit: PAGE_SIZE }),
        );

        if (jobId && !totalRecorded && typeof page?.total === "number") {
          await step.run("job-set-library-total", () =>
            updatePlaylistJob(jobId, { library_total: page.total }),
          );
          totalRecorded = true;
        }

        const items = (page?.items ?? []).filter((i) => i?.track?.id);
        const tracks = items.map((i) => i.track);
        const linkRows = items.map((i) => ({
          spotifyId: i.track.id,
          addedAt: i.added_at,
        }));

        if (tracks.length > 0) {
          await step.run(`upsert-page-${offset}`, () => upsertTracks(tracks));
          // Backfill isrc on rows that predate ISRC capture — upsertTracks does
          // ON CONFLICT DO NOTHING, so only this fills them (migration 0016).
          await step.run(`backfill-isrc-${offset}`, () =>
            backfillTrackIsrcs(tracks),
          );
          await step.run(`link-page-${offset}`, () =>
            linkTracksToUser(userId, linkRows),
          );
          await step.sendEvent(`emit-enrich-${offset}`, {
            name: "tracks/enrich.requested",
            data: {
              tracks: tracks.map((t) => ({
                id: t.id,
                name: t.name,
                artists: (t.artists ?? []).map((a) => ({
                  id: a.id,
                  name: a.name,
                })),
              })),
              source: "library-sync",
              jobId,
            },
          });

          if (jobId) {
            await step.run(`job-bump-library-${offset}`, () =>
              incrementJobCounter(jobId, "library_done", tracks.length),
            );
            await step.run(`job-bump-enrich-total-${offset}`, () =>
              incrementJobCounter(jobId, "enrich_total", tracks.length),
            );
          }
        }

        total += tracks.length;
        pages += 1;

        if (!page?.next) break;
        offset += PAGE_SIZE;
      }

      if (jobId) {
        // Library phase is done; enrichment workers take over. If `total` is
        // 0 (empty library or all-skipped page), there's nothing to enrich, so
        // mark the job completed right here — the API route's completion
        // check needs enrich_total > 0 to fire.
        if (total === 0) {
          await step.run("job-complete-empty", () =>
            updatePlaylistJob(jobId, {
              status: "completed",
              completed_at: new Date().toISOString(),
            }),
          );
        } else {
          await step.run("job-enter-enriching", () =>
            updatePlaylistJob(jobId, { status: "enriching" }),
          );
        }
      }

      return { userId, pages, total };
    } catch (err) {
      // Best-effort: record the failure on the job row so the UI can show it.
      if (jobId) {
        try {
          await updatePlaylistJob(jobId, {
            status: "failed",
            error_message: String(err?.message ?? err).slice(0, 1000),
          });
        } catch {

        }
      }
      throw err;
    }
  },
);
