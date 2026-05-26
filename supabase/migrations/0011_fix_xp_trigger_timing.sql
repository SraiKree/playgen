-- ============================================================================
-- 0011_fix_xp_trigger_timing.sql
-- Fix XP double-credit on re-vote / vote-flip.
--
-- 0009 declared tag_votes_xp as BEFORE INSERT/UPDATE/DELETE. But setVote
-- (lib/community.js) writes votes with an upsert: INSERT ... ON CONFLICT
-- (user_tag_id, voter_id) DO UPDATE. On a conflict, Postgres still fires the
-- BEFORE INSERT trigger for the candidate row (with a fresh, soon-discarded
-- identity id) BEFORE it reroutes to the UPDATE path. That phantom fire writes
-- xp_events tagged with the discarded id and bumps profiles.xp — side effects
-- that no later operation can ever reverse (no real tag_votes row will match
-- that vote_id). Result: orphaned ledger rows + inflated XP on every re-vote.
--
-- AFTER triggers fix this: AFTER INSERT fires ONLY when a row was truly
-- inserted; when the upsert routes to an update, AFTER UPDATE fires instead.
-- The function body is unchanged and still satisfies its two original needs:
--   * AFTER DELETE: OLD is available and xp_events rows still exist (no FK
--     cascade was defined on vote_id), so the reversal loop works.
--   * AFTER INSERT: NEW.id is already populated by the identity sequence.
-- ============================================================================

drop trigger tag_votes_xp on public.tag_votes;
create trigger tag_votes_xp
  after insert or update or delete on public.tag_votes
  for each row execute function public.apply_tag_vote_xp();

-- Backfill profiles for any auth.users missing one (the XP trigger's
-- UPDATE profiles ... no-ops silently when the row is absent, drifting the
-- cached total away from the xp_events ledger).
insert into public.profiles (id)
select u.id from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null;
