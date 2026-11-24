-- A change log of jobs, written by the database itself whenever the indexer changes a row.
-- `created_at` is when the indexer SAW the change, not when it happened on the network.
create table public.job_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  job_id text not null references public.jobs (id) on delete cascade,
  type text not null check (type in ('job_created', 'job_accepted', 'delivery_submitted', 'delivery_evaluated', 'status_changed')),
  from_status text check (from_status is null or from_status in ('OPEN', 'IN_PROGRESS', 'VERIFIED', 'NEEDS_REVISION', 'INCONCLUSIVE')),
  to_status text check (to_status is null or to_status in ('OPEN', 'IN_PROGRESS', 'VERIFIED', 'NEEDS_REVISION', 'INCONCLUSIVE')),
  client text not null check (client ~ '^0x[0-9a-f]{40}$'),
  worker text check (worker is null or worker ~ '^0x[0-9a-f]{40}$'),
  data jsonb not null default '{}'::jsonb
);
create index job_events_job_idx on public.job_events (job_id, id);
create index job_events_worker_idx on public.job_events (worker, id) where worker is not null;
create index job_events_client_idx on public.job_events (client, id);

alter table public.job_events enable row level security;
revoke all on public.job_events from anon, authenticated;
grant select on public.job_events to anon, authenticated;
create policy job_events_public_read on public.job_events for select to anon, authenticated using (true);

-- Jobs: created, accepted, a delivery came in, the status moved.
create function public.jobs_log_events() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.job_events (job_id, type, to_status, client, worker, data)
    values (new.id, 'job_created', new.status, new.client, new.worker, jsonb_build_object('deliveryCount', new.delivery_count));
    return null;
  end if;
  if new.worker is not null and new.worker is distinct from old.worker then
    insert into public.job_events (job_id, type, client, worker) values (new.id, 'job_accepted', new.client, new.worker);
  end if;
  if new.delivery_count > old.delivery_count then
    insert into public.job_events (job_id, type, client, worker, data)
    values (new.id, 'delivery_submitted', new.client, new.worker, jsonb_build_object('deliveryCount', new.delivery_count));
  end if;
  if new.status is distinct from old.status then
    insert into public.job_events (job_id, type, from_status, to_status, client, worker)
    values (new.id, 'status_changed', old.status, new.status, new.client, new.worker);
  end if;
  return null;
end;
$$;
revoke all on function public.jobs_log_events() from public, anon, authenticated;
create trigger jobs_log_events after insert or update on public.jobs
  for each row execute function public.jobs_log_events();

-- Receipts: a delivery got its verdict.
create function public.receipts_log_events() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  j record;
begin
  if new.overall_status is not null and (tg_op = 'INSERT' or old.overall_status is distinct from new.overall_status) then
    select client, worker into j from public.jobs where id = new.job_id;
    if found then
      insert into public.job_events (job_id, type, client, worker, data)
      values (new.job_id, 'delivery_evaluated', j.client, j.worker,
              jsonb_build_object('receiptId', new.id, 'deliveryIndex', new.delivery_index, 'outcome', new.overall_status));
    end if;
  end if;
  return null;
end;
$$;
revoke all on function public.receipts_log_events() from public, anon, authenticated;
create trigger receipts_log_events after insert or update on public.receipts
  for each row execute function public.receipts_log_events();
