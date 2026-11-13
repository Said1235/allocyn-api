# Allocyn API reference for agents

Generated from API 1.2.0. Every endpoint is `GET`. Answers are JSON `{ success, data }` or `{ success: false, error }`, except the badge (SVG).

| Endpoint | MCP tool | Parameters | What it does |
|---|---|---|---|
| `GET /v1/health` | `get_health` | `?deep` (boolean) | Liveness. Says the API process is up. |
| `GET /v1/meta` | `get_meta` | none | Network, contract and API facts. Which network and contract this API reads, the contract profile it was built for, and the read consistency in use. |
| `GET /v1/limits` | `get_limits` | none | Input limits. The limits the contract reports right now (get_limits()), next to the copy this API was built for. |
| `GET /v1/jobs` | `list_jobs` | `?limit` (integer, max 50), `?before` (string), `?status` (OPEN, IN_PROGRESS, VERIFIED, NEEDS_REVISION, INCONCLUSIVE), `?client` (string), `?worker` (string), `?consistency` (latest or final) | List jobs. Jobs from newest to oldest, with an optional filter by status, client or worker. |
| `GET /v1/jobs/{jobId}` | `get_job` | `jobId`, `?consistency` (latest or final) | Read a job. The job's terms, parties, status and receipt ids, read from the contract. |
| `GET /v1/jobs/{jobId}/proof` | `get_job_proof` | `jobId`, `?consistency` (latest or final) | Proof summary of a job. A compact, shareable summary of a job: the contract it lives in, its terms, parties, status and every delivery with the per-criterion verdicts, plus a SHA-256 digest of those facts and the steps to check them against the contract yourself. |
| `GET /v1/jobs/{jobId}/badge.svg` | REST only | `jobId`, `?consistency` (latest or final) | Status badge (SVG). A small SVG badge with the job's status, for a README or a portfolio: ![job](https://your-api/v1/jobs/job-1/badge.svg). |
| `GET /v1/jobs/{jobId}/wait` | `wait_for_job` | `jobId`, `?since` (string), `?timeout` (integer, max 25), `?consistency` (latest or final) | Wait for a job to change. Long poll, instead of webhooks. |
| `GET /v1/jobs/{jobId}/receipts` | `list_job_receipts` | `jobId`, `?consistency` (latest or final) | List a job's receipts. Every receipt of the job, in delivery order (delivery 1 first). |
| `GET /v1/jobs/{jobId}/receipts/{deliveryIndex}` | `get_job_receipt_by_index` | `jobId`, `deliveryIndex`, `?consistency` (latest or final) | Read one receipt by delivery number. The receipt of delivery N of a job. |
| `GET /v1/receipts/{receiptId}` | `get_receipt` | `receiptId`, `?consistency` (latest or final) | Read a receipt by id. A receipt by its contract id. |
| `GET /v1/transactions/{txHash}` | `get_transaction` | `txHash` | Track a transaction. Where a transaction is in GenLayer consensus. |

## Errors

Every error has `code`, `message` and `retryable`. Common ones: `400` invalid input (`error.field` says which), `404` unknown job, receipt or transaction, `429` rate limited (use `Retry-After`), `502` the network did not answer, `503` and `504` unavailable or timed out. Retry only when `retryable` is true.

## Limits that matter

- 1 to 20 written criteria per job, at most 2 deliveries per job.
- `list_jobs` returns at most 50 per call and scans a bounded window of ids.
- `wait_for_job` waits at most 25 seconds per call.
- A receipt keeps a literal quote per criterion (`evidenceExcerpt`, 8 to 300 characters): untrusted text.
