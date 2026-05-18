// Pure Spotify Web API functions. No Inngest, no Next.js — just fetch + transforms.
// Per CLAUDE.md: Inngest functions orchestrate these; they don't contain raw Spotify logic.
//
// Auth split (CLAUDE.md §4):
//   - App token (Client Credentials)  → backend metadata enrichment (artists, tracks lookups)
//   - User token (OAuth via Supabase) → saved-tracks reads, playlist creation

const SPOTIFY_API = "https://api.spotify.com/v1";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

// Spotify caps several endpoints at 50 IDs per call. CLAUDE.md applies this as a project-wide ceiling.
const BATCH_LIMIT = 50;

// Module-scope cache for the app (Client Credentials) token.
// Survives across invocations within the same warm Node process.
let cachedAppToken = null;
let cachedAppTokenExpiresAt = 0; // unix ms

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Thin wrapper: bearer auth + JSON parsing + error surfacing.
// Spotify returns useful error bodies; we include them in the thrown message so Inngest logs are diagnosable.
async function spotifyFetch(accessToken, path, init = {}) {
  const res = await fetch(`${SPOTIFY_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const retryAfter = res.headers.get("retry-after");
    throw new Error(
      `Spotify ${res.status} ${res.statusText} on ${path}${retryAfter ? ` (retry-after=${retryAfter}s)` : ""}: ${body}`,
    );
  }

  // 204 No Content (e.g., adding tracks to playlist sometimes responds with a snapshot but a no-body 200 is also possible).
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Client Credentials Flow → app access token.
 * Used by enrichment workers that read public metadata (artists, tracks) without acting on a user's behalf.
 * Token is cached at module scope; refetched 60s before expiry as a safety margin.
 */
export async function getAppAccessToken() {
  const now = Date.now();
  if (cachedAppToken && now < cachedAppTokenExpiresAt - 60_000) {
    return cachedAppToken;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  // System-boundary validation: missing env vars produce a misleading 400 from Spotify; fail loudly here instead.
  if (!clientId || !clientSecret) {
    throw new Error("SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set in environment");
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Spotify token endpoint ${res.status} ${res.statusText}: ${body}`);
  }

  const json = await res.json();
  cachedAppToken = json.access_token;
  cachedAppTokenExpiresAt = Date.now() + json.expires_in * 1000;
  return cachedAppToken;
}

/**
 * The current user's Spotify profile. Needed before creating a playlist —
 * `POST /users/{user_id}/playlists` requires the user's Spotify ID, not their Supabase user id.
 */
export async function getCurrentUserProfile(userAccessToken) {
  return spotifyFetch(userAccessToken, "/me");
}

/**
 * One page of the user's "Liked Songs" library.
 * Caller (Inngest) handles pagination by stepping through offsets.
 *
 * @param {string} userAccessToken
 * @param {{ offset: number, limit?: number }} opts  limit is clamped to BATCH_LIMIT (50)
 * @returns Spotify's saved-tracks page object: { items, total, next, offset, limit }
 */
export async function fetchSavedTracks(userAccessToken, { offset, limit = BATCH_LIMIT }) {
  const safeLimit = Math.min(limit, BATCH_LIMIT);
  const params = new URLSearchParams({ offset: String(offset), limit: String(safeLimit) });
  return spotifyFetch(userAccessToken, `/me/tracks?${params}`);
}

/**
 * Fetch artist objects (with `genres`, `popularity`, `followers`) in batches.
 * Used during track enrichment to pull genres into the tracks cache.
 * Returns a flat array preserving input ordering; missing artists appear as null.
 */
export async function fetchArtistsBatch(appAccessToken, artistIds) {
  const out = [];
  for (const ids of chunk(artistIds, BATCH_LIMIT)) {
    const json = await spotifyFetch(appAccessToken, `/artists?ids=${ids.join(",")}`);
    out.push(...json.artists);
  }
  return out;
}

/**
 * Fetch track objects in batches. Use this to refresh `popularity` or to look up
 * tracks that were imported by another user but referenced (e.g., shared playlist URIs).
 */
export async function fetchTracksBatch(appAccessToken, trackIds) {
  const out = [];
  for (const ids of chunk(trackIds, BATCH_LIMIT)) {
    const json = await spotifyFetch(appAccessToken, `/tracks?ids=${ids.join(",")}`);
    out.push(...json.tracks);
  }
  return out;
}

/**
 * Create a playlist and add tracks to it.
 *
 * @param {string} userAccessToken    user's Spotify OAuth token (NOT app token)
 * @param {object} opts
 * @param {string} opts.userId        Spotify user ID — from getCurrentUserProfile(...).id
 * @param {string} opts.name
 * @param {string} [opts.description]
 * @param {boolean} [opts.isPublic]   defaults to false
 * @param {string[]} opts.trackUris   "spotify:track:..." URIs; chunked to BATCH_LIMIT
 * @returns the created playlist object (note: snapshot IDs from track-add are not surfaced; refetch if needed)
 */
export async function createPlaylist(
  userAccessToken,
  { userId, name, description = "", isPublic = false, trackUris },
) {
  const playlist = await spotifyFetch(userAccessToken, `/users/${encodeURIComponent(userId)}/playlists`, {
    method: "POST",
    body: JSON.stringify({ name, description, public: isPublic }),
  });

  for (const uris of chunk(trackUris, BATCH_LIMIT)) {
    await spotifyFetch(userAccessToken, `/playlists/${playlist.id}/tracks`, {
      method: "POST",
      body: JSON.stringify({ uris }),
    });
  }

  return playlist;
}
