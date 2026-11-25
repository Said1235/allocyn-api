---
title: CLI and Python
group: API and SDK
summary: Read Allocyn from a terminal or from Python, without writing HTTP calls.
---
# CLI and Python

Two small clients wrap the REST API. Both are **read-only**, need no wallet and no key, and have no dependencies. Neither is published to a package registry yet: use them from the repository, or publish them yourself (see [Deploying](deploy.html)).

## Command line

```bash
npm run build -w @allocyn/cli
export ALLOCYN_API_URL=https://your-project.vercel.app

node packages/cli/dist/cli.js job job-1
node packages/cli/dist/cli.js jobs --status VERIFIED --limit 5
node packages/cli/dist/cli.js proof job-1
node packages/cli/dist/cli.js badge job-1 --url
node packages/cli/dist/cli.js evidence rcpt-1
node packages/cli/dist/cli.js proof job-1 > proof.json
node packages/cli/dist/cli.js verify proof.json --chain   # no --api needed
node packages/cli/dist/cli.js prepare job-2 --action accept --actor 0xYourAddress

# These read the optional database copy (see Database copy):
node packages/cli/dist/cli.js jobs --q logo --limit 5
node packages/cli/dist/cli.js jobs --updated-since 2026-11-20T00:00:00Z
node packages/cli/dist/cli.js stats --worker 0xYourAddress
node packages/cli/dist/cli.js address 0xYourAddress
node packages/cli/dist/cli.js events --after 0 --limit 20 --wait 15
```

`verify` checks a saved [proof pack](verification-results.html) on your machine, without the API; `--chain` re-reads the contract and needs the `@allocyn/sdk` package installed next to the CLI, `-` reads standard input. `evidence` downloads the delivered page on your machine and compares it with the receipt (see [Verification results](verification-results.html)). `prepare` only reads: it shows what a person would sign and sends nothing.

`stats`, `address` and `events` need an API that has a [database copy](database.html); without one they exit `1` with `COPY_UNAVAILABLE`. `jobs` with `--q` or `--updated-since` reads the copy too. `events` prints a `cursor`: pass it back as `--after` to continue, and use `--wait` to hold the request until something new arrives. None of this is real time: events show what the indexer has seen.

Answers go to standard output as JSON, errors to standard error, so it works in scripts. Exit codes: `0` ok, `1` the API answered with an error, `2` wrong usage, `3` the API could not be reached. The commands are `health`, `meta`, `limits`, `jobs`, `job`, `receipts`, `receipt`, `proof`, `wait`, `badge` and `tx`; `--help` lists the options. There is no default API address, and `http://` is only accepted for `localhost`.

## Python

`clients/python/allocyn_api.py` is one file that uses only the standard library (Python 3.8 or newer). It is generated from the API's route table, so it has a method for every route and cannot fall behind it.

```python
from allocyn_api import AllocynApi, AllocynApiError

api = AllocynApi("https://your-project.vercel.app", consistency="final")
job = api.get_job("job-1")
page = api.list_jobs(status="VERIFIED", limit=10)
proof = api.get_job_proof("job-1")

try:
    api.get_job("job-999")
except AllocynApiError as e:
    print(e.code, e.retryable)   # JOB_NOT_FOUND False
```

Each method returns the `data` of the answer or raises `AllocynApiError` with the API's `code`, `retryable` and `field`.

## Listing and following jobs

Two reads exist for tools that watch jobs.

**`GET /v1/jobs`** lists jobs from newest to oldest and can filter by `status`, `client` or `worker`. The contract has no list view, so the API reads job ids one by one (at most 100 per request) and filters what it read. A page can therefore hold fewer jobs than `limit` while `nextCursor` is not `null`; pass it as `before` to continue exactly where the scan stopped. A filter that matches few jobs takes several pages.

**`GET /v1/jobs/{jobId}/wait`** is a long poll, a stateless alternative to webhooks. The first call returns the job and a `version`. Call again with `since=<version>` and it answers when the job changes (a worker accepted, a delivery arrived, validators judged) or when the wait ends with `changed: false`. The wait is at most 25 seconds, and always shorter than `REQUEST_TIMEOUT_MS`; on Vercel, with the recommended 8 seconds, it is about 5. Nothing is stored: if you miss an answer, ask again.

```python
version = None
while True:
    r = api.wait_for_job("job-1", since=version, timeout=20)
    version = r["version"]
    if r["changed"]:
        print("now", r["job"]["status"])
```

Webhooks are not offered: pushing events needs a database of subscriptions and a scheduler, and this API stores nothing.

## Status

Both clients are tested against the real server code running on the simulated contract (the CLI as a built bundle, the Python client as a real `python3` process). They have not been run against the live Studionet from the build environment.
