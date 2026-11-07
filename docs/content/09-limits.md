---
title: Limits
group: Reference
summary: The contract's input limits, the SDK's soft limits, and the API's rate limits.
---
# Limits

## Contract limits

These are enforced by the contract, which reports them itself through its `get_limits()` view. `GET /v1/limits` and `client.getLimits()` read that view live (cached for 60 seconds).

| Limit | Value |
|---|---|
| Criteria per job | 1 to 20 (distinct, case-insensitive) |
| Title | up to 200 characters |
| Description | up to 5,000 characters |
| One criterion | up to 1,000 characters |
| Delivery URL | up to 2,048 characters, public `https://` only |
| Deliveries per job | 2 |
| Deliverable size read by validators | 250,000 bytes (UTF-8 text, HTTP 200) |
| Evidence excerpt per criterion | 8 to 300 characters |

Lengths are counted in Unicode code points after trimming, as the contract counts them. These are the contract author's application-level choices, **not GenLayer protocol limits**.

**Live versus pinned.** The SDK and API also carry a pinned copy of these values, taken from the audited contract source (`contract/smart_agreement.py`, SHA-256 `58fd3877…5f57`). `/v1/limits` returns both, plus `matchesPinned`. If the contract ever reports different numbers, `matchesPinned` becomes `false`, reads keep working, and the SDK **refuses writes** until it is updated, instead of validating against stale numbers. See [Networks](networks.html#updating-the-contract).

**Larger limits are unmeasured on a network.** The contract's author states these ceilings were tested for logic, not on a live network: the validators' model context window, calldata acceptance, gas and the real disagreement rate with many criteria were not measured. Every criterion must match exactly on every validator, so more criteria means more chances of a disagreement. Prefer short, objective, independently checkable criteria.

## Delivery URL rules

`https://`, a real domain name (no IP address, no `localhost`, no reserved suffix such as `.local`, `.internal` or `.test`), no username or password, no fragment (`#…`), no custom port, no spaces. The SDK checks the same rules as the contract before sending.

## Soft limits

`softLimits` lets a client be **stricter** than the contract. It can never be looser; asking for more than the contract allows throws `CONFIGURATION`. The SDK's default is the contract's own limit for every text length, but **5 criteria** rather than 20, following the contract author's advice to start low and raise it as you measure real validators. To use more: `createAllocynClient({ softLimits: { maxCriteria: 20 } })`.

## API rate limits

Per client address, fixed window, in memory: by default **60 requests per 60 seconds** (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`). Over the limit you get `429` with `Retry-After`. The counters live in one process; if you run several instances, also limit at your gateway. Behind a reverse proxy set `TRUST_PROXY=true` so the real client address is used.

A request that waits longer than `REQUEST_TIMEOUT_MS` (25 s) for the network returns `504`.
