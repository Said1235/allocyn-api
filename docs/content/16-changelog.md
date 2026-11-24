---
title: Changelog
group: Guides
summary: What changed in each version of the API, SDK and docs.
---
# Changelog

Versions: **API v1** (URL prefix `/v1`, release 1.7.0), **SDK 0.2.0**, **docs v1**. Breaking changes to the API will get a new prefix (`/v2`) and a new docs version; `/v1` will not change shape silently.

## 1.7.0 (API) · 0.3.0 (CLI)

The routes and shapes of 1.0.0 to 1.6.0 did not change. Everything below is added.

**Added**
- **`GET /v1/addresses/{address}`** and the MCP tool **`get_address_record`**: for one wallet address, how many jobs it created (as client) and accepted (as worker) in each status, how many deliveries it made and the verdicts they got, and its five newest jobs on each side. Counts only: there is no score, no ranking and no guarantee, and the answer says so. It is as old as `syncedAt`. Answers are cached for 30 seconds. `503 COPY_UNAVAILABLE` on a server with no copy.
- **`GET /v1/events`** and the MCP tool **`list_events`**: a feed of what changed (a job was created or accepted, a delivery came in or got its verdict, a status moved), oldest first, with a cursor (`after`) and an optional wait (`wait`, up to 25 s) that holds the request until something new arrives. Filters: `job`, `type`, `worker`, `client`. Events are stored, so a client that was away can catch up. The database writes them itself when the indexer changes a row.
- **CLI 0.3.0** has the commands for the new reads: `allocyn events`, `allocyn address`, `allocyn stats`, and `--q`, `--updated-since` and `--source` on `allocyn jobs`. The Python client already had them, because it is generated from the route table.
- **A reference agent** in `examples/agent/`: a dependency-free client that speaks MCP, finds open jobs, reads them, asks what accepting would involve and follows the feed. It has no language model inside and only calls read-only tools. It never signs. See [Agents and MCP](agents-mcp.html).

**Changed**
- **The indexer runs about every ten minutes** (it was hourly), so the copy and the feed are fresher. GitHub may start a scheduled run late or skip one. The copy now counts as `stale` in the deep health check after one hour without a run (it was three).

**What this is not.** Not real time: an event shows up when the indexer sees the change, so `detectedAt` can be minutes after it happened. Not push: there is no SSE and there are no webhooks, because the function behind the API lasts a few seconds and webhooks would need stored subscriptions, signatures and protection against requests to internal networks. Not a reputation system: the address record is counts, and a few jobs say little.

**Database changes** (apply `20261123000005_job_events.sql`): the `job_events` table and the triggers that fill it. The public key can read it and nothing more.

**Not verified yet**
- The triggers were checked on the hosted database with temporary rows (deleted afterwards): one job going from created to accepted, delivered, evaluated and verified produced exactly the six expected events, and updates that only touch `synced_at` produced none. On the deployed API, `GET /v1/events` and `GET /v1/addresses/{address}` answer `200` from the hosted database, with an empty feed and all zeros, because the copy holds no jobs. A real job changing on the network and its events appearing through a real indexer run has not been seen, because the contract has no jobs.
- The reference agent was tested against the simulated contract and a stand-in for the database. Run against the deployed API it works with whatever data that API has, which is none yet.
- **The schedule has not been seen firing.** The deployed deep health check shows one real indexer run recorded in `indexer_runs` (`ok`, 0 jobs, 0 receipts), so recording works against the real database. That run was started by hand. Since then no run appeared on its own, including in the 13 minutes after the schedule was changed to every ten minutes, and the copy reports `stale`. Whether GitHub is not starting the scheduled workflow, or starts it late, was not found out from here. Run it by hand from the Actions tab, and check that tab for a paused schedule.

## 1.6.0 (API)

The routes and shapes of 1.0.0 to 1.5.0 did not change. Everything below is added or faster, and a request without the new parameters answers as before.

**Added**
- **Search and "changed since" on `GET /v1/jobs`.** `q` searches the title and description (every word must appear, any language). `updatedSince` returns only the jobs whose content changed at or after a time, so a dashboard can sync without reading everything. Both need the [database copy](database.html), so `source` defaults to `copy` when you use them; with `source=contract` they are refused (`400`), and when the copy is down there is no silent fallback (`502`). Also in the MCP tool `list_jobs`.
- **The copy's health in `GET /v1/health?deep=true`.** With a copy configured, a deep check adds `checks.copy` (`ok`, `stale`, `failing` or `unavailable`) and a `copy` object: when the indexer last ran, how many seconds ago, how far it got and how the last run went. More than three hours without a run counts as stale. A stale or unreachable copy never turns the check into a `503`: the contract is the source of truth. A plain health check still reads nothing.
- **A record of every indexer run** (`indexer_runs`: when, how many jobs and receipts, how many rows failed). The newest 200 are kept. The public key sees the numbers; the error text stays private.

**Faster**
- **`GET /v1/stats` makes two requests instead of about thirteen.** A read-only database function (`job_stats`) returns every count at once. If the database does not have the function yet (its migration is not applied), the API falls back to counting one by one and gives the same numbers.

**Database changes** (apply the new migrations, in order): `job_stats` function; `indexer_runs` table; full-text `search` column and an `updated_at` column on `jobs` that moves only when a job's content changes (not when it is merely re-read). A first version of that trigger treated every update as a change; the fourth migration fixes it. The error was found by testing on the hosted database, not by the stand-in.

**Not verified yet**
- The indexer writing its run records: seen once on the hosted database (a run started by hand), after being tested on the stand-in. See 1.7.0 for the schedule.
- On the deployed API, the hosted database's logs show `POST /rest/v1/rpc/job_stats` and the search request (`search=plfts(simple).…`) both answered `200`, so the function and the search filter are accepted. The lists came back empty and the counts zero, because the copy holds no jobs. Search, `updatedSince` and the trigger were checked on real rows only with two temporary test rows in SQL (deleted afterwards), not through the API.
- When the deployed deep health check was first run, it answered `checks.copy: "stale"`: the last indexer run was about five hours old, so the hourly schedule had not fired since then. That is the check doing its job. Why the schedule did not run was not investigated from here.

## 1.5.0 (API)

The routes and shapes of 1.0.0 to 1.4.0 did not change. Everything below is added, and the default behaviour of `GET /v1/jobs` is the same as before.

**Added**
- **`source` on `GET /v1/jobs`** (and the MCP tool `list_jobs`): `contract` (default, live), `copy` or `auto`. With `copy`, the list is one indexed query on the [database copy](database.html): newest first, full pages, filters by `status`, `client` and `worker`, no scan window. With `auto`, the copy is used when it is configured and reachable, and the contract answers otherwise.
- **Freshness in the answer.** The list now also returns `source`, `syncedAt` (when the indexer last ran; null from the contract) and `notes`. From the copy, `scanned` is `0`.

**Why the default did not change.** The copy is final data only and as old as the last indexer run, so a job created a few minutes ago is not in it. A list that silently hid it would be a different answer from the one `/v1/jobs` has always given, so you choose the copy with `source`.

**Not verified yet**
- The copy list was tested against a stand-in for the Supabase REST API and the simulated contract. On the deployed API, `GET /v1/jobs?source=copy` ran the real list request against the hosted database with the public key and was accepted (`200`, with the real `syncedAt`), but it returned an empty list, because the copy holds no jobs yet. Filters and the cursor have not been seen on real rows.

## 1.4.0 (API) · 0.2.0 (SDK) · 0.2.0 (CLI)

The routes and shapes of 1.0.0 to 1.3.0 did not change. Everything below is added or fixed.

**Added**
- **`GET /v1/stats`** and the MCP tool **`get_stats`**: how many jobs are in each status and how many deliveries got each verdict, optionally for one `client` or one `worker`. The contract has no count view, so the numbers come from a database copy (see below). The answer says when the copy was last refreshed (`syncedAt`), which contract and network it mirrors, and how far it got (`copiedThrough`). On a server with no copy it answers `503 COPY_UNAVAILABLE`. Answers are cached for 30 seconds. See [Database copy](database.html).
- **An optional database copy on Supabase**, filled by an indexer (`npm run index`, and a scheduled workflow about once an hour). It copies jobs and receipts using final reads only, re-reads the jobs that can still change, skips and reports any row the database refuses, and stops if the database belongs to another contract. Row level security is on everywhere: the public key can only read.
- **Two optional settings for the API**: `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. The API reads the copy with the public key only, and refuses to start if it finds a secret key (`SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, an `sb_secret_` key or a `service_role` key). The secret key belongs to the indexer and lives only in the repository's secrets.
- **MetaMask** is the wallet used in the signing examples and is supported through the SDK's wallet connection. It moved out of the landing's technology cards. See [Wallets and signing](auth-wallets.html).

**Fixed**
- **Every `/v1/*` request failed on Vercel** with `Unknown query parameter "path"`. Vercel adds the matched part of the URL to the query string, and the API rejects parameters it does not know. The function now drops that platform parameter (and `jobId` on `/verify`, and the `_vercel_share` link parameter) before routing. The local tests did not go through Vercel's rewrites, so they could not catch it; the first request on the deployed API did.
- **The docs header on phones.** The theme button was pushed off the screen and every page scrolled sideways. The "Landing page" pill now shows only its icon on small screens and the search box can shrink.

**Not verified yet**
- The statistics were tested against a stand-in for the Supabase REST API (row counts, filters, the key header) and against the simulated contract, and the public role's permissions were checked directly in the real database. On the deployed API, `/v1/stats` answered from the real project with the real public key: the right contract, network and refresh time, and zeros everywhere, because the copy holds no jobs yet (the contract had none when the indexer ran). Counting real jobs has not been seen.
- Signing with MetaMask has not been tried on the live network.

## 1.3.0 (API) · 0.2.0 (SDK) · 0.2.0 (CLI)

The routes and shapes of 1.0.0 to 1.2.0 did not change. Everything below is added.

**Added**
- **`checkEvidence`** in `@allocyn/sdk` and **`allocyn evidence <rcpt-id>`** in the CLI: download the delivered page on your own machine and compare its SHA-256 with the one the receipt recorded. The API never fetches third-party pages. See [Verification results](verification-results.html).
- **`/verify/{jobId}`**: a readable, shareable page for one job (status, criteria with verdicts, deliveries, how to check it). No script, everything escaped, strict CSP, never cached while the job is not final.
- **`GET /v1/jobs/{jobId}/prepare`** and the MCP tool **`prepare_action`**: check whether accepting, delivering or evaluating is possible, and show exactly what the person would sign, with an SDK call and a link to the app. It only reads (`sent` is always `false`). New optional setting `APP_URL`.
- `allocyn prepare` in the CLI, the matching method in the Python client, and a section in the [agent skill](agent-skill.html) on how to help someone act without acting for them.
- Required query parameters (`required` in the route table, enforced for REST and MCP).

**Not verified yet**
- The evidence comparison assumes the recorded hash is of the raw bytes, as documented. It was tested with stand-in pages and the simulated contract, not against an evaluated receipt on Studionet.
- The app links assume the web app's routes (`/agreements/{id}` and `/agreements/{id}/deliver`), taken from its source; they were not opened in a browser. The delivery page does not pre-fill the link.
- The verification page has no preview image: image previews need a PNG and this API has no image renderer.

## 1.2.0 (API) · 0.1.0 (SDK) · 0.1.0 (CLI)

The routes and shapes of 1.0.0 and 1.1.0 did not change. Everything below is added.

**New reads**
- **`GET /v1/jobs`**: list jobs newest first, filter by `status`, `client` or `worker`, page with `nextCursor` and `before`. The contract has no list view, so the API reads ids one by one (at most 100 per request) and finds the newest id by bisecting; a page can hold fewer than `limit` jobs. Also an MCP tool (`list_jobs`).
- **`GET /v1/jobs/{jobId}/wait`**: a long poll, instead of webhooks. Returns when the job changes (by its `version`) or when the wait ends. Also an MCP tool (`wait_for_job`).
- Routes can now declare typed query parameters, validated the same way for REST and MCP.

**Clients**
- **`@allocyn/cli`**: a read-only command line with no dependencies (`allocyn job job-1`), with documented exit codes.
- **Python client**: one standard-library file generated from the route table, checked by a test so it cannot fall behind.
- **SDK packaging**: `npm run stage:sdk` compiles the SDK to plain JavaScript with type declarations and prepares a publishable folder; a test installs it in a clean project, runs it on plain Node and type-checks it. A release workflow publishes on a `sdk-v*` or `cli-v*` tag.

- An [agent skill](agent-skill.html) in `skills/allocyn/`, generated from the route table (`node scripts/gen-skill.mjs`): it teaches an agent which read to use, how to interpret statuses, what it must not claim, and the safety rules.
- An independent MCP client check (`npm run test:mcp-client`) using the official MCP Python SDK over stdio and HTTP, run in CI.

**Not done, on purpose**
- **Webhooks** need a database of subscriptions and a scheduler, which this API does not have; use `wait`.
- **Relaying signed transactions** stays out: it would put a write path on a server, and it cannot be verified from the build environment.

**Not verified yet**
- Nothing here has been published to npm or PyPI, and the release workflow has not run. The new reads were tested on the simulated contract, not on the live Studionet. The package build was checked with TypeScript 6 locally; CI installs TypeScript 5.

## 1.1.0 (API) · 0.1.0 (SDK)

The `/v1` routes and shapes of 1.0.0 did not change. Everything below is added.

**For agents**
- **MCP server.** Every read route is also a Model Context Protocol tool, generated from the same route table. Connect by URL (`POST /mcp`, stateless) or run it locally over stdio (`npm run mcp -w @allocyn/api`). All tools are read-only. See [Agents and MCP](agents-mcp.html).
- **`/llms.txt`**: a short plain-text summary of the API for models that read the web.

**For sharing a result**
- **`GET /v1/jobs/{jobId}/proof`**: terms, parties, status and every delivery's verdicts in one document, with a SHA-256 digest of those facts (not a signature) and the steps to check them against the contract.
- **`GET /v1/jobs/{jobId}/badge.svg`**: a status badge for a README. Errors also come back as badges, with the right status code.

**Architecture**
- **HTTP caching.** `ETag` and `If-None-Match` (`304`) on every read. Answers that can never change again, read with `?consistency=final`, are `public, max-age=300` and served from memory for an hour.
- **Shared rate limit (optional).** With `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (or Vercel's `KV_REST_API_*`), every instance counts in one store. Only a hash of the client address and a count are stored. If the store fails, the in-memory limiter takes over.
- The REST server and the MCP server now build their read context from one shared function.

**Checks**
- 30 new automated tests (MCP over HTTP and stdio, proof, badge, caching, the shared limiter). 
- A live read-only suite for Studionet (`npm run test:live`) and a GitHub Actions workflow that runs the simulated tests on every push and the live suite daily.

**Not verified yet**
- The MCP server was checked with the official MCP Python SDK against the simulated contract (stdio and HTTP), but not with a desktop agent, and the live suite has **not been run**: the build environment cannot reach Studionet or install `genlayer-js`. The shared limiter was tested with a stand-in for the Upstash REST API, not a real account. Run `npm run test:live` once yourself, and try the MCP URL in your own agent.

## 1.0.0 (API) · 0.1.0 (SDK)

First release.

**Contract**
- Built for the Smart Agreement contract at `0x5729a3b514654Ec5966A1DCa8e5088ef7A70bBDA` (source SHA-256 `58fd3877…5f57`), the revision with larger limits (1–20 criteria, 5,000-character descriptions, 250,000-byte deliverables) and a `get_limits()` view.

**API**
- Read-only endpoints: `health`, `meta`, `limits` (live from `get_limits()`), `jobs/{jobId}`, `jobs/{jobId}/receipts`, `jobs/{jobId}/receipts/{deliveryIndex}`, `receipts/{receiptId}`, `transactions/{txHash}`.
- Uniform success and error envelopes, `?consistency=latest|final`, CORS allow-list, in-memory rate limiting, request timeouts, request ids.
- OpenAPI 3.1 at `/openapi.json`, kept in sync with the routes by a test.
- Deployable on Vercel (`vercel.json`, serverless bundle) or on any Node host. The Vercel path was tested locally only.

**SDK**
- `createAllocynClient` with read methods and the four writes, each validating first, sending once and re-reading the contract before returning.
- `getLimits()` reads the contract's limits live and compares them with the SDK's pinned copy; writes are refused if they differ. Default soft limit of 5 criteria (raise to 20 with `softLimits`).
- Typed errors with `txHash`, `retryable` and `field`; wrong-network guard for browser wallets; optional persistence of unfinished transaction hashes.

**Known limits of this release**
- Tested against an in-memory contract double and fixtures generated from the contract's Python code. **Not** run against the live Studionet RPC, a real wallet or real validators from the build environment.
- Studionet only. No relay of signed transactions. No webhooks, no listing or search of jobs (the contract has no list method).
- The SDK is not published to a registry.
