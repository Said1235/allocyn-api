import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createAllocynClient } from "@allocyn/sdk";
import { SimContract } from "../../sdk/src/core/contract/sim.ts";
import { createApiServer } from "../src/server.ts";
import { loadConfig, ConfigError } from "../src/config.ts";
import { buildTools, createMcpHandler } from "../src/mcp.ts";
import { makeCtx } from "../src/context.ts";

const ALICE = "0x" + "a1".repeat(20), BOB = "0x" + "b2".repeat(20), CAROL = "0x" + "c3".repeat(20);
const sim = new SimContract();
let server: http.Server; let base: string; let clients: { latest: any; final: any };

before(async () => {
  await sim.directWrite(ALICE, "create_job", ["Logo files", "The studio logo as vector files.", ["Delivered as SVG", "Includes a usage guide"]]); // job-1 → VERIFIED
  await sim.directWrite(BOB, "accept_job", ["job-1"]);
  await sim.directWrite(BOB, "submit_delivery", ["job-1", "https://example.com/logo-package"]);
  await sim.directWrite(BOB, "evaluate_delivery", ["rcpt-1"]);
  await sim.directWrite(ALICE, "create_job", ["Open job", "Nobody accepted it.", ["First check", "Second check"]]); // job-2 OPEN
  await sim.directWrite(ALICE, "create_job", ["Waiting job", "A delivery is waiting.", ["First check", "Second check"]]); // job-3
  await sim.directWrite(BOB, "accept_job", ["job-3"]);
  await sim.directWrite(BOB, "submit_delivery", ["job-3", "https://example.com/draft"]); // rcpt-2 PENDING
  const mk = (c: "latest" | "final") => createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
  clients = { latest: await mk("latest"), final: await mk("final") };
  server = createApiServer({ config: loadConfig({ NODE_ENV: "test", RATE_LIMIT_MAX: "1000", APP_URL: "https://app.example.org/" }), clients });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() as any }; };

test("accept: allowed on an OPEN job, with the contract call, the SDK call and the app link; nothing is sent", async () => {
  const { status, body } = await get("/v1/jobs/job-2/prepare?action=accept");
  assert.equal(status, 200);
  const d = body.data;
  assert.equal(d.canProceed, true); assert.deepEqual(d.reasons, []);
  assert.deepEqual(d.intent, { contractMethod: "accept_job", args: ["job-2"] });
  assert.equal(d.sdk, 'await allocyn.acceptJob("job-2")');
  assert.equal(d.appLink, "https://app.example.org/agreements/job-2");
  assert.equal(d.sent, false);
  assert.match(d.whoMaySign, /except the client/);
  assert.match(d.notes.join(" "), /builds no transaction and sends nothing/);
});

test("accept: refused with reasons when the job is not OPEN, or when the actor is the client", async () => {
  const taken = (await get("/v1/jobs/job-1/prepare?action=accept")).body.data;
  assert.equal(taken.canProceed, false); assert.equal(taken.intent, null); assert.equal(taken.appLink, null); assert.equal(taken.sdk, null);
  assert.match(taken.reasons.join(" "), /VERIFIED/);
  const self = (await get(`/v1/jobs/job-2/prepare?action=accept&actor=${ALICE}`)).body.data;
  assert.equal(self.canProceed, false); assert.match(self.reasons.join(" "), /client cannot accept their own/);
  const other = (await get(`/v1/jobs/job-2/prepare?action=accept&actor=${CAROL}`)).body.data;
  assert.equal(other.canProceed, true);
});

test("submit: needs the worker, a state that allows deliveries and a url; the app link points at the deliver page", async () => {
  const ok = (await get(`/v1/jobs/job-3/prepare?action=submit&deliveryUrl=${encodeURIComponent("https://example.org/v2")}&actor=${BOB}`)).body.data;
  assert.equal(ok.canProceed, true);
  assert.deepEqual(ok.intent, { contractMethod: "submit_delivery", args: ["job-3", "https://example.org/v2"] });
  assert.equal(ok.appLink, "https://app.example.org/agreements/job-3/deliver");
  assert.match(ok.notes.join(" "), /does not pre-fill/);
  const wrong = (await get(`/v1/jobs/job-3/prepare?action=submit&deliveryUrl=${encodeURIComponent("https://example.org/v2")}&actor=${CAROL}`)).body.data;
  assert.equal(wrong.canProceed, false); assert.match(wrong.reasons.join(" "), /Only the job's worker/);
  const noWorker = (await get(`/v1/jobs/job-2/prepare?action=submit&deliveryUrl=${encodeURIComponent("https://example.org/v2")}`)).body.data;
  assert.equal(noWorker.canProceed, false); assert.match(noWorker.reasons.join(" "), /Nobody has accepted/);
  const done = (await get(`/v1/jobs/job-1/prepare?action=submit&deliveryUrl=${encodeURIComponent("https://example.org/v2")}`)).body.data;
  assert.equal(done.canProceed, false);
});

test("evaluate: needs an IN_PROGRESS job with a pending receipt; the call names that receipt", async () => {
  const ok = (await get(`/v1/jobs/job-3/prepare?action=evaluate&actor=${ALICE}`)).body.data;
  assert.equal(ok.canProceed, true);
  assert.deepEqual(ok.intent, { contractMethod: "evaluate_delivery", args: ["rcpt-2"] });
  assert.equal(ok.sdk, 'await allocyn.evaluateDelivery("job-3", 1)');
  const stranger = (await get(`/v1/jobs/job-3/prepare?action=evaluate&actor=${CAROL}`)).body.data;
  assert.equal(stranger.canProceed, false);
  const nothing = (await get("/v1/jobs/job-2/prepare?action=evaluate")).body.data;
  assert.equal(nothing.canProceed, false); assert.match(nothing.reasons.join(" "), /No delivery is waiting/);
  const finalJob = (await get("/v1/jobs/job-1/prepare?action=evaluate")).body.data;
  assert.equal(finalJob.canProceed, false);
});

test("invalid input is a 400 that names the field", async () => {
  for (const [path, field] of [["/v1/jobs/job-2/prepare", "action"], ["/v1/jobs/job-2/prepare?action=sign", "action"], ["/v1/jobs/job-2/prepare?action=submit", "deliveryUrl"], ["/v1/jobs/job-2/prepare?action=accept&deliveryUrl=https://x.org/a", "deliveryUrl"], ["/v1/jobs/job-2/prepare?action=submit&deliveryUrl=http://x.org/a", "deliveryUrl"], ["/v1/jobs/job-2/prepare?action=accept&actor=nope", "actor"]] as const) {
    const r = await get(path); assert.equal(r.status, 400, path); assert.equal(r.body.error.field, field, path);
  }
  assert.equal((await get("/v1/jobs/job-99/prepare?action=accept")).status, 404);
});

test("without APP_URL there is no link and the answer says so", async () => {
  const mk = (c: "latest" | "final") => createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
  const noApp = createApiServer({ config: loadConfig({ NODE_ENV: "test", RATE_LIMIT_MAX: "1000" }), clients: { latest: await mk("latest"), final: await mk("final") } });
  await new Promise<void>((r) => noApp.listen(0, "127.0.0.1", r));
  const res = await fetch(`http://127.0.0.1:${(noApp.address() as AddressInfo).port}/v1/jobs/job-2/prepare?action=accept`);
  const d = (await res.json() as any).data; noApp.close();
  assert.equal(d.appLink, null); assert.match(d.notes.join(" "), /no APP_URL configured/);
});

test("APP_URL must be https (localhost is fine outside production)", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "test", APP_URL: "http://evil.example" }), ConfigError);
  assert.throws(() => loadConfig({ NODE_ENV: "test", APP_URL: "nope" }), ConfigError);
  assert.equal(loadConfig({ NODE_ENV: "test", APP_URL: "http://localhost:3000/" }).appUrl, "http://localhost:3000");
  assert.equal(loadConfig({ NODE_ENV: "test" }).appUrl, null);
});

test("MCP: prepare_action is a read-only tool with a required action, and it never writes", async () => {
  const tool = buildTools().find((t) => t.name === "prepare_action")!;
  assert.ok(tool); assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual((tool.inputSchema as any).required.sort(), ["action", "jobId"]);
  const mcp = createMcpHandler({ makeCtx: (p, q) => makeCtx({ clients, defaultConsistency: "latest", now: Date.now, timeoutMs: 5000, appUrl: "https://app.example.org" }, p, q), defaultConsistency: "latest", timeoutMs: 5000 });
  const before = (await clients.latest.getJob("job-2")).status;
  const reply: any = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "prepare_action", arguments: { jobId: "job-2", action: "accept" } } });
  assert.equal(reply.result.isError, false);
  assert.equal(reply.result.structuredContent.data.canProceed, true);
  assert.equal((await clients.latest.getJob("job-2")).status, before, "the job did not change");
  const missing: any = await mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "prepare_action", arguments: { jobId: "job-2" } } });
  assert.equal(missing.result.isError, true);
});
