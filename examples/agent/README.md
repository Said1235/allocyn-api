# Reference agent

A small agent that shows the calls an AI agent makes against the Allocyn API, over the Model Context Protocol. It has no dependencies (plain `fetch`) and **no language model inside**: it is the skeleton, not a decision maker.

```bash
node examples/agent/agent.mjs --base https://allocynapivercel.vercel.app --q logo --actor 0xYourAddress --watch
```

What it does:

1. Lists the tools the server offers.
2. Finds open jobs (`list_jobs`, with `q` to search, `source=auto` to use the database copy when there is one).
3. Reads each job (`get_job`) and prints its criteria.
4. Asks what accepting it would involve (`prepare_action`). With `--actor` it also says whether that address may accept.
5. With `--watch`, waits for new events (`list_events` with a cursor and `wait`).

What it never does: sign, send a transaction, or hold a key. `prepare_action` only reads, and `sent` is always `false`. The person signs in their own wallet, with [`@allocyn/sdk`](../../docs/content/06-sdk-reference.md) or the app.

It only calls read-only tools and refuses any other name. Use it as the starting point for your own agent: put your model where the printing is, and keep the last step with a human.

Tested against the simulated contract and a stand-in for the database. Run against the deployed API, it works as far as that API has data: the contract had no jobs yet when this was written, so a real accept flow has **not** been seen.
