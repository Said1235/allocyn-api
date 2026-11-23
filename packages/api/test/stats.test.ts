import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createAllocynClient } from "@allocyn/sdk";
import { SimContract } from "../../sdk/src/core/contract/sim.ts";
import { createApiServer } from "../src/server.ts";
import { loadConfig, ConfigError } from "../src/config.ts";
import { createCopyReader, assertPublicKey } from "../src/copy.ts";
import { startFakePostgrest, type FakeDb } from "./fixtures/fake-postgrest.ts";

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20);
const KEY = "sb_publishable_test_key";
const sim = new SimContract();
let db: FakeDb; let withCopy: http.Server; let noCopy: http.Server; let urlWith: string; let urlNo: string;
let clock = 5_000_000;

const serve = async (copy: ReturnType<typeof createCopyReader> | null) => {
  const mk = (c: "latest" | "final") => createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
  const s = createApiServer({ config: loadConfig({ NODE_ENV: "test", RATE_LIMIT_MAX: "1000" }), clients: { latest: await mk("latest"), final: await mk("final") }, now: () => clock, copy });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
};
const getJson = async (url: string, p: string) => { const res = await fetch(url + p); return { res, json: await res.json() as any }; };

before(async () => {
  db = await startFakePostgrest(KEY);
  db.publicRole = true;
  db.state.last_job_number = 5; db.state.last_run_at = "2026-11-19T10:00:00+00:00"; db.state.contract_address = "0x5729a3b514654Ec5966A1DCa8e5088ef7A70bBDA"; db.state.network = "studionet";
  const job = (n: number, status: string, client: string, worker: string | null) => db.jobs.set(`job-${n}`, { id: `job-${n}`, status, client, worker });
  job(1, "VERIFIED", A, B); job(2, "VERIFIED", A, C); job(3, "OPEN", A, null); job(4, "IN_PROGRESS", C, B); job(5, "NEEDS_REVISION", C, B);
  const rcpt = (n: number, jobId: string, worker: string, status: string, outcome: string | null) => db.receipts.set(`rcpt-${n}`, { id: `rcpt-${n}`, job_id: jobId, worker, status, overall_status: outcome });
  rcpt(1, "job-1", B, "EVALUATED", "VERIFIED"); rcpt(2, "job-2", C, "EVALUATED", "VERIFIED"); rcpt(3, "job-5", B, "SUPERSEDED", "NEEDS_REVISION");
  rcpt(4, "job-5", B, "EVALUATED", "NEEDS_REVISION"); rcpt(5, "job-4", B, "PENDING", null); rcpt(6, "job-4", B, "SUPERSEDED", null);
  const a = await serve(createCopyReader({ url: db.url, key: KEY })); withCopy = a.s; urlWith = a.url;
  const b = await serve(null); noCopy = b.s; urlNo = b.url;
});
after(async () => { withCopy.close(); noCopy.close(); await db.close(); });

test("counts jobs by status and deliveries by verdict, and says when and from which contract", async () => {
  const { res, json } = await getJson(urlWith, "/v1/stats");
  assert.equal(res.status, 200);
  const d = json.data;
  assert.equal(d.source, "copy");
  assert.deepEqual(d.jobs, { total: 5, byStatus: { OPEN: 1, IN_PROGRESS: 1, VERIFIED: 2, NEEDS_REVISION: 1, INCONCLUSIVE: 0 } });
  assert.deepEqual(d.receipts, { total: 6, byOutcome: { VERIFIED: 2, NEEDS_REVISION: 2, INCONCLUSIVE: 0, PENDING: 1 } });
  assert.equal(d.syncedAt, "2026-11-19T10:00:00.000Z"); assert.equal(d.copiedThrough, "job-5");
  assert.equal(d.contract, "0x5729a3b514654Ec5966A1DCa8e5088ef7A70bBDA"); assert.equal(d.network, "studionet");
  assert.deepEqual(d.filter, { client: null, worker: null });
  assert.ok(d.notes.length >= 2);
  assert.equal(res.headers.get("cache-control"), "public, max-age=60");
});

test("a worker filter scopes jobs and deliveries; the address may be in any case", async () => {
  const { json } = await getJson(urlWith, `/v1/stats?worker=${B.toUpperCase().replace("0X", "0x")}`);
  assert.deepEqual(json.data.filter, { client: null, worker: B });
  assert.deepEqual(json.data.jobs, { total: 3, byStatus: { OPEN: 0, IN_PROGRESS: 1, VERIFIED: 1, NEEDS_REVISION: 1, INCONCLUSIVE: 0 } });
  assert.deepEqual(json.data.receipts, { total: 5, byOutcome: { VERIFIED: 1, NEEDS_REVISION: 2, INCONCLUSIVE: 0, PENDING: 1 } });
});

test("a client filter scopes jobs and leaves deliveries out, because they belong to the worker", async () => {
  const { json } = await getJson(urlWith, `/v1/stats?client=${A}`);
  assert.deepEqual(json.data.jobs, { total: 3, byStatus: { OPEN: 1, IN_PROGRESS: 0, VERIFIED: 2, NEEDS_REVISION: 0, INCONCLUSIVE: 0 } });
  assert.equal(json.data.receipts, null);
});

test("unknown parameters and a bad address are refused like everywhere else", async () => {
  assert.equal((await getJson(urlWith, "/v1/stats?limit=3")).res.status, 400);
  assert.equal((await getJson(urlWith, "/v1/stats?consistency=final")).res.status, 400);
  const bad = await getJson(urlWith, "/v1/stats?worker=0x123");
  assert.equal(bad.res.status, 400); assert.equal(bad.json.error.field, "worker");
});

test("without a database copy the endpoint says so, and is not retryable", async () => {
  const { res, json } = await getJson(urlNo, "/v1/stats");
  assert.equal(res.status, 503); assert.equal(json.error.code, "COPY_UNAVAILABLE"); assert.equal(json.error.retryable, false);
});

test("the public key goes in `apikey` only, never in Authorization or the URL", async () => {
  clock += 60_000; db.log.length = 0;
  await getJson(urlWith, "/v1/stats");
  assert.equal(db.log.length, 2, "one call for the status, one for all the counts");
  for (const l of db.log) {
    assert.equal(l.apikey, KEY); assert.equal(l.authorization, undefined); assert.ok(!l.target.includes(KEY)); assert.match(l.ua ?? "", /^allocyn-api/);
    // The only POST allowed is the read-only job_stats function. Nothing the API function sends writes a row.
    assert.ok(l.method === "GET" || l.method === "HEAD" || (l.method === "POST" && l.target === "/rest/v1/rpc/job_stats"), `unexpected ${l.method} ${l.target}`);
  }
});

test("without the job_stats function in the database, the counts are made one by one and are the same", async () => {
  clock += 60_000; db.log.length = 0; db.rpcEnabled = false;
  try {
    const { res, json } = await getJson(urlWith, "/v1/stats");
    assert.equal(res.status, 200);
    assert.deepEqual(json.data.jobs, { total: 5, byStatus: { OPEN: 1, IN_PROGRESS: 1, VERIFIED: 2, NEEDS_REVISION: 1, INCONCLUSIVE: 0 } });
    assert.deepEqual(json.data.receipts, { total: 6, byOutcome: { VERIFIED: 2, NEEDS_REVISION: 2, INCONCLUSIVE: 0, PENDING: 1 } });
    assert.ok(db.log.length >= 12, "the old path");
    for (const l of db.log) assert.ok(l.method === "GET" || l.method === "HEAD" || l.target === "/rest/v1/rpc/job_stats");
  } finally { db.rpcEnabled = true; }
});

test("the function path gives the same answer for a worker and for a client", async () => {
  clock += 60_000;
  const w = (await getJson(urlWith, `/v1/stats?worker=${B}`)).json.data;
  assert.deepEqual(w.jobs, { total: 3, byStatus: { OPEN: 0, IN_PROGRESS: 1, VERIFIED: 1, NEEDS_REVISION: 1, INCONCLUSIVE: 0 } });
  assert.deepEqual(w.receipts, { total: 5, byOutcome: { VERIFIED: 1, NEEDS_REVISION: 2, INCONCLUSIVE: 0, PENDING: 1 } });
  const c = (await getJson(urlWith, `/v1/stats?client=${A}`)).json.data;
  assert.equal(c.jobs.total, 3); assert.equal(c.receipts, null);
});

test("answers are cached for 30 seconds, so a busy page does not hit the database every time", async () => {
  clock += 60_000;
  await getJson(urlWith, "/v1/stats?worker=" + C); const n = db.log.length;
  await getJson(urlWith, "/v1/stats?worker=" + C);
  assert.equal(db.log.length, n, "second call inside the window reads nothing");
  clock += 31_000;
  await getJson(urlWith, "/v1/stats?worker=" + C);
  assert.ok(db.log.length > n, "after the window it counts again");
});

test("a failing database gives a retryable 502 that does not leak details", async () => {
  clock += 120_000; db.forceStatus = 500;
  try {
    const { res, json } = await getJson(urlWith, "/v1/stats?worker=" + A);
    assert.equal(res.status, 502); assert.equal(json.error.code, "UPSTREAM_UNAVAILABLE"); assert.equal(json.error.retryable, true);
    assert.ok(!JSON.stringify(json).includes(db.url) && !JSON.stringify(json).includes(KEY));
  } finally { db.forceStatus = null; }
});

test("it is also an MCP tool, read-only", async () => {
  const rpc = async (method: string, params?: unknown) => (await (await fetch(urlWith + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as any;
  const tool = (await rpc("tools/list")).result.tools.find((t: any) => t.name === "get_stats");
  assert.ok(tool); assert.equal(tool.annotations.readOnlyHint, true);
  clock += 120_000;
  const out = await rpc("tools/call", { name: "get_stats", arguments: {} });
  assert.ok(!out.result.isError);
  assert.equal(JSON.parse(out.result.content[0].text).data?.jobs?.total ?? JSON.parse(out.result.content[0].text).jobs?.total, 5);
});

test("a secret key is refused wherever it could be given to the API", () => {
  assert.throws(() => assertPublicKey("sb_secret_abc123"), /secret key/);
  const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.sig`;
  assert.throws(() => assertPublicKey(jwt("service_role")), /service_role/);
  assert.doesNotThrow(() => assertPublicKey(jwt("anon")));
  assert.doesNotThrow(() => assertPublicKey("sb_publishable_abc"));
  assert.throws(() => createCopyReader({ url: "https://x.supabase.co", key: "sb_secret_abc" }), /secret key/);
  assert.throws(() => loadConfig({ NODE_ENV: "test", SUPABASE_URL: "https://x.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_secret_abc" }), /SUPABASE_PUBLISHABLE_KEY: .*secret key/);
  assert.throws(() => loadConfig({ NODE_ENV: "test", SUPABASE_SECRET_KEY: "sb_secret_abc" }), (e: unknown) => e instanceof ConfigError && /public key/.test(e.message) && !e.message.includes("sb_secret_abc"));
  assert.throws(() => loadConfig({ NODE_ENV: "test", SUPABASE_SERVICE_ROLE_KEY: "x" }), ConfigError);
});

test("the configuration needs both variables or neither, and https", () => {
  assert.equal(loadConfig({ NODE_ENV: "test" }).copy, null);
  assert.throws(() => loadConfig({ NODE_ENV: "test", SUPABASE_URL: "https://x.supabase.co" }), /both/);
  assert.throws(() => loadConfig({ NODE_ENV: "test", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x" }), /both/);
  assert.throws(() => loadConfig({ NODE_ENV: "production", CORS_ORIGINS: "https://a.example", SUPABASE_URL: "http://x.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x" }), /https/);
  assert.deepEqual(loadConfig({ NODE_ENV: "test", SUPABASE_URL: "https://x.supabase.co/", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x" }).copy, { url: "https://x.supabase.co", publishableKey: "sb_publishable_x" });
});
