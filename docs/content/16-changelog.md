---
title: Changelog
group: Guides
summary: What changed in each version of the API, SDK and docs.
---
# Changelog

Versions: **API v1** (URL prefix `/v1`, release 1.1.0), **SDK 0.1.0**, **docs v1**. Breaking changes to the API will get a new prefix (`/v2`) and a new docs version; `/v1` will not change shape silently.

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
- The MCP server has not been run with an external MCP client, and the live suite has **not been run**: the build environment cannot reach Studionet or install `genlayer-js`. The shared limiter was tested with a stand-in for the Upstash REST API, not a real account. Run `npm run test:live` once yourself, and try the MCP URL with your own client.

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
