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

## Has the page changed since it was judged?

The receipt records the SHA-256 and the size of the bytes the validators read. You can download the page yourself and compare. The check runs **on your machine**: the Allocyn API never fetches third-party pages.

```bash
node packages/cli/dist/cli.js evidence rcpt-1
```

```ts
import { checkEvidence } from "@allocyn/sdk";
const receipt = await allocyn.getReceipt("rcpt-1");
const check = await checkEvidence(receipt);   // { status, reason, currentHash, recordedHash, caveat }
```

| `status` | Meaning |
|---|---|
| `unchanged` | The page has the same bytes as when it was judged. |
| `changed` | Different bytes. It can be harmless (an ad, a timestamp) or a real edit. |
| `unreachable` | The page did not answer HTTP 200, or could not be fetched. |
| `not_comparable` | The check cannot be made: the receipt is not judged yet, the URL is not `https`, it has embedded credentials, or the page is larger than the 250,000 bytes the contract reads. |

The CLI exits with `0` only when the page is `unchanged`, and with `4` otherwise. An unchanged page says nothing about whether the verdict was **right**. The comparison assumes the recorded hash is of the raw bytes, as documented above; this has been tested with a stand-in page and the simulated contract, not against an evaluated receipt on the live network.

## Check a proof pack without trusting the API

`GET /v1/jobs/{id}/proof` returns a **proof pack**: one JSON file (`format: "allocyn.proof"`, version 1) with the job's written terms, its parties, every delivery with the per-criterion verdicts, the contract it lives in and a SHA-256 digest of those facts. Save it, attach it to an email or commit it to a repository. The verification page also offers it as a download.

Anyone can then check the file themselves. The check does not ask the Allocyn API anything:

```bash
curl -s https://your-api/v1/jobs/job-1/proof > proof.json
allocyn verify proof.json            # offline checks only
allocyn verify proof.json --chain    # also re-reads the contract (needs @allocyn/sdk installed)
allocyn verify proof.json --chain --evidence   # and downloads each judged page
```

```ts
import { createAllocynClient, verifyProofPack } from "@allocyn/sdk";
const allocyn = await createAllocynClient();
const result = await verifyProofPack(pack, { reader: allocyn });   // pack or the { success, data } answer
// result.verdict: "verified" | "consistent" | "mismatch" | "invalid"
```

| Check | What it does |
|---|---|
| `format` | The file is an `allocyn.proof` pack of a version this SDK understands. |
| `digest` | The facts hash to the digest in the file, so the file was not altered. |
| `contract` | The contract address, chain and audited source hash are the ones this SDK knows. |
| `hashes` | The job's terms hash and agreement hash recompute from its written terms and parties. |
| `consistency` | The parts of the pack agree with each other (delivery numbers, verdicts, `final`). |
| `chain` | The job and every delivery match what the contract returns now. Only with a reader or `--chain`. |
| `evidence` | Optional. Each judged page still has the bytes it had when it was judged. A change is a warning, not a failure. |

`verified` means every check passed, including the fresh read of the contract. `consistent` means everything that needs no network passed, but the contract was **not** read: an attacker who also recomputes the digest passes those, and only `chain` catches them. `mismatch` means a check failed. For a job that was not final in the pack, a `chain` failure can simply mean the job moved on; fetch a new pack. The CLI exits `0` for `verified` and `consistent`, `1` for `mismatch` and `invalid`, and `3` when the file cannot be read.

What a pack does not do:

- It is **not a signature**. The digest only shows that the file was not altered after it was made; reading the contract is what proves the facts.
- The contract does not store transaction hashes, so the pack has none. `contractUrl` opens the contract on the explorer.
- It says the work was judged, not that it is good. `VERIFIED` is not a payment, an escrow or a guarantee of quality.
- Quotes from the delivered page (`evidenceExcerpt`) are left out on purpose: they are third-party text.

## Reading a verdict responsibly

- A verdict comes from LLM-assisted validators under consensus. Treat it as a **documented, reproducible judgement against written criteria**, not as proof of quality.
- Write criteria that can be checked in the delivered text ("contains the word *refund*"), not matters of taste ("is professional").
- Check `integrity` on the job: if a hash does not match, do not rely on the data.
- The page can change after validation. The receipt records what was read at that time.

## Sharing a result: page, proof and badge

**A page for people.** `GET /verify/job-1` on your API is a readable page for one job: the status, the written criteria with their verdicts, the deliveries with their evidence hashes and how to check it yourself. Paste the link in a chat or a README. It has no script and no external request, everything that comes from the chain is escaped, and a job that is not final is never cached. It sets a title and a description for link previews but no preview image. Search engines are asked not to index it.

Three reads exist to show a job to someone who does not use the API.

**Proof summary.** `GET /v1/jobs/{jobId}/proof` returns the contract, the terms, the parties, the status and every delivery with its per-criterion verdicts in one document (`facts`), a SHA-256 `digest` of those facts, and the steps to check them against the contract yourself. `final: true` means the job cannot change any more. Quoted evidence excerpts are left out on purpose: they are text from a third-party page, and stay in the receipts.

The digest helps notice that a copy of the proof was altered. It is **not a signature**, and it proves nothing about the contract. The only check that counts is reading the contract.

**Badge.** `GET /v1/jobs/{jobId}/badge.svg` is a small image with the job's status, for a README or a portfolio:

```md
[![Allocyn job](https://your-project.vercel.app/v1/jobs/job-1/badge.svg)](https://your-project.vercel.app/verify/job-1)
```

It repeats what the contract says right now, so a badge for a job that is not final can change. An unknown or invalid job still returns a badge ("job not found", "invalid job id") with the matching status code.
