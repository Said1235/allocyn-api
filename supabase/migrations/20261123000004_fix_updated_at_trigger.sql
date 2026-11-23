-- Fix for 20261123000003: stored generated columns (search, job_number) are computed AFTER before-row triggers,
-- so inside the trigger NEW holds nothing for them and every update looked like a change. Leave them out of the comparison.
create or replace function public.jobs_touch_updated_at() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'synced_at' - 'updated_at' - 'search' - 'job_number') is distinct from (to_jsonb(old) - 'synced_at' - 'updated_at' - 'search' - 'job_number') then
    new.updated_at := now();
  else
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;
