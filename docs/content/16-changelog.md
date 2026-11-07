---
title: Changelog
group: Guides
summary: What changed in each version of the API, SDK and docs.
---
# Changelog

Versions: **API v1** (URL prefix `/v1`), **SDK 0.1.0**, **docs v1**. Breaking changes to the API will get a new prefix (`/v2`) and a new docs version; `/v1` will not change shape silently.

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
