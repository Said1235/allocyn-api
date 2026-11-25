#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { run } from "./run.ts";

run(process.argv.slice(2), { fetch, out: (s) => console.log(s), err: (s) => console.error(s), env: process.env,
  readFile: async (p) => readFileSync(p === "-" ? 0 : p, "utf8"),
  // The one thing that needs the SDK package (and its chain client): loaded only when --chain is used.
  chainReader: async (network, final) => {
    const name = "@allocyn/sdk";
    const sdk = await import(name);
    return sdk.createAllocynClient({ network, readConsistency: final ? "final" : "latest" });
  },
})
  .then((code) => { process.exitCode = code; });
