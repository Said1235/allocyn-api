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

<span class="badge ok">Ready</span>

### Fast lists with real filters

The contract has no list or count view, so `GET /v1/jobs` finds the newest job by bisecting and then reads up to 100 jobs per request. From the copy, a list is one indexed query: newest first, filtered by status, client or worker, with no scan window. Ask for it with `GET /v1/jobs?source=copy`, or `source=auto` to fall back to the contract when the copy is down. The default stays `contract`, because the copy is final data as of its last refresh.

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
| Indexer (`npm run index`) | Written and tested against the simulated contract and a stand-in for the Supabase REST API that enforces the same table rules. It also records each run in `indexer_runs`: one real run recorded its row on the hosted database. |
| Scheduled run (`.github/workflows/index.yml`) | Set to run about every ten minutes, and by hand from the Actions tab. It does nothing until the two secrets exist. **A scheduled run starting on its own has not been seen:** the runs recorded so far were started by hand. |
| First run on the real project | It recorded which contract and network the database mirrors and found **no jobs**, because the contract had none yet. Copying real jobs into the hosted database has **not** been seen. |
| `GET /v1/stats` and the MCP tool `get_stats` | Live. Tested against a stand-in for the Supabase REST API and the simulated contract. On the deployed API it answered from the real project with the public key: the right contract and refresh time, all zeros because the copy holds no jobs yet. Counting real jobs has **not** been seen. It turns on when the API has `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. Since 1.6.0 it needs two requests, not about thirteen: the hosted database's logs show the deployed API calling the `job_stats` function. |
| Search and `updatedSince` | `GET /v1/jobs?q=…` and `?updatedSince=…`. The deployed API's search request is accepted by the hosted database. The search column, the trigger and the public role's rights were checked in SQL with temporary rows; real jobs behind the API have **not** been seen. |
| Events and address records | `GET /v1/events` and `GET /v1/addresses/{address}`. The triggers were checked on the hosted database with temporary rows. Real jobs producing real events have **not** been seen. |
| Copy health | `GET /v1/health?deep=true` reports `checks.copy` and a `copy` object. Live on the deployed API. When first checked it reported `stale`: no indexer run for about five hours. |
| Lists from the copy | `GET /v1/jobs?source=copy` and `source=auto`. Tested against a stand-in for the Supabase REST API. On the deployed API the real list request is accepted by the hosted database with the public key, and returns an empty list because the copy holds no jobs yet. Filters and paging on real rows have **not** been seen. The default is still the contract. |

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
| `jobs` | `id` (`job-N`), `job_number`, `title`, `description`, `criteria` (JSON), `client`, `worker` (null until accepted), `status`, `delivery_count`, `receipt_ids`, `terms_hash`, `agreement_hash`, `integrity` (JSON), `synced_at`, `updated_at` (moves only when the content changes), `search` (full-text index of title and description) | Anyone with the public key |
| `receipts` | `id` (`rcpt-N`), `job_id`, `delivery_index`, `worker`, `url`, `status`, `agreement_hash`, `evidence_hash`, `evidence_size`, `overall_status`, `evaluation_requested_by`, `results` (JSON), `synced_at` | Anyone with the public key |
| `indexer_state` | The position, the last run, the contract address and the network | Anyone with the public key |
| `indexer_state` (`last_error`) | The last error, which can name rows and database messages | Only the secret key |
| `job_events` | `id`, `created_at` (when the indexer saw the change), `job_id`, `type` (`job_created`, `job_accepted`, `delivery_submitted`, `delivery_evaluated`, `status_changed`), `from_status`, `to_status`, `client`, `worker`, `data` (JSON). Written by triggers, not by the indexer's code. | Anyone with the public key |
| `indexer_runs` | One row per indexer run: `started_at`, `finished_at`, `ok`, `new_jobs`, `refreshed_jobs`, `receipts`, `failed_rows`, `rounds`, `last_job_number`. The newest 200 are kept. | Anyone with the public key |
| `indexer_runs` (`error`) | The error text of a failed run | Only the secret key |

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
   - `20261123…0001_job_stats_function.sql`: the function that returns every count in one call.
   - `20261123…0002_indexer_runs.sql`: the table that records each run.
   - `20261123…0005_job_events.sql`: the event log and the triggers that write it.
   - `20261123…0003_jobs_search_updated.sql` and `…0004_fix_updated_at_trigger.sql`: the search column and `updated_at`. Apply both; the fourth corrects the trigger of the third.
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

`GET /v1/stats` counts in the copy and returns one object. A database function (`job_stats`) returns every count in one call; if the function is not there yet, the API counts one by one and gives the same numbers. The values below are illustrative.

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

## Lists through the API

```bash
curl -s 'https://<your-api>/v1/jobs?source=copy&status=OPEN&limit=20'
```

| `source` | Reads | Good for |
|---|---|---|
| `contract` (default) | The contract, live. At most 100 ids per request, so a page can be short. | The current state, a job just created. |
| `copy` | The database copy: one query, full pages. `503 COPY_UNAVAILABLE` if the server has none, `502` if it cannot be read. | Browsing and filtering many jobs. |
| `auto` | The copy when it works, otherwise the contract (the answer says which). | Clients that want speed but must always get an answer. |

The answer carries `source`, `syncedAt` (when the indexer last ran) and `notes`. `nextCursor` works the same: pass it as `before`. A list from the copy does not contain jobs created or changed since `syncedAt`.

Two filters exist only on the copy, so using either one makes `source` default to `copy`:

```bash
# Search the title and description. Every word must appear; any language.
curl -s 'https://<your-api>/v1/jobs?q=logo+animation'

# Only jobs whose content changed since a time (a date and time with a zone).
curl -s 'https://<your-api>/v1/jobs?updatedSince=2026-11-20T00:00:00Z'
```

`updatedSince` moves only when a job's content changes. A job that the indexer merely read again does not count, so it is the right filter for a dashboard that wants to sync what changed. With `source=contract` both are refused with `400`, and if the copy is down there is no silent fallback to the contract, because the contract cannot answer them: you get `502`.

## Events

`GET /v1/events` is a feed of what changed, oldest first. The database writes the events itself, with triggers, whenever the indexer changes a job or a receipt.

```bash
# The newest events, and a cursor
curl -s 'https://<your-api>/v1/events?limit=20'

# What came after that cursor, waiting up to 20 s for something new
curl -s 'https://<your-api>/v1/events?after=57&wait=20'
```

| Event | When |
|---|---|
| `job_created` | The copy first saw the job. |
| `job_accepted` | A worker was set. |
| `delivery_submitted` | The delivery count went up. |
| `delivery_evaluated` | A delivery got its verdict (`data.outcome`). |
| `status_changed` | The job's status moved (`fromStatus` and `toStatus`). |

Filters: `job`, `type`, `worker`, `client`. The answer has `cursor`: pass it as `after`. Events are kept, so a client that was away can catch up. If you only need one job, [`wait`](rest-reference.html) on it reads the contract directly and is live.

Three limits, on purpose. **It is not real time:** `detectedAt` is when the indexer saw the change, which is minutes after it happened at best. **Nothing is pushed:** you ask again. There are no webhooks, because they would need stored subscriptions, signatures and protection against requests to internal networks. And a job that was already finished when the copy first saw it has only a `job_created` event.

## What the copy holds about an address

```bash
curl -s 'https://<your-api>/v1/addresses/0x…'
```

For one address: its jobs as **client** and as **worker** by status, its deliveries by verdict, and its five newest jobs on each side. These are counts. There is no score, no ranking and no promise, and the answer says so. A few jobs say little; read the jobs before relying on a record. An address the copy has never seen gets all zeros, which can mean unused or just newer than `syncedAt`.

## Is the copy healthy?

`GET /v1/health?deep=true` adds, when a copy is configured, `checks.copy` and a `copy` object:

| `checks.copy` | Meaning |
|---|---|
| `ok` | The indexer ran in the last hour and its last run succeeded. |
| `stale` | No run for more than an hour (or never). Check the Actions tab: GitHub may have paused the schedule. |
| `failing` | The last run had rows the database refused. |
| `unavailable` | The copy could not be read. |

`copy.lagSeconds` is the age of the data and `copy.lastRun` shows what the last run did. None of this ever makes the health check fail: the API and the network are what it vouches for, and the contract stays the source of truth. A plain `GET /v1/health` reads nothing from the database.

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

> The grants were checked with the public database role. The API makes this kind of request with the real public key for `/v1/stats` (row counts and the index status), and it works. A similar `jobs` list request, the one `source=copy` makes, was accepted too and returned an empty list, since the copy holds no jobs yet.

## Read it with care

- **It lags.** The scheduled run is about every ten minutes, and GitHub may start it late or skip one. Check `synced_at`. For a fresh answer, use the API itself.
- **It is a copy.** Do not use it as proof of anything. For a result you will rely on, read the contract through the API, and check the delivered page with [`checkEvidence`](verification-results.html).
- **Skipped rows are not retried.** A row the database refused is noted once in `last_error`. Fix the cause, set `last_job_number` back to `0` in `indexer_state` and run it again; the writes are upserts, so that is safe.
- **GitHub can pause the schedule.** In a public repository, scheduled workflows are switched off after 60 days without activity. The Actions tab shows a banner to turn them back on.

## What this is not

- **Not an account system.** The API still has no keys, no login and no sessions, and the copy holds no personal data beyond what is already public on the network.
- **Not used for rate limiting or webhooks.** Those are separate, and the [limits](limits.html) page covers them.
- **Not signing anything.** The indexer has no wallet and never sends a transaction.

## Next

What is left is checking the list request on the hosted database once it holds real jobs, and deciding whether `auto` should become the default after that. See the [changelog](changelog.html) for what is done and what is not.
