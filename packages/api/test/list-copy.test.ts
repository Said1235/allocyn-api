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

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20);
const KEY = "sb_publishable_test_key";
let db: FakeDb; let withCopy: http.Server; let noCopy: http.Server; let urlWith: string; let urlNo: string;

const serve = async (copy: ReturnType<typeof createCopyReader> | null) => {
  const sim = new SimContract();
  await sim.directWrite(A, "create_job", ["From the contract", "A job only the contract has.", ["One check"]]);
  const mk = (c: "latest" | "final") => createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
  const s = createApiServer({ config: loadConfig({ NODE_ENV: "test", RATE_LIMIT_MAX: "1000" }), clients: { latest: await mk("latest"), final: await mk("final") }, copy });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
};
const get = async (url: string, p: string) => { const res = await fetch(url + p); return { res, json: await res.json() as any }; };

before(async () => {
  db = await startFakePostgrest(KEY); db.publicRole = true;
  db.state.last_job_number = 6; db.state.last_run_at = "2026-11-20T10:00:00+00:00"; db.state.contract_address = "0x5729a3b514654Ec5966A1DCa8e5088ef7A70bBDA"; db.state.network = "studionet";
  const job = (n: number, status: string, client: string, worker: string | null) => db.jobs.set(`job-${n}`, { id: `job-${n}`, title: `Copy job ${n}`, status, client, worker, delivery_count: worker ? 1 : 0 });
  job(1, "VERIFIED", A, B); job(2, "VERIFIED", A, C); job(3, "OPEN", A, null); job(4, "IN_PROGRESS", C, B); job(5, "NEEDS_REVISION", C, B); job(6, "OPEN", C, null);
  const a = await serve(createCopyReader({ url: db.url, key: KEY })); withCopy = a.s; urlWith = a.url;
  const b = await serve(null); noCopy = b.s; urlNo = b.url;
});
after(async () => { withCopy.close(); noCopy.close(); await db.close(); });

test("source=copy lists newest first with full pages, one query, and says how old the data is", async () => {
  db.log.length = 0;
  const { res, json } = await get(urlWith, "/v1/jobs?source=copy&limit=4");
  assert.equal(res.status, 200);
  const d = json.data;
  assert.deepEqual(d.items.map((i: any) => i.id), ["job-6", "job-5", "job-4", "job-3"]);
  assert.equal(d.items[0].title, "Copy job 6"); assert.equal(d.items[1].deliveryCount, 1);
  assert.equal(d.source, "copy"); assert.equal(d.scanned, 0); assert.equal(d.latest, "job-6");
  assert.equal(d.syncedAt, "2026-11-20T10:00:00.000Z"); assert.ok(d.notes.length >= 1);
  assert.equal(d.nextCursor, "job-3");
  assert.equal(db.log.filter((l) => l.target.startsWith("/rest/v1/jobs")).length, 1, "one query for the list");
});

test("the cursor continues exactly after the last job, and the last page has none", async () => {
  const p2 = (await get(urlWith, "/v1/jobs?source=copy&limit=4&before=job-3")).json.data;
  assert.deepEqual(p2.items.map((i: any) => i.id), ["job-2", "job-1"]);
  assert.equal(p2.nextCursor, null);
});

test("filters by status, client and worker, and combines them", async () => {
  const ids = async (q: string) => (await get(urlWith, `/v1/jobs?source=copy&${q}`)).json.data.items.map((i: any) => i.id);
  assert.deepEqual(await ids("status=OPEN"), ["job-6", "job-3"]);
  assert.deepEqual(await ids(`client=${A.toUpperCase().replace("0X", "0x")}`), ["job-3", "job-2", "job-1"]);
  assert.deepEqual(await ids(`worker=${B}`), ["job-5", "job-4", "job-1"]);
  assert.deepEqual(await ids(`worker=${B}&status=VERIFIED`), ["job-1"]);
});

test("the key goes in apikey only, and the API function only reads", async () => {
  db.log.length = 0;
  await get(urlWith, "/v1/jobs?source=copy");
  assert.ok(db.log.length >= 2);
  for (const l of db.log) { assert.equal(l.apikey, KEY); assert.equal(l.authorization, undefined); assert.equal(l.method, "GET"); }
});

test("without source the list still comes from the contract, exactly as before", async () => {
  db.log.length = 0;
  const { json } = await get(urlWith, "/v1/jobs");
  assert.equal(json.data.source, "contract"); assert.equal(json.data.syncedAt, null);
  assert.deepEqual(json.data.items.map((i: any) => i.title), ["From the contract"]);
  assert.equal(db.log.length, 0, "the default never touches the database");
});

test("source=copy on a server with no copy is a clear, non-retryable 503", async () => {
  const { res, json } = await get(urlNo, "/v1/jobs?source=copy");
  assert.equal(res.status, 503); assert.equal(json.error.code, "COPY_UNAVAILABLE"); assert.equal(json.error.retryable, false);
});

test("source=auto uses the copy when it works and the contract when it does not", async () => {
  const ok = (await get(urlWith, "/v1/jobs?source=auto")).json.data;
  assert.equal(ok.source, "copy");
  db.forceStatus = 500;
  try {
    const down = await get(urlWith, "/v1/jobs?source=auto");
    assert.equal(down.res.status, 200); assert.equal(down.json.data.source, "contract");
    assert.match(down.json.data.notes[0], /contract was read directly/);
    const strict = await get(urlWith, "/v1/jobs?source=copy");
    assert.equal(strict.res.status, 502); assert.equal(strict.json.error.code, "UPSTREAM_UNAVAILABLE");
    assert.ok(!JSON.stringify(strict.json).includes(db.url) && !JSON.stringify(strict.json).includes(KEY));
  } finally { db.forceStatus = null; }
  const noCfg = (await get(urlNo, "/v1/jobs?source=auto")).json.data;
  assert.equal(noCfg.source, "contract");
});

test("a bad source is refused", async () => {
  const bad = await get(urlWith, "/v1/jobs?source=cache");
  assert.equal(bad.res.status, 400); assert.equal(bad.json.error.field, "source");
});
