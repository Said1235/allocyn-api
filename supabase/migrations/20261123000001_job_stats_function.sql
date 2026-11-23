-- One call for the counts that /v1/stats needs, instead of about a dozen.
-- SECURITY INVOKER: it runs with the caller's rights, so row level security and the read-only grants still apply.
-- The public key can run it and nothing more: the function only reads.
create or replace function public.job_stats(p_client text default null, p_worker text default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with j as (
    select status from public.jobs
    where (p_client is null or client = lower(p_client)) and (p_worker is null or worker = lower(p_worker))
  ), r as (
    select status, overall_status from public.receipts
    where p_client is null and (p_worker is null or worker = lower(p_worker))
  )
  select jsonb_build_object(
    'jobs', jsonb_build_object(
      'total', (select count(*) from j),
      'byStatus', jsonb_build_object(
        'OPEN', (select count(*) from j where status = 'OPEN'),
        'IN_PROGRESS', (select count(*) from j where status = 'IN_PROGRESS'),
        'VERIFIED', (select count(*) from j where status = 'VERIFIED'),
        'NEEDS_REVISION', (select count(*) from j where status = 'NEEDS_REVISION'),
        'INCONCLUSIVE', (select count(*) from j where status = 'INCONCLUSIVE'))),
    'receipts', case when p_client is not null then null::jsonb else jsonb_build_object(
      'total', (select count(*) from r),
      'byOutcome', jsonb_build_object(
        'VERIFIED', (select count(*) from r where overall_status = 'VERIFIED'),
        'NEEDS_REVISION', (select count(*) from r where overall_status = 'NEEDS_REVISION'),
        'INCONCLUSIVE', (select count(*) from r where overall_status = 'INCONCLUSIVE'),
        'PENDING', (select count(*) from r where status = 'PENDING'))) end
  );
$$;

revoke all on function public.job_stats(text, text) from public;
grant execute on function public.job_stats(text, text) to anon, authenticated, service_role;
