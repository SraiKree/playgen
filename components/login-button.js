"use client";

import { createClient } from "@/lib/supabase/client";

// Scopes Supabase will forward to Spotify. Anything not requested here is unavailable later.
// user-read-email     → Supabase fills the auth.users.email column
// user-library-read   → GET /me/tracks (saved tracks)
// playlist-modify-*   → POST /users/{id}/playlists  and  POST /playlists/{id}/tracks
const SPOTIFY_SCOPES = [
  "user-read-email",
  "user-library-read",
  "playlist-modify-public",
  "playlist-modify-private",
].join(" ");

export function LoginButton() {
  async function handleLogin() {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "spotify",
      options: {
        scopes: SPOTIFY_SCOPES,
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  }

  return (
    <button
      onClick={handleLogin}
      className="flex h-12 items-center justify-center gap-3 rounded-full bg-[#1DB954] px-6 text-base font-medium text-black transition-colors hover:bg-[#1ed760]"
    >
      <svg width="20" height="20" viewBox="0 0 168 168" aria-hidden="true">
        <path
          fill="currentColor"
          d="M83.996.277C37.747.277.253 37.77.253 84.019c0 46.251 37.494 83.741 83.743 83.741 46.254 0 83.744-37.49 83.744-83.741 0-46.246-37.49-83.738-83.745-83.738zm38.404 120.78a5.217 5.217 0 01-7.18 1.73c-19.662-12.01-44.414-14.73-73.564-8.07a5.222 5.222 0 01-6.249-3.93 5.213 5.213 0 013.926-6.25c31.9-7.29 59.263-4.15 81.337 9.34 2.46 1.51 3.24 4.72 1.73 7.18zm10.25-22.805c-1.89 3.075-5.91 4.045-8.98 2.155-22.51-13.839-56.823-17.846-83.448-9.764-3.453 1.043-7.1-.903-8.148-4.35-1.04-3.453.907-7.093 4.354-8.143C84.61 70.292 122.412 74.85 148.34 90.78c3.07 1.89 4.04 5.91 2.155 8.978l.155-.156zm.88-23.744c-26.99-16.031-71.52-17.505-97.289-9.684-4.138 1.255-8.514-1.081-9.768-5.219a7.835 7.835 0 015.221-9.771c29.581-8.98 78.756-7.245 109.83 11.202a7.823 7.823 0 012.74 10.733c-2.2 3.722-7.02 4.949-10.73 2.739z"
        />
      </svg>
      Log in with Spotify
    </button>
  );
}
