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

- **Rate limiting is per instance.** The built-in counter lives in memory, and serverless instances come and go, so it is not a real limit there. Use Vercel's firewall rate limiting.
- **Cold starts.** The first request after idle time loads `genlayer-js` and is slower.
- **Duration.** The function is configured for up to 30 seconds. Your plan may allow less; the API's own timeout (`REQUEST_TIMEOUT_MS`) should stay below whatever applies.
- **Docs "Try it".** Set the base URL field to your deployed address if the docs are hosted elsewhere.

> **Status.** The bundle and the function entry were tested locally against a stand-in for `genlayer-js`. They have **not** been deployed to Vercel or run with the real `genlayer-js` from where they were written. Treat the first deploy as the test, and run the three checks above.

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
