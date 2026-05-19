"use server";

// Server action invoked from the generating page. Trades the user's Supabase
// session for a Spotify provider token and fires a `library/sync.requested`
// event at Inngest. The worker (lib/inngest/functions/library-sync.js) takes
// over from there.
//
// Why a server action and not the worker calling Supabase directly?
// Inngest workers don't run inside an HTTP request — they have no access to
// the user's session cookie. Pulling the token here, in the cookie-aware
// boundary, and shipping it inside the event payload is the simplest path.
// CLAUDE.md §5 also reserves the user OAuth token for /me/tracks reads, which
// is exactly what the sync worker uses it for.
//
// Spotify access tokens live ~1 hour, so a library so enormous that sync
// takes longer will fail mid-run. Refresh-token storage is the next milestone.

import { createClient } from "@/lib/supabase/server";
import { inngest } from "@/lib/inngest/client";

export async function startLibrarySync() {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user) {
    return { ok: false, error: "not_authenticated" };
  }
  if (!session.provider_token) {
    // Session exists (Supabase user is valid) but Spotify's token isn't on
    // it — happens if the user signed in long enough ago that the provider
    // token expired without refresh, or if OAuth scopes didn't include
    // user-library-read.
    return { ok: false, error: "missing_spotify_token" };
  }

  // Inngest dedups by event.data.userId for 24h (see library-sync.js
  // idempotency), so calling this twice in quick succession is safe.
  const { ids } = await inngest.send({
    name: "library/sync.requested",
    data: {
      userId: session.user.id,
      accessToken: session.provider_token,
    },
  });

  return { ok: true, eventId: ids[0] };
}
