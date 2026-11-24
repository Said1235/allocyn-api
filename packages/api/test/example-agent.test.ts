import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createAllocynClient } from "@allocyn/sdk";
import { SimContract } from "../../sdk/src/core/contract/sim.ts";
import { createApiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { createCopyReader } from "../src/copy.ts";
import { startFakePostgrest, type FakeDb } from "./fixtures/fake-postgrest.ts";
// @ts-expect-error plain JavaScript, no types
import { run, createMcpClient } from "../../../examples/agent/agent.mjs";

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
const KEY = "sb_publishable_test_key";
let db: FakeDb; let srv: http.Server; let base: string; let seenTools: string[] = [];

before(async () => {
  db = await startFakePostgrest(KEY); db.publicRole = true;
  db.state.last_job_number = 1; db.state.last_run_at = "2026-11-23T10:30:00+00:00";
  db.jobs.set("job-1", { id: "job-1", title: "Logo files", description: "Vector logo", status: "OPEN", client: A, worker: null, delivery_count: 0 });
  db.events.push({ id: 1, created_at: "2026-11-23T10:00:00+00:00", job_id: "job-1", type: "job_created", from_status: null, to_status: "OPEN", client: A, worker: null, data: {} });
  const sim = new SimContract();
  await sim.directWrite(A, "create_job", ["Logo files", "The studio logo as vector files.", ["Delivered as SVG", "Includes a usage guide"]]);
  const mk = (c: "latest" | "final") => createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
  srv = createApiServer({ config: loadConfig({ NODE_ENV: "test", RATE_LIMIT_MAX: "1000", REQUEST_TIMEOUT_MS: "6000", APP_URL: "https://app.example" }), clients: { latest: await mk("latest"), final: await mk("final") }, copy: createCopyReader({ url: db.url, key: KEY }), pollMs: 50 });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(async () => { srv.close(); await db.close(); });

// Records every tool the agent calls, so the test can prove it stays read-only.
const spy: typeof fetch = async (input, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  if (body?.method === "tools/call") seenTools.push(body.params.name);
  return fetch(input, init);
};

test("the agent finds an open job, reads it and says what accepting would involve, and sends nothing", async () => {
  seenTools = []; const lines: string[] = [];
  const report = await run({ base, actor: B, log: (l: string) => lines.push(l), fetch: spy });
  assert.equal(report.found.length, 1);
  const f = report.found[0];
  assert.equal(f.id, "job-1"); assert.equal(f.canProceed, true); assert.equal(f.sent, false);
  assert.match(f.sdk, /acceptJob/); assert.equal(f.appLink, "https://app.example/agreements/job-1");
  const text = lines.join("\n");
  assert.match(text, /Found 1 open job/); assert.match(text, /Delivered as SVG/); assert.match(text, /Nothing was sent/);
  assert.ok(seenTools.every((t) => ["list_jobs", "get_job", "prepare_action", "list_events", "get_address_record"].includes(t)), seenTools.join(","));
});

test("the actor who is the client is told that accepting is not possible", async () => {
  const report = await run({ base, actor: A, log: () => {}, fetch: spy });
  assert.equal(report.found[0].canProceed, false);
  assert.ok(report.found[0].reasons.length >= 1);
});

test("with --watch it follows the event feed from the newest event", async () => {
  const lines: string[] = [];
  setTimeout(() => db.events.push({ id: 2, created_at: "2026-11-23T10:05:00+00:00", job_id: "job-1", type: "job_accepted", from_status: null, to_status: null, client: A, worker: B, data: {} }), 300);
  const report = await run({ base, watch: true, watchSeconds: 4, log: (l: string) => lines.push(l), fetch: spy });
  assert.deepEqual(report.events.map((e: any) => e.id), [2]);
  assert.match(lines.join("\n"), /job_accepted job-1/);
});

test("it refuses to call any tool that is not read-only", async () => {
  const mcp = createMcpClient(base);
  await assert.rejects(() => mcp.call("send_transaction", {}), /only uses read-only tools/);
});
