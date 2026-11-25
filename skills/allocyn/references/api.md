# Allocyn API reference for agents

Generated from API 1.8.0. Every endpoint is `GET`. Answers are JSON `{ success, data }` or `{ success: false, error }`, except the badge (SVG).

| Endpoint | MCP tool | Parameters | What it does |
|---|---|---|---|
| `GET /v1/health` | `get_health` | `?deep` (boolean) | Liveness. Says the API process is up. |
| `GET /v1/meta` | `get_meta` | none | Network, contract and API facts. Which network and contract this API reads, the contract profile it was built for, and the read consistency in use. |
| `GET /v1/limits` | `get_limits` | none | Input limits. The limits the contract reports right now (get_limits()), next to the copy this API was built for. |
| `GET /v1/jobs` | `list_jobs` | `?limit` (integer, max 50), `?before` (string), `?status` (OPEN, IN_PROGRESS, VERIFIED, NEEDS_REVISION, INCONCLUSIVE), `?client` (string), `?q` (string), `?updatedSince` (string), `?source` (contract, copy, auto), `?worker` (string), `?consistency` (latest or final) | List jobs. Jobs from newest to oldest, with an optional filter by status, client or worker. |
| `GET /v1/stats` | `get_stats` | `?client` (string), `?worker` (string) | Counts and statistics. How many jobs there are in each status, and how many deliveries got each verdict, optionally for one client or one worker. |
| `GET /v1/events` | `list_events` | `?after` (integer), `?limit` (integer, max 100), `?job` (string), `?type` (job_created, job_accepted, delivery_submitted, delivery_evaluated, status_changed), `?worker` (string), `?client` (string), `?wait` (integer, max 25) | Feed of job events. What changed in the jobs, oldest first: a job was created or accepted, a delivery came in or got its verdict, a status moved. |
| `GET /v1/addresses/{address}` | `get_address_record` | `address` | What the copy holds about an address. For one wallet address: how many jobs it created (as client) and accepted (as worker) in each status, how many deliveries it made and the verdicts they got, and its five newest jobs on each side. |
| `GET /v1/jobs/{jobId}` | `get_job` | `jobId`, `?consistency` (latest or final) | Read a job. The job's terms, parties, status and receipt ids, read from the contract. |
| `GET /v1/jobs/{jobId}/proof` | `get_job_proof` | `jobId`, `?consistency` (latest or final) | Proof pack of a job. A portable proof pack, safe to save and send as a file (format: "allocyn.proof", version 1). |
| `GET /v1/jobs/{jobId}/badge.svg` | REST only | `jobId`, `?consistency` (latest or final) | Status badge (SVG). A small SVG badge with the job's status, for a README or a portfolio: ![job](https://your-api/v1/jobs/job-1/badge.svg). |
| `GET /v1/jobs/{jobId}/wait` | `wait_for_job` | `jobId`, `?since` (string), `?timeout` (integer, max 25), `?consistency` (latest or final) | Wait for a job to change. Long poll, instead of webhooks. |
| `GET /v1/jobs/{jobId}/prepare` | `prepare_action` | `jobId`, `?action` (accept, submit, evaluate), `?deliveryUrl` (string), `?actor` (string), `?consistency` (latest or final) | Prepare an action for the person to sign. Checks whether accepting, delivering or evaluating is possible on this job right now, and says exactly what the person would sign: the contract call, the SDK call and a link to the Allocyn app. |
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
