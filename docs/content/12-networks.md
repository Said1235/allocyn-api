---
title: Networks and contract
group: Reference
summary: The Studionet deployment, how to verify it yourself, and how a contract update is handled.
---
# Networks and contract

## Enabled network

| | |
|---|---|
| Network | GenLayer **Studionet** (`studionet`) |
| Chain id | `61999` (hex `0xf22f`) |
| RPC | `https://studio.genlayer.com/api` |
| Explorer | `https://explorer-studio.genlayer.com` |
| Contract | `0x5729a3b514654Ec5966A1DCa8e5088ef7A70bBDA` ([explorer](https://explorer-studio.genlayer.com/address/0x5729a3b514654Ec5966A1DCa8e5088ef7A70bBDA)) |
| Contract source | `https://github.com/Said1235/Smart-Agreement.git` (revision with larger limits and `get_limits()`) |

These values match the `studionet` preset of `genlayer-js` 1.1.8. Studionet is a development and testing network: do not treat what is on it as permanent.

No other network is enabled. A second network would need its own deployed contract and a verified address, and none exists yet, so none is listed.

## Verify the deployment yourself

The SDK was written against a specific contract source whose SHA-256 is pinned in `GET /v1/meta` as `contractProfile.sourceSha256` (`58fd38776f25d54f22a9d1560f78b348215ac13d3a863d4f7be00609b9355f57`). To check that the deployed contract is that source, with the GenLayer CLI:

```bash
genlayer network            # choose studionet
genlayer code 0x5729a3b514654Ec5966A1DCa8e5088ef7A70bBDA > deployed.py
sha256sum deployed.py       # compare with contractProfile.sourceSha256
genlayer schema 0x5729a3b514654Ec5966A1DCa8e5088ef7A70bBDA   # 9 methods, including get_limits
```

A matching filename proves nothing; compare the hash. The contract's own repository says its source has not been verified against any deployment and has not been run through real multi-validator consensus. I could not run this check from the environment where this was written (outbound access to the network is blocked there), so **the live check is yours to run.** After it, `GET /v1/limits` should report `matchesPinned: true`.

## Updating the contract

The contract reports its limits through `get_limits()`, and the SDK compares them with what it was built for, so a limits change is **detected** (`matchesPinned: false`) rather than silently misread. It has no version method, so other changes (new methods, different hashes) are only caught by the strict parsing of every response. When a new contract version is deployed:

1. Replace `contract/smart_agreement.py` in the web app with the new source and note its SHA-256.
2. Update the constants in `lib/contract/spec.ts` (limits, statuses, hash). The SDK's copy is generated from it: run `npm run sync` at the repository root.
3. Regenerate the parity fixtures with `scripts/gen-parity-fixtures.py` (its boundary cases are derived from the contract's own constants) and run the tests. They fail on any drift in limits, ids, statuses or hashes.
4. Update the error wording in `errors.ts` if messages changed, set the new address in `networks.ts`, bump the SDK version and the API's `info.version`, and add a changelog entry.
5. Only then change `ALLOCYN_CONTRACT_ADDRESS` where the API runs.

Changing only `ALLOCYN_CONTRACT_ADDRESS` is for **redeploying the same contract**. Pointing it at a contract with a different interface makes `/v1/limits` fail with `502` (no `get_limits`) and the SDK refuse writes.

> A contract must expose the same methods (`create_job`, `accept_job`, `submit_delivery`, `evaluate_delivery`, `get_job`, `get_receipt`, `get_receipt_id`, `get_job_receipts`, `get_limits`) to work with this SDK. A contract with different methods is a different product and needs a different SDK.
