---
title: Database copy (Supabase)
group: Guides
summary: An optional Postgres copy of the public jobs and receipts, for fast lists, counts and your own queries.
---
# Database copy (Supabase)

The API reads the contract directly, and it needs no database to do it. This page is about an **optional** copy: a small indexer reads the contract and writes the public jobs and receipts into a Postgres database on [Supabase](https://supabase.com). The contract stays the source of truth. The copy can be deleted and rebuilt at any time.

<div class="diagram" data-diagram="copy"></div>

## What it offers

<div class="cards two">
<div class="card">

<span class="badge warn">Not in the API yet</span>

### Fast lists with real filters

The contract has no list or count view, so `GET /v1/jobs` finds the newest job by bisecting and then reads up to 100 jobs per request. From the copy, a list is one indexed query: newest first, filtered by status, client or worker, with no scan window. Today you can run that query yourself; the API does not use it yet.

</div>
<div class="card">

<span class="badge ok">Ready</span>

### Counts and statistics

How many jobs are open, how many were verified, how many deliveries each worker made. None of that can be read from the contract without scanning it. `GET /v1/stats` answers it from the copy, for everyone or for one client or worker, and says when the copy was last refreshed.

</div>
<div class="card">

<span class="badge ok">Ready</span>

### Data you control

It is your database. Query it with SQL, join it with your own tables, point a dashboard at it, export it, back it up. Nothing in it is private: every field is already public on the network.

</div>
<div class="card">

<span class="badge ok">Ready</span>

### Safe by default

Row level security is on for every table. The public key can read jobs and receipts and nothing else. Only the indexer can write, with a secret key that lives in the repository's secrets and never reaches the API function.

</div>
</div>

## What exists today

| Part | State |
|---|---|
| Tables, indexes and security rules | Applied to a real Supabase project. Checked there: the public role can read jobs and receipts, cannot insert, and cannot see the private table. |
| Indexer (`npm run index`) | Written and tested against the simulated contract and a stand-in for the Supabase REST API that enforces the same table rules. |
| Scheduled run (`.github/workflows/index.yml`) | Runs once an hour, and by hand from the Actions tab. It does nothing until the two secrets exist. |
| First run on the real project | It recorded which contract and network the database mirrors and found **no jobs**, because the contract had none yet. Copying real jobs into the hosted database has **not** been seen. |
| `GET /v1/stats` and the MCP tool `get_stats` | Built. Tested against a stand-in for the Supabase REST API (row counts, filters, key header) and against the simulated contract. It turns on when the API has `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`; a request with the real public key to the hosted endpoint has **not** been tried. |
| Lists from the copy | **Not built.** `GET /v1/jobs` still reads the contract. |

## How it works

1. **Read.** The indexer reads the contract with a read-only client and **final** reads only, so the copy never holds a state the network could still change.
2. **Find what changed.** It copies new jobs (up to 40 per round, as many rounds as it needs, at most 50) and re-reads the jobs that are not `VERIFIED` yet, because those can still move. A `VERIFIED` job is final and is not read again.
3. **Write.** Jobs first, then their receipts, as upserts keyed by id, so running it twice changes nothing.
4. **Remember.** It stores the highest job number it reached, when it ran, any error, and **which contract and network** the database mirrors.

What it does when something goes wrong:

- **A row the database refuses** is skipped, reported in `last_error` and in the run log, and the run ends red once. The other rows still go in.
- **A wrong key, an unreachable database or a server error** stops the run at the first answer. It does not retry row by row.
- **A different contract** than the one the database recorded: it refuses to write. One database mirrors one contract.

## The tables

| Table | Holds | Who can read it |
|---|---|---|
| `jobs` | `id` (`job-N`), `job_number`, `title`, `description`, `criteria` (JSON), `client`, `worker` (null until accepted), `status`, `delivery_count`, `receipt_ids`, `terms_hash`, `agreement_hash`, `integrity` (JSON), `synced_at` | Anyone with the public key |
| `receipts` | `id` (`rcpt-N`), `job_id`, `delivery_index`, `worker`, `url`, `status`, `agreement_hash`, `evidence_hash`, `evidence_size`, `overall_status`, `evaluation_requested_by`, `results` (JSON), `synced_at` | Anyone with the public key |
| `indexer_state` | The position, the last run, the contract address and the network | Anyone with the public key |
| `indexer_state` (`last_error`) | The last error, which can name rows and database messages | Only the secret key |

The fields match the [REST shapes](rest-reference.html) one to one, in snake case. Addresses are stored in lower case. Every row has `synced_at`: when the indexer last wrote it.

## Who can do what

| Key | Can | Where it lives |
|---|---|---|
| **Public** (publishable) key | Read `jobs`, `receipts` and the public columns of `indexer_state`. Nothing else: no writes, no `last_error`. | Anywhere. It carries the same low privileges as the old `anon` key. |
| **Secret** key | Everything, and it bypasses row level security. | Only in the repository's Actions secrets. Never in the code, the chat, the API function or a browser. |

Supabase secret keys are not JWTs, so the indexer sends them in the `apikey` header only. Putting one in `Authorization: Bearer` makes the platform reject it with `Invalid JWT`.

## Set it up

1. **Create a Supabase project.** In its settings, turn on *Enable RLS on new tables automatically* (recommended; the migrations do not depend on it).
2. **Apply the migrations** in `supabase/migrations/`, in order, with `supabase db push` or by pasting each file into the SQL editor:
   - `…0001_lock_rls_auto_enable.sql`: that project option installs a helper function anyone could call through the API; this removes that permission.
   - `…0002_jobs_receipts.sql`: the three tables, their indexes, row level security and the read-only grants.
   - `…0003_indexer_contract.sql`: the columns that record the contract and the network.
   - `…0004_public_index_status.sql`: lets the public key read the position, the time of the last run, the contract and the network (and no more), which `/v1/stats` reports.
3. **Create a secret key:** *Project Settings, API Keys, Secret keys*. A key of its own for this use is better than sharing one, because it can be revoked alone.
4. **Add two secrets to the GitHub repository.** *Settings, Secrets and variables, Actions, Repository secrets* (not *Environment secrets*):
   - `SUPABASE_URL`: the project URL, `https://<ref>.supabase.co`
   - `SUPABASE_SECRET_KEY`: the secret key
5. **Run it once by hand.** *Actions, Index, Run workflow*. Then check the result in the SQL editor:

```sql
select last_job_number, last_run_at, last_error, contract_address, network
from public.indexer_state;
```

To run it from your own machine instead: `SUPABASE_URL=... SUPABASE_SECRET_KEY=... npm run index`.

6. **Turn on the statistics endpoint.** In the Vercel project's *Environment Variables*, add `SUPABASE_URL` (the same URL) and `SUPABASE_PUBLISHABLE_KEY` (*Project Settings, API Keys, Publishable key*), then redeploy. This one is the **public** key. The API refuses to start if it finds a secret key, a `service_role` key, or the variables `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`.

## Statistics through the API

`GET /v1/stats` counts in the copy and returns one object. The values below are illustrative.

```json
{
  "success": true,
  "data": {
    "source": "copy",
    "contract": "0x5729a3b514654Ec5966A1DCa8e5088ef7A70bBDA",
    "network": "studionet",
    "syncedAt": "2026-11-19T10:00:00.000Z",
    "copiedThrough": "job-5",
    "filter": { "client": null, "worker": null },
    "jobs": { "total": 5, "byStatus": { "OPEN": 1, "IN_PROGRESS": 1, "VERIFIED": 2, "NEEDS_REVISION": 1, "INCONCLUSIVE": 0 } },
    "receipts": { "total": 6, "byOutcome": { "VERIFIED": 2, "NEEDS_REVISION": 2, "INCONCLUSIVE": 0, "PENDING": 1 } },
    "notes": ["..."]
  }
}
```

| Parameter | Effect |
|---|---|
| `worker` | Counts only the jobs this address accepted, and the deliveries it made. |
| `client` | Counts only the jobs this address created. Deliveries are then `null`: they belong to the worker. |

`syncedAt` is when the indexer last ran: jobs created since are not counted yet. `byOutcome` counts deliveries by the verdict the validators gave; `PENDING` are still waiting, and a delivery replaced before it was judged is only in `total`. Answers are cached for 30 seconds. On a server with no copy configured the answer is `503 COPY_UNAVAILABLE`.

## Query it

From the SQL editor, or any client with the right access:

```sql
-- Jobs per status
select status, count(*) from public.jobs group by status order by count(*) desc;

-- The newest open jobs
select id, title, client from public.jobs where status = 'OPEN' order by job_number desc limit 20;

-- Deliveries and verdicts for one worker
select r.job_id, r.delivery_index, r.overall_status
from public.receipts r where r.worker = '0x…' order by r.job_id, r.delivery_index;
```

With the public key, through Supabase's REST interface (PostgREST):

```bash
curl "https://<ref>.supabase.co/rest/v1/jobs?status=eq.OPEN&order=job_number.desc&limit=20" \
  -H "apikey: <your publishable key>"
```

> The grants were checked with the public database role. This request, with a real publishable key against the hosted endpoint, has **not** been tried.

## Read it with care

- **It lags.** The scheduled run is hourly, and GitHub may start it a little late. Check `synced_at`. For a fresh answer, use the API itself.
- **It is a copy.** Do not use it as proof of anything. For a result you will rely on, read the contract through the API, and check the delivered page with [`checkEvidence`](verification-results.html).
- **Skipped rows are not retried.** A row the database refused is noted once in `last_error`. Fix the cause, set `last_job_number` back to `0` in `indexer_state` and run it again; the writes are upserts, so that is safe.
- **GitHub can pause the schedule.** In a public repository, scheduled workflows are switched off after 60 days without activity. The Actions tab shows a banner to turn them back on.

## What this is not

- **Not an account system.** The API still has no keys, no login and no sessions, and the copy holds no personal data beyond what is already public on the network.
- **Not used for rate limiting or webhooks.** Those are separate, and the [limits](limits.html) page covers them.
- **Not signing anything.** The indexer has no wallet and never sends a transaction.

## Next

The next step is for `GET /v1/jobs` to read the copy as well, with the contract as a fallback and the freshness of each answer shown in the response. That is not built. See the [changelog](changelog.html) for what is done and what is not.
