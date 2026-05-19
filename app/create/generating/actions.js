"use server";

// Server action invoked from the generating page. Trades the user's Supabase
// session for a Spotify provider token, creates a playlist_jobs row so the UI
// has something to poll on, then fires a `library/sync.requested` event at
// Inngest. The worker (lib/inngest/functions/library-sync.js) takes over from
// there and writes its progress back into the same row.

import { createClient } from "@/lib/supabase/server";
import { inngest } from "@/lib/inngest/client";
import { createPlaylistJob } from "@/lib/library";

export async function startLibrarySync(tags = []) {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user) {
    return { ok: false, error: "not_authenticated" };
  }
  if (!session.provider_token) {
    return { ok: false, error: "missing_spotify_token" };
  }

  const cleanTags = Array.isArray(tags)
    ? tags.map((t) => String(t ?? "").trim()).filter(Boolean).slice(0, 32)
    : [];

  const jobId = await createPlaylistJob(session.user.id, cleanTags);

  await inngest.send({
    name: "library/sync.requested",
    data: {
      userId: session.user.id,
      accessToken: session.provider_token,
      jobId,
    },
  });

  return { ok: true, jobId };
}
