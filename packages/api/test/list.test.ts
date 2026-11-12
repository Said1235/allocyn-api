import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createAllocynClient } from "@allocyn/sdk";
import { SimContract } from "../../sdk/src/core/contract/sim.ts";
import { createApiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { latestJobNumber } from "../src/jobs-list.ts";

const ALICE = "0x" + "a1".repeat(20);
const CAROL = "0xC0" + "c3".repeat(19);
const BOB = "0x" + "b2".repeat(20);
const sim = new SimContract();
let server: http.Server; let base: string; let calls = 0;
const spy: SimContract = Object.create(sim);
spy.call = async (m: string, a: readonly unknown[]) => { calls++; return sim.call(m, a); };

before(async () => {
  // job-1 verified (alice, bob); job-2..job-129 open, created by alice or carol; job-130 in progress (carol, bob)
  await sim.directWrite(ALICE, "create_job", ["Logo files", "The studio logo as vector files.", ["Delivered as SVG", "Includes a usage guide"]]);
  await sim.directWrite(BOB, "accept_job", ["job-1"]);
  await sim.directWrite(BOB, "submit_delivery", ["job-1", "https://example.com/logo-package"]);
  await sim.directWrite(BOB, "evaluate_delivery", ["rcpt-1"]);
  for (let i = 2; i <= 129; i++) await sim.directWrite(i % 2 ? ALICE : CAROL, "create_job", [`Job ${i}`, "An open job.", ["First check", "Second check"]]);
  await sim.directWrite(CAROL, "create_job", ["Job 130", "Taken.", ["First check", "Second check"]]);
  await sim.directWrite(BOB, "accept_job", ["job-130"]);
  const cfg = loadConfig({ NODE_ENV: "test", RATE_LIMIT_MAX: "1000" });
  const mk = (c: "latest" | "final") => createAllocynClient({ gateway: spy, actor: null, readConsistency: c });
  server = createApiServer({ config: cfg, clients: { latest: await mk("latest"), final: await mk("final") } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
const list = async (qs = "") => { const r = await fetch(`${base}/v1/jobs${qs}`); return { status: r.status, body: await r.json() }; };

test("newest first, with the newest id, a cursor, and the right shape", async () => {
  const { status, body } = await list("?limit=3");
  assert.equal(status, 200);
  assert.deepEqual(body.data.items.map((j: any) => j.id), ["job-130", "job-129", "job-128"]);
  assert.equal(body.data.latest, "job-130"); assert.equal(body.data.nextCursor, "job-128");
  assert.deepEqual(Object.keys(body.data.items[0]).sort(), ["client", "deliveryCount", "id", "status", "title", "worker"]);
  assert.equal(body.data.items[0].status, "IN_PROGRESS"); assert.equal(body.data.items[0].worker, BOB);
});

test("paging with the cursor visits every job once, with no gap and no repeat", async () => {
  const seen: string[] = []; let cursor: string | null = null; let pages = 0;
  do {
    const { body } = await list(`?limit=50${cursor ? `&before=${cursor}` : ""}`);
    seen.push(...body.data.items.map((j: any) => j.id)); cursor = body.data.nextCursor; pages++;
  } while (cursor && pages < 10);
  assert.equal(seen.length, 130); assert.equal(new Set(seen).size, 130);
  assert.equal(seen[0], "job-130"); assert.equal(seen.at(-1), "job-1"); assert.equal(cursor, null);
});

test("filters by status, client and worker; a sparse match continues past the 100-id scan window", async () => {
  const verified = await list("?status=VERIFIED");
  assert.equal(verified.body.data.items.length, 0, "nothing in the first 100 ids is VERIFIED");
  assert.equal(verified.body.data.scanned, 100); assert.equal(verified.body.data.nextCursor, "job-31");
  const next = await list("?status=VERIFIED&before=job-31");
  assert.deepEqual(next.body.data.items.map((j: any) => j.id), ["job-1"]); assert.equal(next.body.data.nextCursor, null);
  const byClient = await list(`?client=${CAROL.toUpperCase().replace("0X", "0x")}&limit=2`);
  assert.deepEqual(byClient.body.data.items.map((j: any) => j.id), ["job-130", "job-128"]);
  const byWorker = await list(`?worker=${BOB}&limit=5`);
  assert.deepEqual(byWorker.body.data.items.map((j: any) => j.id), ["job-130"]); assert.equal(byWorker.body.data.nextCursor, "job-31");
  assert.deepEqual((await list(`?worker=${BOB}&limit=5&before=job-31`)).body.data.items.map((j: any) => j.id), ["job-1"]);
  assert.deepEqual((await list("?status=IN_PROGRESS")).body.data.items.map((j: any) => j.id), ["job-130"]);
});

test("a cursor beyond the newest job is clamped, and an empty contract lists nothing", async () => {
  assert.equal((await list("?before=job-9999&limit=1")).body.data.items[0].id, "job-130");
  const empty = new SimContract();
  const c = await createAllocynClient({ gateway: empty, actor: null, readConsistency: "latest" });
  assert.equal(await latestJobNumber(c, 0), 0);
});

test("the newest id is found in about 2*log2(n) reads and then cached", async () => {
  const c = await createAllocynClient({ gateway: spy, actor: null, readConsistency: "latest" });
  calls = 0; assert.equal(await latestJobNumber(c, 1000), 130);
  assert.ok(calls <= 20, `used ${calls} reads`);
  const before = calls; assert.equal(await latestJobNumber(c, 5000), 130); assert.equal(calls, before, "cached within 15 s");
  calls = 0; await latestJobNumber(c, 1000 + 20_000); assert.ok(calls > 0, "re-checked after the cache expires");
});

test("bad parameters are 400 and name the field", async () => {
  for (const [qs, field] of [["?limit=0", "limit"], ["?limit=51", "limit"], ["?limit=abc", "limit"], ["?before=job-0", "before"], ["?before=x", "before"], ["?status=DONE", "status"], ["?client=0x12", "client"], ["?foo=1", "foo"]] as const) {
    const { status, body } = await list(qs);
    assert.equal(status, 400, qs); assert.equal(body.error.field, field, qs);
  }
});

test("MCP: list_jobs is a tool with the same filters and the same answer", async () => {
  const call = async (args: unknown) => (await (await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_jobs", arguments: args } }) })).json()).result;
  const r = await call({ status: "IN_PROGRESS", limit: 5 });
  assert.equal(r.isError, false); assert.deepEqual(r.structuredContent.data.items.map((j: any) => j.id), ["job-130"]);
  const bad = await call({ limit: "5" }); assert.equal(bad.isError, true); assert.equal(bad.structuredContent.error.field, "limit");
  const tools = (await (await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) })).json()).result.tools;
  const t = tools.find((x: any) => x.name === "list_jobs");
  assert.deepEqual(t.inputSchema.required, []); assert.equal(t.inputSchema.properties.limit.maximum, 50); assert.equal(t.inputSchema.properties.status.enum.length, 5);
});
