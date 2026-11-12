import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createAllocynClient } from "@allocyn/sdk";
import { SimContract } from "../../sdk/src/core/contract/sim.ts";
import { createApiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { jobVersion } from "../src/wait.ts";

const ALICE = "0x" + "a1".repeat(20);
const BOB = "0x" + "b2".repeat(20);
const sim = new SimContract();
let server: http.Server; let base: string;

before(async () => {
  await sim.directWrite(ALICE, "create_job", ["Logo files", "The studio logo as vector files.", ["Delivered as SVG", "Includes a usage guide"]]);
  const cfg = loadConfig({ NODE_ENV: "test", RATE_LIMIT_MAX: "1000", REQUEST_TIMEOUT_MS: "3000" });
  const mk = (c: "latest" | "final") => createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
  server = createApiServer({ config: cfg, clients: { latest: await mk("latest"), final: await mk("final") }, waitPollMs: 40 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
const wait = async (qs = "", id = "job-1") => { const t = Date.now(); const r = await fetch(`${base}/v1/jobs/${id}/wait${qs}`); return { status: r.status, body: await r.json(), ms: Date.now() - t }; };

test("without `since` it answers at once with the job and its version", async () => {
  const { status, body, ms } = await wait();
  assert.equal(status, 200); assert.equal(body.data.changed, false); assert.match(body.data.version, /^[0-9a-f]{16}$/);
  assert.equal(body.data.job.status, "OPEN"); assert.ok(ms < 800);
});

test("with an unchanged `since` it waits out the timeout and says nothing changed", async () => {
  const v = (await wait()).body.data.version;
  const { body, ms } = await wait(`?since=${v}&timeout=1`);
  assert.equal(body.data.changed, false); assert.equal(body.data.version, v);
  assert.ok(ms >= 400 && ms < 2500, `waited ${ms} ms`);   // capped at 3000 - 2500 = 0.5 s by the request timeout
});

test("it answers as soon as the job changes, at each step of the lifecycle", async () => {
  let v = (await wait()).body.data.version;
  const steps: Array<[string, string, unknown[], string]> = [
    [BOB, "accept_job", ["job-1"], "IN_PROGRESS"],
    [BOB, "submit_delivery", ["job-1", "https://example.com/logo-package"], "IN_PROGRESS"],
    [BOB, "evaluate_delivery", ["rcpt-1"], "VERIFIED"],
  ];
  for (const [who, method, args, status] of steps) {
    const pending = wait(`?since=${v}&timeout=25`);
    await new Promise((r) => setTimeout(r, 120));
    await sim.directWrite(who, method, args);
    const { body, ms } = await pending;
    assert.equal(body.data.changed, true, method); assert.equal(body.data.job.status, status, method);
    assert.notEqual(body.data.version, v, method); assert.ok(ms < 1500, `${method} answered in ${ms} ms`);
    v = body.data.version;
  }
  assert.equal(body_deliveries(await wait()), 1);
});
const body_deliveries = (r: { body: any }) => r.body.data.job.deliveryCount;

test("the version only depends on what can change", () => {
  const base = { status: "OPEN", deliveryCount: 0, worker: null, receiptIds: [] as string[] } as const;
  assert.equal(jobVersion(base), jobVersion({ ...base }));
  assert.notEqual(jobVersion(base), jobVersion({ ...base, status: "IN_PROGRESS" }));
  assert.notEqual(jobVersion(base), jobVersion({ ...base, receiptIds: ["rcpt-1"] }));
});

test("errors: unknown job is 404, bad `since` or `timeout` is 400, other parameters are refused", async () => {
  assert.equal((await wait("", "job-99")).status, 404);
  for (const qs of ["?since=xyz", "?timeout=0", "?timeout=26", "?timeout=x", "?foo=1"]) assert.equal((await wait(qs)).status, 400, qs);
});

test("MCP: wait_for_job is a read-only tool that returns the same shape", async () => {
  const r = (await (await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait_for_job", arguments: { jobId: "job-1" } } }) })).json()).result;
  assert.equal(r.isError, false); assert.equal(r.structuredContent.data.job.id, "job-1");
  const bad = (await (await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait_for_job", arguments: { jobId: "job-1", timeout: "5" } } }) })).json()).result;
  assert.equal(bad.isError, true);
});
