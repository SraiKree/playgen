// GET /api/jobs/[id]
//
// Poll target for the /create/generating page. Returns the live progress
// counters for a single playlist_jobs row, scoped to the requesting user.
//
// Completion is decided HERE rather than inside trackEnrich because many
// enrichment workers run concurrently — they'd race to flip status. The read
// path is naturally single-threaded per request, so this is the cleanest seam.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPlaylistJob, updatePlaylistJob } from "@/lib/library";

export async function GET(_request, { params }) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  let job = await getPlaylistJob(id, user.id);
  if (!job) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Completion check: enrichment is done when every fan-out worker has bumped
  // enrich_done up to enrich_total. The 0/0 case is legitimate — it happens
  // when every saved track was already enriched by a previous sync, so
  // track-enrich refunded all of library-sync's optimistic enrich_total
  // credit. status only becomes 'enriching' after library-sync's loop
  // finishes, so checking against status='enriching' is enough to avoid
  // racing the syncing phase.
  if (
    job.status === "enriching" &&
    job.enrich_done >= job.enrich_total
  ) {
    await updatePlaylistJob(id, {
      status: "completed",
      completed_at: new Date().toISOString(),
    });
    job = { ...job, status: "completed", completed_at: new Date().toISOString() };
  }

  return NextResponse.json({
    id: job.id,
    status: job.status,
    library_total: job.library_total,
    library_done: job.library_done,
    enrich_total: job.enrich_total,
    enrich_done: job.enrich_done,
    error_message: job.error_message,
    started_at: job.started_at,
    completed_at: job.completed_at,
  });
}
