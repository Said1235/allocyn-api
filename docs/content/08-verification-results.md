---
title: Verification results
group: Concepts
summary: How to read a receipt, what each verdict means, and what it does not mean.
---
# Verification results

An `EVALUATED` receipt:

```json
{
  "id": "rcpt-1", "jobId": "job-1", "deliveryIndex": 1,
  "worker": "0x…", "url": "https://example.com/logo-package",
  "status": "EVALUATED",
  "agreementHash": "…64 hex…", "evidenceHash": "…64 hex…", "evidenceSize": 1234,
  "overallStatus": "VERIFIED",
  "evaluationRequestedBy": "0x…",
  "results": [
    { "criterionId": "C1", "status": "MET", "reasonCode": "MEETS_CRITERION", "evidenceExcerpt": "…a literal quote…" }
  ]
}
```

(Field names and shapes are real. The values above are placeholders; see the generated examples in the [REST reference](rest-reference.html), which are labelled as simulated.)

## Verdicts

| `overallStatus` | Rule | Meaning |
|---|---|---|
| `VERIFIED` | every criterion `MET` | The validators found each criterion satisfied by the delivered text. |
| `NEEDS_REVISION` | none `UNVERIFIABLE`, at least one `NOT_MET` | At least one criterion was judged unmet. |
| `INCONCLUSIVE` | at least one `UNVERIFIABLE` | The text did not contain enough evidence to decide. |

Per-criterion reason codes are fixed: `MET` ↔ `MEETS_CRITERION`, `NOT_MET` ↔ `REQUIREMENT_NOT_MET`, `UNVERIFIABLE` ↔ `INSUFFICIENT_EVIDENCE`. The contract rejects any other combination.

## Evidence

- `evidenceHash` is the SHA-256 of the exact bytes validators read, `evidenceSize` their length. Fetch the same URL later and compare to see if the page has changed since.
- `evidenceExcerpt` is a **literal quote** from the page, 8–300 characters. It is untrusted text: **display it as plain text, never as HTML.**
- The contract reads at most **250,000 bytes** of UTF-8 text from an `https://` URL with HTTP status 200.

## Reading a verdict responsibly

- A verdict comes from LLM-assisted validators under consensus. Treat it as a **documented, reproducible judgement against written criteria**, not as proof of quality.
- Write criteria that can be checked in the delivered text ("contains the word *refund*"), not matters of taste ("is professional").
- Check `integrity` on the job: if a hash does not match, do not rely on the data.
- The page can change after validation. The receipt records what was read at that time.
