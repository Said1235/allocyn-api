---
title: FAQ
group: Guides
summary: Short answers to the questions people ask first.
---
# FAQ

**Why can't I create a job with `POST /v1/jobs`?**
Because that would require the server to sign for you. Allocyn's rule is that each participant signs with their own wallet, so writes live in the SDK. The API is a read surface.

**Where do the limits come from?**
From the contract itself: `/v1/limits` calls its `get_limits()` view. The response also includes the copy this version was built for, and says whether they match.

**Why does the SDK allow only 5 criteria by default if the contract allows 20?**
Every criterion has to match exactly on every validator, so more criteria means more chances of a disagreement, and the larger limits have not been measured on a live network. The contract's author recommends starting lower. Raise it with `softLimits: { maxCriteria: 20 }`.

**My write threw `TIMEOUT`. Can I retry?**
Not yet. The transaction may still complete. Look it up by `txHash` first. Resubmitting a `createJob` makes a second job.

**`decided` but the job did not change. What happened?**
A transaction can be accepted without the intended change being recorded. The SDK detects that and throws `TRANSACTION_NOT_CONFIRMED`; read the job to see the real state.

**Why did evaluation fail with `[EXTERNAL]`?**
The validators could not fetch the delivered link, or it was not a normal HTTP 200 page, or it was empty, too large (over 250,000 bytes) or not UTF-8. Fix the link and request the evaluation again.

**Can the link be private, or behind a login?**
No. Validators fetch it from the public internet.

**Is a `VERIFIED` result proof the work is good?**
No. It means validators judged the delivered text to satisfy the written criteria. It is not a measure of quality, a payment trigger or a legal finding.

**Are the results the same every time?**
Not guaranteed. Validators use an LLM. Consensus is how GenLayer settles on one result, but a re-run may differ.

**Does the API cache or store anything?**
No data is stored. Contract reads are not cached; `meta` and `limits` may be cached for 60 seconds.

**Can I use another network?**
Only Studionet is enabled.

**Does it work with other GenLayer contracts?**
No. It targets the Allocyn contract (Smart Agreement). A contract with different methods needs its own SDK; pointing this one at it makes `/v1/limits` fail and writes refuse.

**Is there a Python SDK?**
No. The SDK is TypeScript/JavaScript. Any language can use the REST API for reads.

**Is the SDK on npm?**
Not yet. I could not check whether the name is free from the sandbox where this was built.
