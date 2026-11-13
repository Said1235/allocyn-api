---
title: Authentication and wallets
group: Start
summary: Who signs what. No server wallet, no keys handled by Allocyn.
---
# Authentication and wallets

<div class="cards two">
<div class="card">

<span class="badge ok">Reading</span>

### Reads need nothing

The REST API has **no API keys and no login**. It exposes public contract data that anyone can read from the chain. It is rate limited per client address; see [Limits](limits.html).

</div>
<div class="card gold">

<span class="badge gold">Writing</span>

### Writes are signed by the participant

A write is a blockchain transaction, signed by the account that is acting: the client creating a job, the worker accepting and delivering, either party asking for an evaluation.

</div>
</div>

> **No Allocyn component ever signs on behalf of someone else, and none asks for, stores or logs a private key or seed phrase.**

## Two ways to sign

There are exactly two supported ways to sign with `@allocyn/sdk`.

<div class="cards">
<div class="card">

<span class="badge gold">For people</span>

### Browser wallet (EIP-1193)

The person signs in their own wallet (MetaMask, for example). The wallet shows its own confirmation.

```ts
const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
const allocyn = await createAllocynClient({ signer: { type: "provider", provider: window.ethereum, address } });
```

Before each write the SDK asks the wallet which chain it is on and throws `WRONG_NETWORK` if it is not Studionet. It does **not** switch networks for you. To add or switch to Studionet use `wallet_addEthereumChain` / `wallet_switchEthereumChain` with the values from `GET /v1/meta` (`chainId` `61999`, hex `0xf22f`).

</div>
<div class="card">

<span class="badge">For your own service</span>

### An account your own backend owns

A service can act as **itself**: one fixed identity of the integrator, for example a bot that is the *client* of its own jobs. You create the account object with genlayer-js and pass it in.

```ts
import { createAccount } from "genlayer-js";
const account = createAccount(process.env.MY_SERVICE_KEY as `0x${string}`); // your secret manager, your risk
const allocyn = await createAllocynClient({ signer: { type: "account", account } });
```

This is for an identity **you** own. Do not build a service that holds keys for your users and signs for them: that is custody, and Allocyn does not provide or support it. The Allocyn API process itself is always read-only.

</div>
</div>

## Relaying signed transactions

<div class="cards">
<div class="card warn">

<span class="badge warn">Not implemented</span>

A relay would let a user sign in a wallet and have a server broadcast the signed transaction. It is only possible if GenLayerJS supports submitting a pre-signed transaction in the way the contract calls require, and that has not been verified, so no relay endpoint exists. Adding one would be documented separately with its own threat model.

</div>
</div>

## Who may do what

| Action | Allowed account |
|---|---|
| `createJob` | any account (becomes the client) |
| `acceptJob` | any account except the client, while the job is `OPEN` |
| `submitDelivery` | the job's worker, while deliveries remain |
| `evaluateDelivery` | the job's client or its worker |
