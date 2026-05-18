-- ============================================================================
-- 0001_initial_schema.sql
-- Initial schema for playgen: tracks + tags (Layer 1 + Layer 2).
-- See CLAUDE.md §2 (enrichment model), §4 (guardrails), §6 (community tagging).
-- Design follows supabase-postgres-best-practices: bigint identity PKs,
-- indexed FKs, RLS with (select auth.uid()) wrapping for performance.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- profiles — extends auth.users 1:1 with project-specific fields.
-- We need spotify_user_id for the playlist-create call, and created_at for the
-- new-account vote-weight (sybil mitigation, CLAUDE.md §6).
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                    uuid        primary key references auth.users(id) on delete cascade,
  spotify_user_id       text        unique,
  created_at            timestamptz not null default now(),
  last_library_sync_at  timestamptz
);


-- ---------------------------------------------------------------------------
-- artists — global cache. Genres are frozen Spotify metadata.
-- ---------------------------------------------------------------------------
create table public.artists (
  id           bigint      generated always as identity primary key,
  spotify_id   text        not null unique,
  name         text        not null,
  genres       text[]      not null default '{}',
  popularity   smallint,
  enriched_at  timestamptz,
  created_at   timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- tracks — global cache. Per CLAUDE.md §2 Layer 1 fields are frozen at enrich.
-- release_date_precision preserves Spotify's "day"/"month"/"year" granularity.
-- ---------------------------------------------------------------------------
create table public.tracks (
  id                      bigint      generated always as identity primary key,
  spotify_id              text        not null unique,
  name                    text        not null,
  album_name              text,
  album_image_url         text,
  duration_ms             integer,
  popularity              smallint,
  release_date            date,
  release_date_precision  text        check (release_date_precision in ('day','month','year')),
  preview_url             text,
  enriched_at             timestamptz,
  created_at              timestamptz not null default now()
);

-- Partial index: the worker queue of "tracks that still need enrichment".
-- Tiny because it only stores rows with NULL enriched_at.
create index tracks_unenriched_idx on public.tracks (id) where enriched_at is null;


-- ---------------------------------------------------------------------------
-- track_artists — junction (many-to-many). position = Spotify's artist order.
-- ---------------------------------------------------------------------------
create table public.track_artists (
  track_id   bigint   not null references public.tracks(id)  on delete cascade,
  artist_id  bigint   not null references public.artists(id) on delete cascade,
  position   smallint not null,
  primary key (track_id, artist_id)
);

-- PK is (track_id, artist_id) — covers track→artists lookups.
-- Reverse direction (all tracks by an artist) needs its own index.
create index track_artists_artist_id_idx on public.track_artists (artist_id);


-- ---------------------------------------------------------------------------
-- tags — canonical normalized dictionary. Application (lib/library.js) lowercases
-- + trims + fuzzy-merges BEFORE insert. The DB only enforces uniqueness.
-- Synthetic id (not name as PK) so a future fuzzy-merge can repoint child rows.
-- ---------------------------------------------------------------------------
create table public.tags (
  id         bigint      generated always as identity primary key,
  name       text        not null unique,
  created_at timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- track_tags_lastfm — Layer 1 frozen Last.fm tag snapshot.
-- Per CLAUDE.md §4: never refetched. lastfm_count is the raw 0–100 Last.fm score.
-- ---------------------------------------------------------------------------
create table public.track_tags_lastfm (
  track_id      bigint   not null references public.tracks(id) on delete cascade,
  tag_id        bigint   not null references public.tags(id)   on delete cascade,
  lastfm_count  smallint not null,
  primary key (track_id, tag_id)
);

create index track_tags_lastfm_tag_id_idx on public.track_tags_lastfm (tag_id);


-- ---------------------------------------------------------------------------
-- user_tags — Layer 2 community-submitted tags.
-- UNIQUE(track_id, tag_id, submitted_by): one of each tag per user per track.
-- hidden = soft-delete (CLAUDE.md §6 keeps audit trail for moderation).
-- ---------------------------------------------------------------------------
create table public.user_tags (
  id            bigint      generated always as identity primary key,
  track_id      bigint      not null references public.tracks(id)    on delete cascade,
  tag_id        bigint      not null references public.tags(id)      on delete cascade,
  submitted_by  uuid        not null references auth.users(id)       on delete cascade,
  hidden        boolean     not null default false,
  created_at    timestamptz not null default now(),
  unique (track_id, tag_id, submitted_by)
);

-- Hot path: visible community tags for a given track. Partial index trims
-- soft-deleted rows from the index entirely.
create index user_tags_track_visible_idx on public.user_tags (track_id) where hidden = false;
create index user_tags_submitted_by_idx  on public.user_tags (submitted_by);
create index user_tags_tag_id_idx        on public.user_tags (tag_id);


-- ---------------------------------------------------------------------------
-- tag_votes — votes on user_tags.
-- UNIQUE(user_tag_id, voter_id) enforces "one vote per user per tag" (§6).
-- Votes are hard-deletable (retract); only the tag itself is soft-deleted.
-- ---------------------------------------------------------------------------
create table public.tag_votes (
  id           bigint      generated always as identity primary key,
  user_tag_id  bigint      not null references public.user_tags(id) on delete cascade,
  voter_id     uuid        not null references auth.users(id)       on delete cascade,
  vote         smallint    not null check (vote in (-1, 1)),
  created_at   timestamptz not null default now(),
  unique (user_tag_id, voter_id)
);

-- PK already covers user_tag_id-first lookups. Index voter_id for FK reverse.
create index tag_votes_voter_id_idx on public.tag_votes (voter_id);


-- ---------------------------------------------------------------------------
-- user_library — links a Supabase user to tracks in their Spotify "Liked Songs".
-- added_at  = Spotify's added_at (when the USER liked it)
-- imported_at = when OUR sync job pulled the row
-- ---------------------------------------------------------------------------
create table public.user_library (
  user_id      uuid        not null references auth.users(id)   on delete cascade,
  track_id     bigint      not null references public.tracks(id) on delete cascade,
  added_at     timestamptz not null,
  imported_at  timestamptz not null default now(),
  primary key (user_id, track_id)
);

create index user_library_track_id_idx on public.user_library (track_id);


-- ============================================================================
-- View: user_tag_scores
-- Computes the community-tag confidence signal in one place. Threshold (>= 2)
-- is applied by callers, not here — different callers may want different bars.
-- security_invoker = true: view enforces caller's RLS, not view-owner's.
-- ============================================================================
create or replace view public.user_tag_scores
with (security_invoker = true)
as
select
  ut.id            as user_tag_id,
  ut.track_id,
  ut.tag_id,
  ut.submitted_by,
  ut.hidden,
  coalesce(sum(
    tv.vote::numeric * case
      when (now() - p.created_at) < interval '14 days' then 0.25
      else 1.0
    end
  ), 0)            as score,
  count(tv.id)     as vote_count
from public.user_tags ut
left join public.tag_votes tv on tv.user_tag_id = ut.id
left join public.profiles  p  on p.id = tv.voter_id
group by ut.id;


-- ============================================================================
-- Trigger: auto-create profile row when a Supabase auth.user signs up.
-- Without this, FK lookups in tag_votes / user_tags fail for fresh users.
-- security definer is required to write into public schema from an auth-schema
-- trigger; search_path is locked down per Supabase security guidance.
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ============================================================================
-- Row Level Security
-- Pattern: enable + force, then policies that wrap auth.uid() in (select ...)
-- so PG evaluates it once per query, not once per row.
-- Service-role bypasses RLS by design — that's how Inngest writes succeed.
-- ============================================================================

-- profiles: everyone authenticated can read (we'll join to show authors);
-- users can only update their own row.
alter table public.profiles enable row level security;
alter table public.profiles force  row level security;
create policy profiles_select_all on public.profiles
  for select to authenticated using (true);
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- artists, tracks, tags, track_artists, track_tags_lastfm: read-only for users.
-- Writes happen via service-role from Inngest workers.
alter table public.artists enable row level security;
alter table public.artists force  row level security;
create policy artists_select_all on public.artists
  for select to authenticated using (true);

alter table public.tracks enable row level security;
alter table public.tracks force  row level security;
create policy tracks_select_all on public.tracks
  for select to authenticated using (true);

alter table public.track_artists enable row level security;
alter table public.track_artists force  row level security;
create policy track_artists_select_all on public.track_artists
  for select to authenticated using (true);

alter table public.tags enable row level security;
alter table public.tags force  row level security;
create policy tags_select_all on public.tags
  for select to authenticated using (true);

alter table public.track_tags_lastfm enable row level security;
alter table public.track_tags_lastfm force  row level security;
create policy track_tags_lastfm_select_all on public.track_tags_lastfm
  for select to authenticated using (true);

-- user_tags: everyone reads, users INSERT only their own, UPDATE only their own
-- (so they can soft-delete via hidden=true). No DELETE policy — hard-delete blocked.
alter table public.user_tags enable row level security;
alter table public.user_tags force  row level security;
create policy user_tags_select_all on public.user_tags
  for select to authenticated using (true);
create policy user_tags_insert_own on public.user_tags
  for insert to authenticated
  with check (submitted_by = (select auth.uid()));
create policy user_tags_update_own on public.user_tags
  for update to authenticated
  using (submitted_by = (select auth.uid()))
  with check (submitted_by = (select auth.uid()));

-- tag_votes: everyone reads, users INSERT / UPDATE / DELETE only their own.
alter table public.tag_votes enable row level security;
alter table public.tag_votes force  row level security;
create policy tag_votes_select_all on public.tag_votes
  for select to authenticated using (true);
create policy tag_votes_insert_own on public.tag_votes
  for insert to authenticated
  with check (voter_id = (select auth.uid()));
create policy tag_votes_update_own on public.tag_votes
  for update to authenticated
  using (voter_id = (select auth.uid()))
  with check (voter_id = (select auth.uid()));
create policy tag_votes_delete_own on public.tag_votes
  for delete to authenticated
  using (voter_id = (select auth.uid()));

-- user_library: strictly owner-scoped. Writes happen via service-role from the
-- Inngest sync worker, but a policy lets the user manage their own rows too.
alter table public.user_library enable row level security;
alter table public.user_library force  row level security;
create policy user_library_select_own on public.user_library
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy user_library_insert_own on public.user_library
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy user_library_delete_own on public.user_library
  for delete to authenticated
  using (user_id = (select auth.uid()));
