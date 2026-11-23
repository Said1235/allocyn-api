-- Search and incremental sync for GET /v1/jobs.

-- Full-text search over title and description. 'simple' keeps it language-neutral (no stemming), so any language works.
alter table public.jobs add column search tsvector
  generated always as (to_tsvector('simple'::regconfig, coalesce(title, '') || ' ' || coalesce(description, ''))) stored;
create index jobs_search_idx on public.jobs using gin (search);

-- updated_at moves only when the job's content changes. synced_at moves on every refresh, so it cannot tell "changed" from "re-read".
alter table public.jobs add column updated_at timestamptz not null default now();
create index jobs_updated_at_idx on public.jobs (updated_at);

create function public.jobs_touch_updated_at() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'synced_at' - 'updated_at') is distinct from (to_jsonb(old) - 'synced_at' - 'updated_at') then
    new.updated_at := now();
  else
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;
revoke all on function public.jobs_touch_updated_at() from public, anon, authenticated;

create trigger jobs_touch_updated_at before update on public.jobs
  for each row execute function public.jobs_touch_updated_at();
