import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createAllocynClient, CONTRACT_PROFILE } from "@allocyn/sdk";
import { createApiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { buildOpenApi } from "../src/openapi.ts";
import { validate } from "./schema.ts";

/**
 * Live checks against the real GenLayer Studionet and the deployed contract. They are skipped unless
 * ALLOCYN_LIVE=1, because they need the network and the genlayer-js package, and they only READ:
 * no key is used and nothing is sent. Run them with `npm run test:live`.
 */
const LIVE = process.env.ALLOCYN_LIVE === "1";
const opts = { skip: LIVE ? false : "set ALLOCYN_LIVE=1 to run the live Studionet checks", timeout: 120_000 };

async function boot() {
  const config = loadConfig({ NODE_ENV: "test", REQUEST_TIMEOUT_MS: "60000" });
  const base = { network: config.network, ...(config.contractAddress ? { contractAddress: config.contractAddress } : {}) };
  const [latest, final] = await Promise.all([
    createAllocynClient({ ...base, readConsistency: "latest" }),
    createAllocynClient({ ...base, readConsistency: "final" }),
  ]);
  const s = createApiServer({ config, clients: { latest, final } });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, latest, spec: buildOpenApi(config) };
}

test("live: the deployed contract still has the limits this API was built for", opts, async () => {
  const { s, url, latest } = await boot();
  try {
    const rep = await latest.getLimits();
    assert.equal(rep.matchesPinned, true, `the contract's limits changed: ${rep.differences.join("; ")}`);
    const body = await (await fetch(url + "/v1/limits")).json();
    assert.equal(body.success, true);
    assert.equal(body.data.contractSourceSha256, CONTRACT_PROFILE.sourceSha256);
  } finally { s.close(); }
});

test("live: deep health reaches the network; an unknown job is a clean 404; a known job passes its integrity checks", opts, async () => {
  const { s, url, spec } = await boot();
  try {
    const h = await fetch(url + "/v1/health?deep=true");
    assert.equal(h.status, 200, "the network answers");
    const missing = await fetch(url + "/v1/jobs/job-999999");
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "JOB_NOT_FOUND");
    const j = await fetch(url + "/v1/jobs/job-1");
    if (j.status === 200) {
      const body = await j.json();
      assert.deepEqual(validate(spec.paths["/v1/jobs/{jobId}"].get.responses["200"].content["application/json"].schema, body, spec), []);
      assert.notEqual(body.data.integrity.agreementHashMatches, false, "the returned terms recompute to the contract's hashes");
      const proof = await (await fetch(url + "/v1/jobs/job-1/proof")).json();
      assert.equal(proof.success, true);
      const badge = await fetch(url + "/v1/jobs/job-1/badge.svg");
      assert.equal(badge.status, 200);
    } else assert.equal(j.status, 404, "job-1 is either there or cleanly missing");
  } finally { s.close(); }
});

test("live: the MCP endpoint reads the same limits as REST", opts, async () => {
  const { s, url } = await boot();
  try {
    const rpc = await (await fetch(url + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_limits", arguments: {} } }) })).json();
    const rest = await (await fetch(url + "/v1/limits")).json();
    assert.equal(rpc.result.isError, false);
    assert.deepEqual(rpc.result.structuredContent.data.contract, rest.data.contract);
  } finally { s.close(); }
});
