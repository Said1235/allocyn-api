-- One row per indexer run, so a stopped or failing indexer can be seen. The newest 200 are kept.
create table public.indexer_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  ok boolean not null,
  new_jobs integer not null default 0 check (new_jobs >= 0),
  refreshed_jobs integer not null default 0 check (refreshed_jobs >= 0),
  receipts integer not null default 0 check (receipts >= 0),
  failed_rows integer not null default 0 check (failed_rows >= 0),
  rounds integer not null default 0 check (rounds >= 0),
  last_job_number integer check (last_job_number >= 0),
  error text check (error is null or length(error) <= 500)
);
create index indexer_runs_finished_idx on public.indexer_runs (finished_at desc);

alter table public.indexer_runs enable row level security;
revoke all on public.indexer_runs from anon, authenticated;
-- The public key sees the numbers. `error` can name rows and database messages, so it stays private (like indexer_state.last_error).
grant select (id, started_at, finished_at, ok, new_jobs, refreshed_jobs, receipts, failed_rows, rounds, last_job_number) on public.indexer_runs to anon, authenticated;
create policy indexer_runs_public_read on public.indexer_runs for select to anon, authenticated using (true);
