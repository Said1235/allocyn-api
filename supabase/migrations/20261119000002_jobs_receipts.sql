-- Allocyn index: a copy of public contract data, for fast listing and statistics.
-- The contract stays the source of truth. Rows are only ever written by the indexer with the secret key.
-- Everyone else (the public key) can read jobs and receipts and nothing else.

create table public.jobs (
  id text primary key check (id ~ '^job-[1-9][0-9]{0,8}$'),
  job_number integer generated always as (substring(id from 5)::integer) stored,
  title text not null,
  description text not null,
  criteria jsonb not null default '[]'::jsonb,
  client text not null check (client ~ '^0x[0-9a-f]{40}$'),
  worker text check (worker is null or worker ~ '^0x[0-9a-f]{40}$'),
  status text not null check (status in ('OPEN', 'IN_PROGRESS', 'VERIFIED', 'NEEDS_REVISION', 'INCONCLUSIVE')),
  delivery_count integer not null default 0 check (delivery_count >= 0),
  receipt_ids text[] not null default '{}',
  terms_hash text,
  agreement_hash text,
  integrity jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);

create table public.receipts (
  id text primary key,
  job_id text not null references public.jobs (id) on delete cascade,
  delivery_index integer not null check (delivery_index >= 1),
  worker text not null,
  url text not null,
  status text not null,
  agreement_hash text,
  evidence_hash text,
  evidence_size integer,
  overall_status text,
  evaluation_requested_by text,
  results jsonb not null default '[]'::jsonb,
  synced_at timestamptz not null default now(),
  unique (job_id, delivery_index)
);

-- Where the indexer stopped. A single row, private: no policy, so only the secret key can touch it.
create table public.indexer_state (
  id smallint primary key default 1 check (id = 1),
  last_job_number integer not null default 0 check (last_job_number >= 0),
  last_run_at timestamptz,
  last_error text
);
insert into public.indexer_state (id) values (1);

create index jobs_status_number_idx on public.jobs (status, job_number desc);
create index jobs_number_idx on public.jobs (job_number desc);
create index jobs_client_idx on public.jobs (client);
create index jobs_worker_idx on public.jobs (worker) where worker is not null;

alter table public.jobs enable row level security;
alter table public.receipts enable row level security;
alter table public.indexer_state enable row level security;

revoke all on public.jobs, public.receipts, public.indexer_state from anon, authenticated;
grant select on public.jobs, public.receipts to anon, authenticated;

create policy "Anyone can read jobs" on public.jobs for select to anon, authenticated using (true);
create policy "Anyone can read receipts" on public.receipts for select to anon, authenticated using (true);
