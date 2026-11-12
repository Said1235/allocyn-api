---
title: Security and privacy
group: Reference
summary: What is public, what the API stores, and how to run it safely.
---
# Security and privacy

## Everything on the contract is public

Job titles, descriptions, criteria, addresses, delivery URLs and verdicts are stored on a public network and readable by anyone. **Do not put secrets, personal data, or private links in a job.** The deliverable must be a **publicly reachable** URL, because validators fetch it from the open internet; a link that needs a login cannot be verified.

## What the API stores

No jobs, no accounts and no sessions. The only thing it keeps is request counters for rate limiting, in memory by default, or in an optional counter store you configure (see [Limits](limits.html)); a store only receives a hash of the client address and a count. For a short time it also keeps in memory the answers that can never change again, such as an evaluated receipt read with `?consistency=final`, so it does not read them twice. It writes a log line per request (method, path, status, duration, request id). It does not log request bodies, and there are none: it is read-only.

## Keys

- The API has **no wallet**. It starts only if no `PRIVATE_KEY`, `SEED`, `MNEMONIC`, `WALLET_KEY` or `SECRET_KEY` variable is set.
- The SDK never asks for, stores or logs a seed phrase or private key. A `provider` signer hands signing to the person's wallet. An `account` signer is an object *you* created.
- No setting of the web app or this API is a secret; do not put secrets in `NEXT_PUBLIC_*` variables.

## Untrusted text

- Titles, descriptions, criteria, URLs and `evidenceExcerpt` come from arbitrary users. Treat them as **plain text**. Do not render them as HTML or Markdown, and do not follow URLs from them automatically.
- Delivered pages are read by an LLM. A hostile page can try to steer it. The contract narrows what a verdict can say, and the validators have to agree, but this is **not a guarantee against prompt injection**.
- If an AI agent reads job text through this API, treat that text as data, never as instructions to the agent.

## Running the API in production

1. Set `NODE_ENV=production` and list exact `CORS_ORIGINS` (`*` is refused).
2. Put it behind HTTPS and a reverse proxy; set `TRUST_PROXY=true` only if that proxy is yours.
3. If you run more than one instance, configure the shared counter store or add a gateway-level rate limit.
4. Send the logs somewhere; they carry the `X-Request-Id` returned to clients.

## Reporting a problem

Do not send keys or seed phrases to anyone, including the maintainers. If you find a flaw, describe it without secrets and the transaction hash if one is involved.
