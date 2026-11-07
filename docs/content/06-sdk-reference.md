---
title: SDK reference
group: API and SDK
summary: createAllocynClient, every method, options, return shapes and errors.
---
# SDK reference

```bash
npm install @allocyn/sdk genlayer-js
```

`genlayer-js` (`^1.1.8`) is a peer dependency, loaded only when you build a client that talks to the network. Types, validation and tests do not need it. The package is currently marked private in this repository: publishing it to npm is a step you take, and I have not checked whether the name `@allocyn/sdk` is available on the registry.

## `createAllocynClient(options)`

Returns a promise of an `AllocynClient`. With no `signer` the client is **read-only**.

| Option | Type | Default | Notes |
|---|---|---|---|
| `network` | `"studionet"` | `"studionet"` | The only enabled network. |
| `contractAddress` | `0x…` | the network's address | Must be a contract with the same interface. See [Networks](networks.html). |
| `signer` | `{type:"provider", provider, address}` \| `{type:"account", account}` | none | See [Authentication](auth-wallets.html). |
| `readConsistency` | `"latest"` \| `"final"` | `"latest"` | `final` reads finalized state only. |
| `softLimits` | partial `SoftLimits` | contract limits, but 5 criteria | Stricter checks applied before sending. Cannot exceed the contract's. |
| `storage` | `getItem/setItem/removeItem` | none | e.g. `localStorage`. Remembers unfinished transaction hashes. |
| `pollIntervalMs`, `maxWaitMs` | number | 3000, 900000 | Transaction polling. |
| `limitsTtlMs` | number | 60000 | How long `getLimits()` is reused. |

## Reads

| Method | Returns | Throws |
|---|---|---|
| `getMeta()` | network, contract, profile, `canWrite`, `actor` (no network call) | – |
| `getLimits()` | `LimitsReport`: the contract's live `get_limits()`, the pinned copy, `matchesPinned`, your soft limits (cached 60 s) | `NETWORK_UNREACHABLE` |
| `getPinnedLimits()` | the limits this SDK was built for (no network call) | – |
| `getJob(jobId)` | `JobDto` | `INVALID_ARGUMENT`, `JOB_NOT_FOUND` |
| `getJobReceipts(jobId)` | `ReceiptDto[]` in delivery order | same |
| `getReceiptByIndex(jobId, n)` | `ReceiptDto` (`n` starts at 1) | `RECEIPT_NOT_FOUND` |
| `getReceipt(receiptId)` | `ReceiptDto` | `RECEIPT_NOT_FOUND` |
| `getTransaction(txHash)` | `{ phase, statusName, decided, failureMessage, label }` | `INVALID_ARGUMENT`, `NETWORK_UNREACHABLE` |

## Writes

Every write returns `{ txHash, data }`, where `data` is **re-read from the contract after the transaction**, never assumed.

| Method | Who | `data` |
|---|---|---|
| `createJob({ title, description, criteria })` | anyone | `JobDto` (`OPEN`) |
| `acceptJob(jobId)` | not the client | `JobDto` (`IN_PROGRESS`) |
| `submitDelivery(jobId, url)` | the worker | `{ job, receipt }` (receipt `PENDING`) |
| `evaluateDelivery(jobId, receiptIdOrIndex)` | client or worker | `{ job, receipt }` (receipt `EVALUATED`) |

All accept `{ onProgress }`, called with `{ phase, txHash, statusName }` as the transaction moves: `awaiting_wallet` → `submitted` → `in_consensus` → `decided` → `finalized`.

### What every write guarantees

1. **Validates locally first.** Bad input throws `INVALID_ARGUMENT` before the wallet is asked anything.
2. **Checks the contract's limits** (`createJob`, `submitDelivery`): if `get_limits()` no longer matches this SDK, it throws `CONFIGURATION` and sends nothing.
3. **Reads the contract** and refuses with `PRECONDITION_FAILED` if the contract would refuse (wrong role, wrong state, no deliveries left).
4. **Sends exactly one transaction.** It never resubmits by itself.
5. **Waits for consensus, then re-reads** the contract. If the change is not visible it throws `TRANSACTION_NOT_CONFIRMED` instead of reporting success.
6. **Never invents an id.** A new job id is taken from the contract's own state; if it cannot be determined with certainty, the write throws.

`createJob` and `evaluateDelivery` can take minutes (validators fetch the page and call an LLM). Persist `txHash` from `onProgress` as soon as you have it.

## Errors

Every failure is an `AllocynError` with `code`, `message`, `retryable`, `txHash` (or `null`) and `field`. See [Error handling](errors.html) for the full table and what to do for each.

```ts
try {
  await allocyn.submitDelivery("job-1", url);
} catch (e) {
  if (isAllocynError(e) && e.txHash) {
    // The transaction exists and may still complete: do NOT send it again.
    const tx = await allocyn.getTransaction(e.txHash);
  }
}
```

## Types

`JobDto`, `ReceiptDto`, `CriterionResultDto`, `TransactionInfo`, `Meta`, `ContractLimits`, `SoftLimits`, `NetworkInfo` and the status unions are exported from the package root and documented with JSDoc.
