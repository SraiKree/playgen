-- ============================================================================
-- 0009_tag_vote_xp.sql
-- XP / gamification for community tagging.
--
-- When user A submits a tag and a DIFFERENT user B votes on it:
--   * Author A:  +5 XP on an upvote, -5 XP on a downvote (same magnitude,
--                opposite sign — "a like or a dislike has the same XP").
--   * Voter  B:  +1 XP for casting ANY vote (up or down); never penalized.
--   * Self-votes (voter = author) earn nothing.
--   * Reversal is symmetric — removing or flipping a vote recomputes both
--     parties from the vote's CURRENT state, so vote/unvote can't farm XP.
--
-- XP is awarded by a SECURITY DEFINER trigger on tag_votes because RLS
-- (profiles_update_own, 0001) forbids a voter from writing the AUTHOR's
-- profile row. The trigger runs as its owner and bypasses RLS — same pattern
-- as handle_new_user() in 0001. No application code changes: the existing
-- setVote / clearVote paths already write tag_votes; the trigger does the rest.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- profiles.xp — cached running total, maintained by the trigger below.
-- May go negative if an author is net-downvoted; that's acceptable for now
-- (no UI yet). A future display can clamp at 0 if desired.
-- ---------------------------------------------------------------------------
alter table public.profiles add column xp integer not null default 0;


-- ---------------------------------------------------------------------------
-- xp_events — append-only ledger. One row per (vote, beneficiary-role) so the
-- trigger can reverse a vote's effect exactly. profiles.xp is the cached sum.
--
-- No FK on vote_id by design: a real FK to tag_votes(id) ON DELETE CASCADE
-- would race the trigger (cascade could drop ledger rows around our reversal
-- logic, stranding profiles.xp). The trigger owns this table's lifecycle.
-- unique (vote_id, source_type) guarantees a vote is never double-credited.
-- ---------------------------------------------------------------------------
create table public.xp_events (
  id           bigint      generated always as identity primary key,
  user_id      uuid        not null references auth.users(id) on delete cascade,
  amount       integer     not null,             -- signed: +5 / -5 / +1
  source_type  text        not null,             -- 'tag_vote_author' | 'tag_vote_voter'
  vote_id      bigint      not null,             -- tag_votes.id this event came from
  created_at   timestamptz not null default now(),
  unique (vote_id, source_type)
);

create index xp_events_user_id_idx on public.xp_events (user_id);
create index xp_events_vote_id_idx on public.xp_events (vote_id);


-- ============================================================================
-- Trigger function: apply_tag_vote_xp
-- BEFORE INSERT/UPDATE/DELETE on tag_votes. BEFORE (not AFTER) so that on
-- DELETE the row + its ledger entries still exist for clean reversal, and so
-- the generated identity id is already populated on INSERT.
--
-- Strategy: delete-then-recompute. We first reverse + clear any XP recorded
-- for this vote, then (if the vote still exists) recompute from its current
-- state. This makes INSERT, UPDATE (vote flip) and DELETE all uniform.
-- ============================================================================
create or replace function public.apply_tag_vote_xp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vote_id bigint := coalesce(new.id, old.id);
  v_author  uuid;
  rec       record;
begin
  -- 1. Reverse any XP previously recorded for this vote, then clear its events.
  for rec in
    select user_id, amount from public.xp_events where vote_id = v_vote_id
  loop
    update public.profiles set xp = xp - rec.amount where id = rec.user_id;
  end loop;
  delete from public.xp_events where vote_id = v_vote_id;

  -- 2. If the vote still exists (INSERT/UPDATE), recompute from current state.
  if tg_op <> 'DELETE' then
    select ut.submitted_by into v_author
      from public.user_tags ut where ut.id = new.user_tag_id;

    -- Only award when the voter is NOT the tag's author (no self-credit).
    if v_author is not null and v_author <> new.voter_id then
      -- Author: +5 on upvote (vote = 1), -5 on downvote (vote = -1).
      insert into public.xp_events (user_id, amount, source_type, vote_id)
        values (v_author, new.vote * 5, 'tag_vote_author', v_vote_id);
      update public.profiles set xp = xp + (new.vote * 5) where id = v_author;

      -- Voter: +1 for participating, regardless of up/down.
      insert into public.xp_events (user_id, amount, source_type, vote_id)
        values (new.voter_id, 1, 'tag_vote_voter', v_vote_id);
      update public.profiles set xp = xp + 1 where id = new.voter_id;
    end if;
  end if;

  -- Return OLD on DELETE so the delete proceeds; NEW otherwise.
  return coalesce(new, old);
end;
$$;

create trigger tag_votes_xp
  before insert or update or delete on public.tag_votes
  for each row execute function public.apply_tag_vote_xp();


-- ============================================================================
-- Row Level Security + lockdown for xp_events.
-- Users may read only their own ledger. No write policies — the SECURITY
-- DEFINER trigger is the only writer (and it bypasses RLS). Mirrors the
-- anon-revoke / definer-revoke pattern from 0002.
-- ============================================================================
alter table public.xp_events enable row level security;
alter table public.xp_events force  row level security;

create policy xp_events_select_own on public.xp_events
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke select on public.xp_events from anon;
revoke execute on function public.apply_tag_vote_xp() from public;
revoke execute on function public.apply_tag_vote_xp() from anon;
revoke execute on function public.apply_tag_vote_xp() from authenticated;


-- ============================================================================
-- Backfill: seed the ledger + profiles.xp from votes that already exist.
-- Self-votes (author = voter) are excluded, matching the live rule.
-- ============================================================================
insert into public.xp_events (user_id, amount, source_type, vote_id)
select ut.submitted_by, tv.vote * 5, 'tag_vote_author', tv.id
from public.tag_votes tv
join public.user_tags ut on ut.id = tv.user_tag_id
where ut.submitted_by <> tv.voter_id;

insert into public.xp_events (user_id, amount, source_type, vote_id)
select tv.voter_id, 1, 'tag_vote_voter', tv.id
from public.tag_votes tv
join public.user_tags ut on ut.id = tv.user_tag_id
where ut.submitted_by <> tv.voter_id;

update public.profiles p
set xp = coalesce(
  (select sum(e.amount) from public.xp_events e where e.user_id = p.id),
  0
);
