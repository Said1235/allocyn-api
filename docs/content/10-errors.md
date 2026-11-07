---
title: Error handling
group: Reference
summary: Error codes, the four contract error classes, and what to do about each.
---
# Error handling

## The four classes the contract uses

When the contract itself refuses something, its message starts with a class prefix. The SDK reads it to decide whether trying again is reasonable.

| Class | Meaning | Retry? |
|---|---|---|
| `[EXPECTED]` | A rule was broken: wrong role, wrong state, invalid input. | No. Fix the cause. |
| `[EXTERNAL]` | The outside world failed: the delivered link could not be opened, wrong HTTP status, empty or too large or non-UTF-8 content. | Maybe: check the link, then try the evaluation again. |
| `[TRANSIENT]` | Temporary condition, e.g. the source was briefly unavailable. | Yes, after a pause. |
| `[LLM_ERROR]` | The validators' model could not produce a usable verdict. | Yes. The delivery is still waiting. |

These classes appear on **writes** (`TRANSACTION_FAILED`). Reads never fail this way.

## SDK error codes

| `code` | When | `retryable` | What to do |
|---|---|---|---|
| `INVALID_ARGUMENT` | Bad input, caught locally. `field` says which. | no | Fix the input. Nothing was sent. |
| `JOB_NOT_FOUND`, `RECEIPT_NOT_FOUND` | The id does not exist. | no | Check the id. |
| `PRECONDITION_FAILED` | The contract would refuse (wrong role or state). | no | Re-read the job. Nothing was sent. |
| `SIGNER_REQUIRED` | A write on a read-only client. | no | Pass a `signer`. |
| `WRONG_NETWORK` | The wallet is not on Studionet. | no | Switch the wallet's network. Nothing was sent. |
| `USER_REJECTED` | The person declined to sign. | no | Do not retry automatically. |
| `TRANSACTION_FAILED` | Consensus decided but the contract call failed, or the transaction was cancelled, undetermined or timed out. Carries `txHash`. | per class above | Read `message`; for `[EXTERNAL]`/`[TRANSIENT]`/`[LLM_ERROR]` you may request the evaluation again. |
| `TRANSACTION_NOT_CONFIRMED` | Consensus decided but the expected change is not visible on the contract. Carries `txHash`. | no | Re-read the job later. **Do not resend.** |
| `TIMEOUT` | The wait ended before consensus did. Carries `txHash`. | no | Look the transaction up; it may still complete. **Do not resend.** |
| `NETWORK_UNREACHABLE` | RPC or wallet not answering. | yes | Retry reads after a pause. For a write with a `txHash`, look it up first. |
| `CONTRACT_NOT_FOUND` | No Allocyn contract at the address on that network. | no | Check network and address. |
| `DATA_INTEGRITY` | The contract returned data the SDK refuses (malformed, or hashes that do not match). | no | Do not use that data. Report it. |
| `CONFIGURATION` | Bad client options. | no | Fix the configuration. |

## The golden rule for writes

If an error has a `txHash`, **the transaction may still complete.** Look it up with `getTransaction(txHash)` or re-read the job. Only if you can show it was cancelled, or undetermined, is it safe to send the action again. The SDK never retries a write on its own, and your code should not either.

## API errors

The API maps SDK errors to HTTP: see the table in the [REST reference](rest-reference.html#http-status-codes). Bodies never contain stack traces, internal hostnames or raw upstream error text.
