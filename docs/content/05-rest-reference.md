---
title: REST reference
group: API and SDK
summary: Every endpoint, parameter and response of the read-only /v1 API, with a live try-it.
generated: openapi
---
# REST reference

Base URL: the address of the API you run (default `http://localhost:8787`). The machine-readable contract is at [`/openapi.json`](/openapi.json) (OpenAPI 3.1). The endpoint list below is generated from the same route table the server uses, and a test fails if they ever differ.

## Conventions

- **Read-only.** Only `GET` (and `HEAD`, `OPTIONS`). Any other method on an existing endpoint returns `405 METHOD_NOT_ALLOWED`; on a path that is not an endpoint (for example `POST /v1/jobs`) the answer is `404 NOT_FOUND`. Writes go through the [SDK](sdk-reference.html).
- **Envelope.** Success: `{ "success": true, "data": ... }`. Failure: `{ "success": false, "error": { "code", "message", "retryable", "field"? } }`.
- **`?consistency=`** on contract reads: `latest` (default) includes state that is not final yet; `final` reads finalized state only. The response header `X-Allocyn-Consistency` tells you which was used.
- **Unknown query parameters are rejected** with `400`, so a typo does not silently change what you get.
- **Headers.** `X-Request-Id` on every response, `X-RateLimit-Limit` and `X-RateLimit-Remaining`, and `Retry-After` on `429`.
- **CORS.** Browser calls are allowed only from the origins listed in `CORS_ORIGINS`.
- **Caching.** Reads of contract data carry an `ETag`; send it back in `If-None-Match` and an unchanged answer is a `304` with no body. They are `Cache-Control: no-cache`, so clients revalidate. The exception is an answer that can never change again (a `VERIFIED` job, a job whose deliveries are used up, an evaluated receipt) read with `?consistency=final`: it is `public, max-age=300`, and the server answers it from memory (`X-Allocyn-Cache: hit`) for an hour. Reads with `latest` are never cached for long, because they may include state that is not final. `/v1/meta` and `/v1/limits` may be cached for 60 s, and the badge for 60 s.

## HTTP status codes

| Status | `error.code` | Meaning |
|---|---|---|
| 400 | `INVALID_ARGUMENT` | A path or query value is malformed. `error.field` names it. |
| 404 | `JOB_NOT_FOUND`, `RECEIPT_NOT_FOUND`, `NOT_FOUND` | The id (or the route) does not exist. |
| 405 | `METHOD_NOT_ALLOWED` | Not a GET. |
| 429 | `RATE_LIMITED` | Wait `Retry-After` seconds. |
| 502 | `UPSTREAM_UNAVAILABLE`, `CONTRACT_NOT_FOUND`, `DATA_INTEGRITY` | The network or contract did not answer, or answered with data the API refuses to pass on. |
| 503 | `UPSTREAM_UNAVAILABLE` | Only from `/v1/health?deep=true`. |
| 504 | `UPSTREAM_TIMEOUT` | The network took longer than `REQUEST_TIMEOUT_MS`. |
| 500 | `INTERNAL` | Unexpected. The message is generic on purpose; details stay in the server log. |

## Endpoints
