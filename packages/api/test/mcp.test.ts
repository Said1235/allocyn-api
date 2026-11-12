import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createAllocynClient } from "@allocyn/sdk";
import { SimContract } from "../../sdk/src/core/contract/sim.ts";
import { createApiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { ROUTES } from "../src/routes.ts";
import { buildTools, createMcpHandler, MCP_PROTOCOLS } from "../src/mcp.ts";
import { serveStdio } from "../src/stdio.ts";
import { makeCtx } from "../src/context.ts";
import { PassThrough } from "node:stream";

const ALICE = "0x" + "a1".repeat(20);
const BOB = "0x" + "b2".repeat(20);
const sim = new SimContract();
let server: http.Server; let base: string;

before(async () => {
  await sim.directWrite(ALICE, "create_job", ["Logo files", "The studio logo as vector files.", ["Delivered as SVG", "Includes a usage guide"]]);
  await sim.directWrite(BOB, "accept_job", ["job-1"]);
  await sim.directWrite(BOB, "submit_delivery", ["job-1", "https://example.com/logo-package"]);
  await sim.directWrite(BOB, "evaluate_delivery", ["rcpt-1"]);
  const cfg = loadConfig({ NODE_ENV: "test", CORS_ORIGINS: "https://app.example" });
  const mk = (c: "latest" | "final") => createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
  server = createApiServer({ config: cfg, clients: { latest: await mk("latest"), final: await mk("final") } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

let nextId = 1;
const rpc = async (method: string, params?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params !== undefined ? { params } : {}) }) });
  const text = await res.text();
  return { res, json: text ? JSON.parse(text) : null };
};
const call = async (name: string, args?: unknown) => (await rpc("tools/call", { name, arguments: args })).json.result;

test("initialize negotiates a supported protocol version and says what the server is", async () => {
  const { json } = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(json.result.protocolVersion, "2025-03-26");
  assert.equal(json.result.serverInfo.name, "allocyn");
  assert.deepEqual(Object.keys(json.result.capabilities), ["tools"]);
  assert.match(json.result.instructions, /read-only/);
  const unknown = await rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.json.result.protocolVersion, MCP_PROTOCOLS[0]);
});

test("every REST read route is an MCP tool, all marked read-only, with a schema built from the route", async () => {
  const { json } = await rpc("tools/list");
  const tools = json.result.tools as any[];
  const expected = ROUTES.filter((r) => r.mcp !== false);
  assert.equal(tools.length, expected.length);
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true); assert.equal(t.annotations.destructiveHint, false);
    assert.equal(t.inputSchema.type, "object"); assert.equal(t.inputSchema.additionalProperties, false);
    assert.ok(!("route" in t), "internal route is not leaked");
  }
  const getJob = tools.find((t) => t.name === "get_job");
  assert.deepEqual(getJob.inputSchema.required, ["jobId"]);
  assert.equal(getJob.inputSchema.properties.jobId.pattern, "^job-[1-9][0-9]*$");
  assert.deepEqual(getJob.inputSchema.properties.consistency.enum, ["latest", "final"]);
  assert.ok(!tools.some((t) => /write|create|submit|accept|evaluate_delivery|send/.test(t.name)), "no tool can write");
});

test("get_job and list receipts return the same data as the REST API", async () => {
  const r = await call("get_job", { jobId: "job-1" });
  assert.equal(r.isError, false);
  const rest = await (await fetch(base + "/v1/jobs/job-1")).json();
  assert.deepEqual(r.structuredContent, rest);
  assert.deepEqual(JSON.parse(r.content[0].text), rest);
  const list = await call("list_job_receipts", { jobId: "job-1" });
  assert.equal(list.structuredContent.data.length, 1);
  const one = await call("get_job_receipt_by_index", { jobId: "job-1", deliveryIndex: 1 });
  assert.equal(one.structuredContent.data.id, "rcpt-1");
  const meta = await call("get_meta");
  assert.equal(meta.structuredContent.data.canWrite, false);
});

test("errors come back as tool errors (isError) with the API's error body, not as protocol failures", async () => {
  const missing = await call("get_job", { jobId: "job-99" });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, "JOB_NOT_FOUND");
  for (const [args, field] of [[{ jobId: "../x" }, "jobId"], [{}, "jobId"], [{ jobId: "job-1", extra: 1 }, "extra"], [{ jobId: "job-1", consistency: "soon" }, "consistency"]] as const) {
    const r = await call("get_job", args);
    assert.equal(r.isError, true); assert.equal(r.structuredContent.error.code, "INVALID_ARGUMENT"); assert.equal(r.structuredContent.error.field, field);
  }
  const bad = await call("get_job_receipt_by_index", { jobId: "job-1", deliveryIndex: "1" });
  assert.equal(bad.isError, true);
  const zero = await call("get_job_receipt_by_index", { jobId: "job-1", deliveryIndex: 0 });
  assert.equal(zero.isError, true);
});

test("protocol errors: unknown tool, unknown method, invalid message, bad JSON", async () => {
  assert.equal((await rpc("tools/call", { name: "send_money", arguments: {} })).json.error.code, -32602);
  assert.equal((await rpc("resources/list")).json.error.code, -32601);
  const bad = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{nope" });
  assert.equal(bad.status, 400); assert.equal((await bad.json()).error.code, -32700);
  const notRpc = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hello: 1 }) });
  assert.equal((await notRpc.json()).error.code, -32600);
});

test("notifications get 202 and no body; batches answer only the requests; ping works", async () => {
  const n = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(n.status, 202); assert.equal(await n.text(), "");
  const b = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]) });
  const body = await b.json();
  assert.equal(body.length, 1); assert.deepEqual(body[0].result, {});
  const empty = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]" });
  assert.equal(empty.status, 400);
});

test("HTTP rules: POST only, foreign browser origins refused, allowed origins answered, body size capped", async () => {
  const g = await fetch(base + "/mcp");
  assert.equal(g.status, 405); assert.equal(g.headers.get("allow"), "POST, OPTIONS");
  const evil = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal(evil.status, 403);
  const ok = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.example");
  const pre = await fetch(base + "/mcp", { method: "OPTIONS", headers: { Origin: "https://app.example" } });
  assert.equal(pre.status, 204); assert.match(pre.headers.get("access-control-allow-methods")!, /POST/);
  const big = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(70_000) } }) });
  assert.equal(big.status, 413);
});

test("the REST API still refuses writes: /v1 stays GET-only", async () => {
  const r = await fetch(base + "/v1/jobs/job-1", { method: "POST", body: "{}" });
  assert.equal(r.status, 405);
});

test("buildTools names are unique snake_case", () => {
  const names = buildTools().map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.match(n, /^[a-z][a-z0-9_]*$/);
});

test("stdio transport: one message per line, notifications silent, bad lines answered with a parse error, nothing else on the output", async () => {
  const mk = (c: "latest" | "final") => createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
  const clients = { latest: await mk("latest"), final: await mk("final") };
  const handler = createMcpHandler({ makeCtx: (p, q) => makeCtx({ clients, defaultConsistency: "latest", now: Date.now, timeoutMs: 5000 }, p, q), defaultConsistency: "latest", timeoutMs: 5000 });
  const input = new PassThrough(), output = new PassThrough();
  let out = ""; output.on("data", (d) => { out += d; });
  const done = serveStdio(handler, input, output);
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  input.write("not json\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_job", arguments: { jobId: "job-1" } } }) + "\n");
  input.end();
  await done;
  const lines = out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.equal(lines.find((l) => l.id === 1).result.serverInfo.name, "allocyn");
  assert.equal(lines.find((l) => l.error)?.error.code, -32700);
  assert.equal(lines.find((l) => l.id === 2).result.structuredContent.data.id, "job-1");
});
