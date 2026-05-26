-- ============================================================================
-- 0007_user_tags_insert.sql
-- Allow authenticated users to INSERT into public.tags.
--
-- Why: Layer 2 community tagging (lib/community.js -> getOrCreateTagId, called
-- from the /library UI) needs to ensure a row exists in `tags` before linking
-- it from user_tags. Migration 0001 enabled RLS on `tags` with only a SELECT
-- policy, so the upsert fired from a user-scoped client was rejected with
-- "new row violates row-level security policy for table tags".
--
-- Safety: `tags` is a pure dictionary (id, name, created_at). The UNIQUE
-- constraint on `name` dedupes, and the application normalizes (lowercases /
-- trims / strips diacritics / fuzzy-merges) BEFORE insert. The only attack
-- surface is "spamming new tag rows", which costs the attacker a vote slot
-- they can't reuse (user_tags has UNIQUE (track_id, tag_id, submitted_by)).
-- ============================================================================

create policy tags_insert_authenticated on public.tags
  for insert to authenticated
  with check (true);
