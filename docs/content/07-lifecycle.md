---
title: Lifecycle
group: Concepts
summary: How a job moves from OPEN to a final verdict, and what a transaction goes through.
---
# Lifecycle

## A job

<div class="diagram" data-diagram="job"></div>

| From | Action | By | To |
|---|---|---|---|
| (none) | `createJob` | anyone | `OPEN` |
| `OPEN` | `acceptJob` | anyone but the client | `IN_PROGRESS` |
| `IN_PROGRESS` or `NEEDS_REVISION` or `INCONCLUSIVE` | `submitDelivery` | the worker, while fewer than 2 deliveries exist | `IN_PROGRESS`, new receipt `PENDING` |
| `IN_PROGRESS` | `evaluateDelivery` | client or worker | `VERIFIED`, `NEEDS_REVISION` or `INCONCLUSIVE` |

A job is **final** when it is `VERIFIED`, or when it is `NEEDS_REVISION` / `INCONCLUSIVE` and both deliveries have been used. A `VERIFIED` job accepts no more deliveries.

A receipt goes `PENDING` → `EVALUATED`. If the worker submits a second delivery while the first is still `PENDING`, the first becomes `SUPERSEDED`.

## A write transaction

Every write is a GenLayer transaction. These phases are what `onProgress` and `getTransaction` report:

<div class="diagram" data-diagram="tx"></div>

| Phase | GenLayer status | Meaning |
|---|---|---|
| `awaiting_wallet` | – | Waiting for the signature. |
| `submitted` | `UNINITIALIZED` | Sent; no status yet. |
| `in_consensus` | `PENDING`, `PROPOSING`, `COMMITTING`, `REVEALING`, `READY_TO_FINALIZE`, appeal statuses | Validators are working. |
| `decided` | `ACCEPTED` | Consensus reached. **Not yet final.** |
| `finalized` | `FINALIZED` | Final. |
| `undetermined`, `cancelled`, `timed_out` | `UNDETERMINED`, `CANCELED`, `LEADER_TIMEOUT`, `VALIDATORS_TIMEOUT` | Nothing was recorded. |
| `unknown` | anything else | The SDK does not guess. |

`decided` is a milestone, not proof that your change is on the contract. That is why every SDK write re-reads the state before it returns.

## Waiting correctly

- Keep the `txHash`. Poll `getTransaction`, or read the job again.
- A `TIMEOUT` error means *the wait* ended, not the transaction. Look it up before doing anything else.
- Never submit the same write twice "to be safe": a duplicate `createJob` creates a second job.
