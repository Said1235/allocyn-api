---
title: Core concepts
group: Start
summary: Jobs, criteria, deliveries, receipts, verdicts and hashes.
---
# Core concepts

**Job.** The agreement. It has a `title`, a `description`, 1–20 `criteria`, a `client` (the address that created it) and, once accepted, a `worker`. Its id is `job-N`.

**Criterion.** One checkable sentence, e.g. *"Mentions a 14-day trial"*. Criteria get ids by position (`C1`, `C2`, ...). The contract rejects duplicates.

**Delivery.** The worker submits **one public `https://` link**. A job accepts at most **2 deliveries**. The link is not read when you submit it; it is read when someone asks for the evaluation.

**Receipt.** The record of one delivery (`rcpt-N`). It starts `PENDING`. After validators evaluate it, it becomes `EVALUATED` and carries one result per criterion plus the SHA-256 of the exact bytes they read. If a newer delivery arrives while a receipt is still `PENDING`, the old one becomes `SUPERSEDED`.

**Result.** For each criterion: `MET`, `NOT_MET` or `UNVERIFIABLE`, a fixed reason code, and a short **literal quote** from the deliverable (8–300 characters) as evidence.

**Overall status.** Computed by a fixed rule from the per-criterion results, not chosen freely by the model:

1. any `UNVERIFIABLE` → `INCONCLUSIVE`
2. otherwise any `NOT_MET` → `NEEDS_REVISION`
3. otherwise all `MET` → `VERIFIED`

**Hashes.** The job stores a `termsHash` (over the title, description and criteria) and an `agreementHash` (terms plus both parties). The SDK and API recompute them from the data they read and report the result in `integrity`: `true` (matches), `false` (do not trust this data) or `null` (could not be checked, for example before a worker exists).

## Identity

An account is a `0x` address. The API returns addresses lower-case. The contract stores no usernames and no timestamps; **no dates are available**, and the API does not invent any.
