---
title: Quickstart
group: Start
summary: Read a job in one request, then send your first write with the SDK.
---
# Quickstart

## 1. Run the API

You need Node.js 22.6 or newer.

```bash
cd allocyn
npm install
cp .env.example .env      # defaults point at Studionet
npm start                 # http://localhost:8787
```

The API refuses to start if it finds a `PRIVATE_KEY`, `SEED` or `MNEMONIC` variable. It never needs one.

## 2. Read from the contract

```bash
curl -s http://localhost:8787/v1/meta
curl -s http://localhost:8787/v1/jobs/job-1
curl -s http://localhost:8787/v1/jobs/job-1/receipts
```

Every response has the same envelope:

```json
{ "success": true, "data": { "...": "..." } }
```

```json
{ "success": false, "error": { "code": "JOB_NOT_FOUND", "message": "job-99 does not exist on the contract.", "retryable": false } }
```

Ids come from the contract (`job-1`, `job-2`, ...). Never invent one: ask for a job you know exists, or read the id out of a write result.

## 3. Write with the SDK

Writes are signed by **your** wallet, so they go through the SDK, not the API.

```ts
import { createAllocynClient } from "@allocyn/sdk";

const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
const allocyn = await createAllocynClient({
  network: "studionet",
  signer: { type: "provider", provider: window.ethereum, address },
});

const { txHash, data: job } = await allocyn.createJob({
  title: "Landing page copy",
  description: "English copy for the pricing page.",
  criteria: ["Includes three plan names", "Mentions a 14-day trial"],
}, { onProgress: (p) => console.log(p.phase) });

console.log(job.id, txHash);   // the id was read back from the contract
```

The wallet must already be on Studionet (chain `61999`). If it is not, the SDK throws `WRONG_NETWORK` before anything is sent.

## 4. Next

- Understand the objects: [Core concepts](core-concepts.html)
- Decide who signs: [Authentication and wallets](auth-wallets.html)
- Every endpoint: [REST reference](rest-reference.html)
