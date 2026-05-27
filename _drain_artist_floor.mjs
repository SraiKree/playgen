// TEMP drain (deleted after). Same logic as the artist-enrich worker; processes
// ALL pending artists (tags_enriched_at IS NULL) to bring the floor to full
// coverage now, rather than waiting for the hourly cron. Run:
//   node --env-file=.env.local _drain_artist_floor.mjs
import { createClient } from "@supabase/supabase-js";

const LIMIT = 2000;
const MIN_TAG_COUNT = 10;
const MAX_ARTIST_TAGS = 8;
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeTag(name) {
  return String(name ?? "").toLowerCase().trim().normalize("NFD")
    .replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, " ").trim();
}

async function fetchArtistTopTags(artist) {
  const p = new URLSearchParams({
    method: "artist.getTopTags", artist, autocorrect: "1",
    api_key: process.env.LASTFM_API_KEY, format: "json",
  });
  const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${p}`);
  if (!res.ok) throw new Error("lastfm " + res.status);
  const json = await res.json();
  if (json && typeof json.error === "number") {
    if (json.error === 6) return [];
    throw new Error(`lastfm error ${json.error}`);
  }
  const arr = Array.isArray(json?.toptags?.tag) ? json.toptags.tag : [];
  return arr.map((t) => ({ name: String(t.name ?? "").trim(), count: Number(t.count) || 0 }))
    .filter((t) => t.name.length > 0 && t.count >= MIN_TAG_COUNT);
}

async function upsertArtistTags(artistId, tags) {
  const byName = new Map();
  for (const t of tags) {
    const norm = normalizeTag(t.name);
    if (!norm) continue;
    if (!byName.has(norm) || t.count > byName.get(norm)) byName.set(norm, t.count);
  }
  if (!byName.size) return;
  const top = [...byName.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_ARTIST_TAGS);
  const names = top.map(([n]) => n);
  await supabase.from("tags").upsert(names.map((name) => ({ name })), { onConflict: "name", ignoreDuplicates: true });
  const { data: tagRows } = await supabase.from("tags").select("id,name").in("name", names);
  const tid = new Map((tagRows ?? []).map((r) => [r.name, r.id]));
  const rows = top.map(([name, count]) => ({ artist_id: artistId, tag_id: tid.get(name), source: "lastfm", lastfm_count: Math.max(0, Math.min(100, Math.trunc(count))) })).filter((r) => r.tag_id !== undefined);
  if (rows.length) await supabase.from("artist_tags").upsert(rows, { onConflict: "artist_id,tag_id,source", ignoreDuplicates: true });
}

const { data: artists, error } = await supabase
  .from("artists").select("id, name").is("tags_enriched_at", null).limit(LIMIT);
if (error) throw new Error(error.message);

let hits = 0, empty = 0;
for (const a of artists) {
  try {
    const tags = await fetchArtistTopTags(a.name);
    if (tags.length) { await upsertArtistTags(a.id, tags); hits++; } else empty++;
  } catch (e) { console.error("  !", a.name, e.message); empty++; }
  await supabase.from("artists").update({ tags_enriched_at: new Date().toISOString() }).eq("id", a.id);
  await sleep(210);
}
console.log(JSON.stringify({ processed: artists.length, hits, empty }));
