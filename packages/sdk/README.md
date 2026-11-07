# @allocyn/sdk

Typed client for the Allocyn contract (Smart Agreement) on GenLayer Studionet.

```ts
import { createAllocynClient } from "@allocyn/sdk";

const reader = await createAllocynClient();                   // read-only
const job = await reader.getJob("job-1");
const limits = await reader.getLimits();                       // live get_limits() + pinned copy

const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
const allocyn = await createAllocynClient({ signer: { type: "provider", provider: window.ethereum, address } });
const { txHash, data } = await allocyn.createJob({ title, description, criteria });
```

Every write validates locally, checks the contract's limits, sends **one** transaction, waits for consensus, then re-reads the contract. It never resubmits and never invents an id. Errors are `AllocynError` with `code`, `txHash`, `retryable`, `field`.

`genlayer-js@^1.1.8` is an optional peer dependency. Full reference: the docs site (`/docs/sdk-reference.html`).

`src/core/` is generated from the web app by `scripts/sync-core.mjs`. Do not edit it here.
