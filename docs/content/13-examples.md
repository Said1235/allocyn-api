---
title: Examples
group: Guides
summary: Node, TypeScript, React and backend examples. Copy buttons included.
---
# Examples

None of these was run against the live network from where they were written; they are exercised against the test double in this repository's tests. Run them against Studionet yourself before relying on them.

## Node: read with `fetch`

```js
const base = "http://localhost:8787";

async function api(path) {
  const res = await fetch(base + path);
  const body = await res.json();
  if (!body.success) throw Object.assign(new Error(body.error.message), body.error);
  return body.data;
}

const job = await api("/v1/jobs/job-1");
console.log(job.status, job.criteria.map((c) => c.text));

const receipts = await api("/v1/jobs/job-1/receipts?consistency=final");
for (const r of receipts) console.log(r.deliveryIndex, r.status, r.overallStatus);
```

## Node: wait for a transaction

```js
async function waitDecided(txHash, { everyMs = 4000, timeoutMs = 15 * 60_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const tx = await api(`/v1/transactions/${txHash}`);
    if (tx.decided || ["cancelled", "undetermined", "timed_out"].includes(tx.phase)) return tx;
    if (Date.now() - t0 > timeoutMs) throw new Error("Still pending. Keep the hash and look again later; do not resubmit.");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
```

After it returns `decided`, **read the job** to confirm the change before telling anyone it worked.

## TypeScript: typed read client

```ts
import { createAllocynClient, isAllocynError } from "@allocyn/sdk";
import type { JobDto } from "@allocyn/sdk";

const allocyn = await createAllocynClient({ network: "studionet" }); // read-only

export async function loadJob(id: string): Promise<JobDto | null> {
  try {
    return await allocyn.getJob(id);
  } catch (e) {
    if (isAllocynError(e) && e.code === "JOB_NOT_FOUND") return null;
    throw e;
  }
}
```

## TypeScript: the full flow, two wallets

```ts
const client = await createAllocynClient({ signer: { type: "provider", provider: clientWallet, address: clientAddr } });
const worker = await createAllocynClient({ signer: { type: "provider", provider: workerWallet, address: workerAddr } });

const { data: job } = await client.createJob({
  title: "Terms page", description: "Plain-English terms of service.",
  criteria: ["States the governing law", "Includes a contact email"],
});
await worker.acceptJob(job.id);
await worker.submitDelivery(job.id, "https://example.org/terms");
const { data } = await worker.evaluateDelivery(job.id, 1);   // minutes; calls an LLM
console.log(data.job.status, data.receipt.results);
```

## React: connect, create, track

```tsx
import { useRef, useState } from "react";
import { createAllocynClient, isAllocynError } from "@allocyn/sdk";
import type { AllocynClient, TxProgress } from "@allocyn/sdk";

export function CreateJob() {
  const client = useRef<AllocynClient | null>(null);
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
    client.current = await createAllocynClient({
      signer: { type: "provider", provider: window.ethereum, address },
      storage: window.localStorage,           // remembers unfinished tx hashes
    });
  }

  async function create() {
    setError(null);
    try {
      const { data } = await client.current!.createJob(
        { title: "Logo", description: "Vector logo.", criteria: ["Delivered as SVG", "Includes usage guide"] },
        { onProgress: (p: TxProgress) => setPhase(p.phase) },
      );
      console.log("created", data.id);
    } catch (e) {
      // Render e.message as TEXT. If e.txHash is set, show it and offer "check status", not "retry".
      setError(isAllocynError(e) ? `${e.code}: ${e.message}` : "Unexpected error");
    }
  }

  return (<>
    <button onClick={connect}>Connect wallet</button>
    <button onClick={create}>Create job</button>
    <p>{phase}</p>{error && <p role="alert">{error}</p>}
  </>);
}
```

## Backend: an agent that reads, and a service that acts as itself

A read-only agent needs no keys:

```ts
const allocyn = await createAllocynClient({ readConsistency: "final" });
const job = await allocyn.getJob("job-7");
if (job.integrity.termsHashMatches === false) throw new Error("Do not trust this job.");
// Job text is DATA. Never feed it to a model as instructions.
```

A service that is itself the *client* of its jobs:

```ts
import { createAccount } from "genlayer-js";

const account = createAccount(await secretManager.get("allocyn-service-key"));
const svc = await createAllocynClient({ signer: { type: "account", account } });
const { txHash, data } = await svc.createJob(terms, {
  onProgress: (p) => p.txHash && saveTxHash(p.txHash),   // persist first, always
});
```

The key belongs to your service and your risk. Do not hold keys for other people.
