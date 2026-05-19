-- ============================================================================
-- 0003_playlist_jobs.sql
-- ============================================================================

create type public.playlist_job_status as enum (
  'queued', 'syncing', 'enriching', 'completed', 'failed'
);

create table public.playlist_jobs (
  id             uuid                       primary key default gen_random_uuid(),
  user_id        uuid                       not null references auth.users(id) on delete cascade,
  status         public.playlist_job_status not null default 'queued',
  tags           text[]                     not null default '{}',
  library_total  integer                    not null default 0,
  library_done   integer                    not null default 0,
  enrich_total   integer                    not null default 0,
  enrich_done    integer                    not null default 0,
  error_message  text,
  started_at     timestamptz                not null default now(),
  updated_at     timestamptz                not null default now(),
  completed_at   timestamptz
);

create index playlist_jobs_user_idx on public.playlist_jobs (user_id, started_at desc);

alter table public.playlist_jobs enable row level security;
alter table public.playlist_jobs force  row level security;

create policy playlist_jobs_select_own on public.playlist_jobs
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Match the lockdown in 0002 — anon (logged-out) PostgREST clients see nothing.
revoke select on public.playlist_jobs from anon;

create or replace function public.increment_job_counter(
  p_job uuid,
  p_column text,
  p_by integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_column not in ('library_done', 'library_total', 'enrich_done', 'enrich_total') then
    raise exception 'increment_job_counter: column % is not whitelisted', p_column;
  end if;
  execute format(
    'update public.playlist_jobs set %1$I = %1$I + $1, updated_at = now() where id = $2',
    p_column
  ) using p_by, p_job;
end;
$$;

revoke execute on function public.increment_job_counter(uuid, text, integer) from public;
revoke execute on function public.increment_job_counter(uuid, text, integer) from anon;
revoke execute on function public.increment_job_counter(uuid, text, integer) from authenticated;
