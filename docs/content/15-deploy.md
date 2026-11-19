---
title: Deploying
group: Guides
summary: Run the API on Vercel, or on any host that runs Node.
---
# Deploying

The API is read-only and stateless, so it deploys anywhere Node.js 22.6 or newer runs. Two ways are prepared.

## Vercel

The repository folder `allocyn/` is a ready Vercel project: `vercel.json` builds the docs and bundles the API into one serverless function (`api/index.mjs`). The docs are served as static files, and `/v1/*` goes to the function.

Vercel looks for serverless functions **before** it runs the build, so `api/index.mjs` must be committed to the repository. Do not add it to `.gitignore`. After you change anything under `packages/`, run `npm run vercel:build` and commit the new `api/index.mjs`; `npm run vercel:check` (also part of `npm test`) fails when the committed file is out of date.

1. Push the repository to GitHub, including `api/index.mjs`, and import it in Vercel. Set **Root Directory** to `allocyn`.
2. Leave the build settings as they are (`vercel.json` sets them). Use a Node.js version of 22 or newer.
3. Add these environment variables (none is a secret):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `API_BASE_URL` | your public URL, e.g. `https://your-project.vercel.app` |
| `APP_URL` | optional: where the Allocyn web app lives (https). Only used to build the app links in `prepare_action` answers |
| `CORS_ORIGINS` | the exact origins that may call the API from a browser, comma separated (`*` is refused in production) |
| `TRUST_PROXY` | `true` |
| `REQUEST_TIMEOUT_MS` | `8000` (keep it under the function's duration limit) |
| `GENLAYER_NETWORK` | `studionet` |

Do **not** add a private key or seed phrase: the API refuses to start if it finds one.

4. Deploy, then check it in this order:

```bash
curl -s https://your-project.vercel.app/v1/health
curl -s https://your-project.vercel.app/v1/limits      # matchesPinned should be true
curl -s https://your-project.vercel.app/v1/jobs/job-1
```

If `/v1/*` answers `404` from Vercel or the logs show the wrong path, the rewrite in `vercel.json` is the place to look. If it answers `500 INTERNAL` with "not configured correctly", read the function logs: the message names the variable.

### What to know on Vercel

- **Rate limiting is per instance by default.** The built-in counter lives in memory, and serverless instances come and go, so it is not a real limit there. For one shared limit, connect an Upstash Redis (Vercel's Marketplace adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`, which the API reads) or use Vercel's firewall rate limiting. The shared store has been tested here with a stand-in for the Upstash REST API, not with a real Upstash account.
- **Cold starts.** The first request after idle time loads `genlayer-js` and is slower.
- **Duration.** The function is configured for up to 30 seconds. Your plan may allow less; the API's own timeout (`REQUEST_TIMEOUT_MS`) should stay below whatever applies.
- **Docs "Try it".** Set the base URL field to your deployed address if the docs are hosted elsewhere.

> **Status.** The bundle and the function entry were tested locally against a stand-in for `genlayer-js`. They have **not** been deployed to Vercel or run with the real `genlayer-js` from where they were written. Treat the first deploy as the test, and run the three checks above.

## Optional: a database copy of the jobs

The API reads the contract directly and needs no database. If you want fast lists and counts, an **indexer** can copy the public jobs and receipts into a Postgres database (Supabase). It is separate from the API function: it runs as a scheduled job, and the API function never receives its key.

1. Create a Supabase project and apply the files in `supabase/migrations/` in order. Row level security is on for every table: the public key can read jobs and receipts, and nothing else. Writes need the secret key.
2. In the repository's **Settings, Secrets and variables, Actions**, add two secrets: `SUPABASE_URL` (the project URL) and `SUPABASE_SECRET_KEY` (a Supabase secret key). They go only there, never in the repository or in the Vercel variables of the API.
3. The workflow `.github/workflows/index.yml` runs about once an hour and can be started by hand from the Actions tab. Until the secrets exist it does nothing. To run it yourself: `SUPABASE_URL=... SUPABASE_SECRET_KEY=... npm run index`.

What it does: reads the contract with a read-only client and **final** reads only, so the copy never holds something the network could still change. It adds new jobs, re-reads the ones that are not `VERIFIED` yet, and writes the receipts of each. It records which contract the database mirrors and refuses to write if that changes. The contract stays the source of truth; the copy can be deleted and rebuilt.

> **Status.** The indexer was tested against a stand-in for the Supabase REST API, which enforces the same table rules, and against the simulated contract. It has **not** been run against a real Supabase project or the live network. The first manual run from the Actions tab is the real test. No API endpoint reads the copy yet.

## Any Node host

Railway, Render, Fly.io, Cloud Run or a VPS:

```bash
npm install
npm run docs:build
NODE_ENV=production CORS_ORIGINS=https://your-app.example npm start
```

`npm start` serves the API and these docs on `PORT` (default 8787). Put it behind HTTPS and set `TRUST_PROXY=true` only if the proxy is yours. Here the in-memory rate limiter works as long as you run a single instance.

## Linking the app and the repository

Once they exist, put their `https://` URLs in `docs/site.config.json` (`appUrl`, `repoUrl`) or in the `ALLOCYN_APP_URL` and `ALLOCYN_REPO_URL` variables at build time. The landing page shows the buttons only when set.
