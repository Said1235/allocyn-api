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

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20), NOBODY = "0x" + "99".repeat(20);
const KEY = "sb_publishable_test_key";
let db: FakeDb; let withCopy: http.Server; let noCopy: http.Server; let urlWith: string; let urlNo: string; let clock = 9_000_000;

const serve = async (copy: ReturnType<typeof createCopyReader> | null) => {
  const sim = new SimContract();
  const mk = (c: "latest" | "final") => createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
  const s = createApiServer({ config: loadConfig({ NODE_ENV: "test", RATE_LIMIT_MAX: "1000", REQUEST_TIMEOUT_MS: "6000" }), clients: { latest: await mk("latest"), final: await mk("final") }, now: () => clock, copy, pollMs: 50 });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
};
const get = async (url: string, p: string) => { const res = await fetch(url + p); return { res, json: await res.json() as any }; };

const ev = (id: number, job: number, type: string, o: Record<string, unknown> = {}) =>
  db.events.push({ id, created_at: `2026-11-23T10:0${id}:00+00:00`, job_id: `job-${job}`, type, from_status: null, to_status: null, client: A, worker: null, data: {}, ...o });

before(async () => {
  db = await startFakePostgrest(KEY); db.publicRole = true;
  db.state.last_job_number = 4; db.state.last_run_at = "2026-11-23T10:30:00+00:00"; db.state.contract_address = "0x5729a3b514654Ec5966A1DCa8e5088ef7A70bBDA"; db.state.network = "studionet";
  const job = (n: number, status: string, client: string, worker: string | null) => db.jobs.set(`job-${n}`, { id: `job-${n}`, title: `Job ${n}`, status, client, worker, delivery_count: worker ? 1 : 0 });
  job(1, "VERIFIED", A, B); job(2, "VERIFIED", A, C); job(3, "OPEN", A, null); job(4, "NEEDS_REVISION", C, B);
  db.receipts.set("rcpt-1", { id: "rcpt-1", job_id: "job-1", worker: B, status: "EVALUATED", overall_status: "VERIFIED" });
  db.receipts.set("rcpt-2", { id: "rcpt-2", job_id: "job-4", worker: B, status: "EVALUATED", overall_status: "NEEDS_REVISION" });
  db.receipts.set("rcpt-3", { id: "rcpt-3", job_id: "job-2", worker: C, status: "PENDING", overall_status: null });
  ev(1, 1, "job_created", { to_status: "OPEN" }); ev(2, 1, "job_accepted", { worker: B }); ev(3, 1, "delivery_submitted", { worker: B, data: { deliveryCount: 1 } });
  ev(4, 1, "delivery_evaluated", { worker: B, data: { receiptId: "rcpt-1", deliveryIndex: 1, outcome: "VERIFIED" } });
  ev(5, 4, "status_changed", { client: C, worker: B, from_status: "IN_PROGRESS", to_status: "NEEDS_REVISION" });
  const a = await serve(createCopyReader({ url: db.url, key: KEY })); withCopy = a.s; urlWith = a.url;
  const b = await serve(null); noCopy = b.s; urlNo = b.url;
});
after(async () => { withCopy.close(); noCopy.close(); await db.close(); });

// ---- events ----

test("with no cursor the feed gives the newest events, oldest first, and a cursor to continue from", async () => {
  const { res, json } = await get(urlWith, "/v1/events?limit=3");
  assert.equal(res.status, 200);
  assert.deepEqual(json.data.items.map((e: any) => e.id), [3, 4, 5]);
  assert.equal(json.data.cursor, 5); assert.equal(json.data.source, "copy");
  assert.equal(json.data.syncedAt, "2026-11-23T10:30:00.000Z");
  const e = json.data.items[1];
  assert.deepEqual({ type: e.type, jobId: e.jobId, worker: e.worker, data: e.data, detectedAt: e.detectedAt }, { type: "delivery_evaluated", jobId: "job-1", worker: B, data: { receiptId: "rcpt-1", deliveryIndex: 1, outcome: "VERIFIED" }, detectedAt: "2026-11-23T10:04:00.000Z" });
  assert.ok(json.data.notes.some((n: string) => /not when it happened/.test(n)));
});

test("after continues exactly where the cursor stopped, and an empty answer keeps the cursor", async () => {
  const p1 = (await get(urlWith, "/v1/events?after=0&limit=2")).json.data;
  assert.deepEqual(p1.items.map((e: any) => e.id), [1, 2]); assert.equal(p1.cursor, 2);
  const p2 = (await get(urlWith, `/v1/events?after=${p1.cursor}&limit=10`)).json.data;
  assert.deepEqual(p2.items.map((e: any) => e.id), [3, 4, 5]); assert.equal(p2.cursor, 5);
  const p3 = (await get(urlWith, `/v1/events?after=${p2.cursor}`)).json.data;
  assert.deepEqual(p3.items, []); assert.equal(p3.cursor, 5);
});

test("filters by job, type, worker and client, in any letter case for addresses", async () => {
  const ids = async (q: string) => (await get(urlWith, `/v1/events?after=0&${q}`)).json.data.items.map((e: any) => e.id);
  assert.deepEqual(await ids("job=job-4"), [5]);
  assert.deepEqual(await ids("type=job_created"), [1]);
  assert.deepEqual(await ids(`worker=${B.toUpperCase().replace("0X", "0x")}`), [2, 3, 4, 5]);
  assert.deepEqual(await ids(`client=${C}`), [5]);
  assert.deepEqual(await ids(`worker=${B}&type=status_changed`), [5]);
});

test("wait holds the request until a new event arrives, and returns early when one does", async () => {
  const started = Date.now();
  const pending = get(urlWith, "/v1/events?after=5&wait=5");
  setTimeout(() => ev(6, 3, "job_accepted", { worker: C }), 400);
  const { json } = await pending;
  assert.deepEqual(json.data.items.map((e: any) => e.id), [6]); assert.equal(json.data.cursor, 6);
  assert.ok(Date.now() - started < 4500, "answered when the event came, not at the end of the wait");
});

test("wait with nothing new answers empty at the end, always before the request timeout", async () => {
  const started = Date.now();
  const { res, json } = await get(urlWith, "/v1/events?after=6&wait=25");
  assert.equal(res.status, 200); assert.deepEqual(json.data.items, []); assert.equal(json.data.cursor, 6);
  assert.ok(Date.now() - started < 6000, "capped by REQUEST_TIMEOUT_MS");
});

test("bad parameters are refused, and a server with no copy says so", async () => {
  for (const [q, field] of [["after=-1", "after"], ["limit=0", "limit"], ["limit=101", "limit"], ["type=nope", "type"], ["worker=0x1", "worker"], ["job=job-0", "job"], ["wait=26", "wait"], ["foo=1", "foo"]] as const) {
    const r = await get(urlWith, `/v1/events?${q}`);
    assert.equal(r.res.status, 400, q); assert.equal(r.json.error.field, field, q);
  }
  const no = await get(urlNo, "/v1/events");
  assert.equal(no.res.status, 503); assert.equal(no.json.error.code, "COPY_UNAVAILABLE");
});

test("a failing database gives a retryable 502 without details", async () => {
  db.forceStatus = 500;
  try {
    const r = await get(urlWith, "/v1/events");
    assert.equal(r.res.status, 502); assert.equal(r.json.error.retryable, true);
    assert.ok(!JSON.stringify(r.json).includes(db.url) && !JSON.stringify(r.json).includes(KEY));
  } finally { db.forceStatus = null; }
});

// ---- address record ----

test("an address record counts its jobs as worker and as client, and the verdicts of its deliveries", async () => {
  const { res, json } = await get(urlWith, `/v1/addresses/${B.toUpperCase().replace("0X", "0x")}`);
  assert.equal(res.status, 200);
  const d = json.data;
  assert.equal(d.address, B); assert.equal(d.source, "copy"); assert.equal(d.copiedThrough, "job-4");
  assert.deepEqual(d.asWorker.jobs, { total: 2, byStatus: { OPEN: 0, IN_PROGRESS: 0, VERIFIED: 1, NEEDS_REVISION: 1, INCONCLUSIVE: 0 } });
  assert.deepEqual(d.asWorker.deliveries, { total: 2, byOutcome: { VERIFIED: 1, NEEDS_REVISION: 1, INCONCLUSIVE: 0, PENDING: 0 } });
  assert.deepEqual(d.asClient.jobs, { total: 0, byStatus: { OPEN: 0, IN_PROGRESS: 0, VERIFIED: 0, NEEDS_REVISION: 0, INCONCLUSIVE: 0 } });
  assert.deepEqual(d.recent.asWorker.map((j: any) => j.id), ["job-4", "job-1"]); assert.deepEqual(d.recent.asClient, []);
  assert.ok(d.notes.some((n: string) => /not a score/.test(n)));
  for (const k of Object.keys(d)) assert.ok(!/score|rank|rating|trust/i.test(k), `no score-like field: ${k}`);
});

test("one address can be both client and worker, and an unknown one is all zeros", async () => {
  const c = (await get(urlWith, `/v1/addresses/${C}`)).json.data;
  assert.equal(c.asClient.jobs.total, 1); assert.equal(c.asWorker.jobs.total, 1); assert.equal(c.asWorker.deliveries.byOutcome.PENDING, 1);
  const a = (await get(urlWith, `/v1/addresses/${A}`)).json.data;
  assert.equal(a.asClient.jobs.total, 3); assert.equal(a.asWorker.jobs.total, 0);
  const z = (await get(urlWith, `/v1/addresses/${NOBODY}`)).json.data;
  assert.equal(z.asWorker.jobs.total, 0); assert.equal(z.asClient.jobs.total, 0); assert.deepEqual(z.recent, { asWorker: [], asClient: [] });
});

test("a bad address is a 400, no copy is a 503, and answers are cached for 30 s", async () => {
  assert.equal((await get(urlWith, "/v1/addresses/0x123")).res.status, 400);
  assert.equal((await get(urlNo, `/v1/addresses/${A}`)).res.status, 503);
  clock += 60_000; db.log.length = 0;
  await get(urlWith, `/v1/addresses/${B}`); const n = db.log.length;
  await get(urlWith, `/v1/addresses/${B}`);
  assert.equal(db.log.length, n, "inside the window nothing is read");
  clock += 31_000; await get(urlWith, `/v1/addresses/${B}`);
  assert.ok(db.log.length > n);
});

test("the API function only reads: no write reaches the database", async () => {
  db.log.length = 0; clock += 60_000;
  await get(urlWith, `/v1/addresses/${C}`); await get(urlWith, "/v1/events");
  for (const l of db.log) {
    assert.equal(l.apikey, KEY); assert.equal(l.authorization, undefined);
    assert.ok(l.method === "GET" || l.method === "HEAD" || (l.method === "POST" && l.target === "/rest/v1/rpc/job_stats"), `${l.method} ${l.target}`);
  }
});

test("both are MCP tools, read-only", async () => {
  const rpc = async (method: string, params?: unknown) => (await (await fetch(urlWith + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as any;
  const tools = (await rpc("tools/list")).result.tools as any[];
  for (const n of ["list_events", "get_address_record"]) { const t = tools.find((x) => x.name === n); assert.ok(t, n); assert.equal(t.annotations.readOnlyHint, true); }
  const out = await rpc("tools/call", { name: "list_events", arguments: { after: 0, limit: 2 } });
  assert.ok(!out.result.isError);
  const body = JSON.parse(out.result.content[0].text);
  assert.equal((body.data ?? body).items.length, 2);
});
