// Pure DB operations for tracks/library. Uses the Supabase service-role client.
// Per CLAUDE.md: writes from Inngest use the POOLED connection string (port 6543).

// TODO: upsertTracks(tracks[])                        // ON CONFLICT (spotify_id) DO NOTHING
// TODO: linkTracksToUser(userId, spotifyIds[])
// TODO: getUnenrichedTrackIds(spotifyIds[])
// TODO: writeAudioFeatures(features[])
