import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createAllocynClient } from "@allocyn/sdk";
import { SimContract } from "../../sdk/src/core/contract/sim.ts";
import { createApiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { createCopyReader } from "../src/copy.ts";
import { createSupabaseStore } from "../src/indexer.ts";
import { startFakePostgrest, type FakeDb } from "./fixtures/fake-postgrest.ts";

const A = "0x" + "a1".repeat(20);
const KEY = "sb_publishable_test_key";
let db: FakeDb; let srv: http.Server; let url: string; let clock = Date.parse("2026-11-23T12:00:00Z");

const get = async (p: string) => { const res = await fetch(url + p); return { res, json: await res.json() as any }; };

before(async () => {
  db = await startFakePostgrest(KEY); db.publicRole = true;
  db.state.last_job_number = 4; db.state.contract_address = "0x5729a3b514654Ec5966A1DCa8e5088ef7A70bBDA"; db.state.network = "studionet";
  const job = (n: number, title: string, description: string, updated: string) => db.jobs.set(`job-${n}`, { id: `job-${n}`, title, description, status: "OPEN", client: A, worker: null, delivery_count: 0, updated_at: updated });
  job(1, "Logo files", "Vector logo for the studio", "2026-11-01T00:00:00Z");
  job(2, "Landing copy", "Texto para la página de inicio", "2026-11-10T00:00:00Z");
  job(3, "Logo animation", "Animated logo, short loop", "2026-11-20T00:00:00Z");
  job(4, "Translate docs", "Spanish to English", "2026-11-22T00:00:00Z");
  const sim = new SimContract();
  await sim.directWrite(A, "create_job", ["From the contract", "Only the contract has it.", ["One check"]]);
  const mk = (c: "latest" | "final") => createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
  srv = createApiServer({ config: loadConfig({ NODE_ENV: "test", RATE_LIMIT_MAX: "1000" }), clients: { latest: await mk("latest"), final: await mk("final") }, now: () => clock, copy: createCopyReader({ url: db.url, key: KEY }) });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(async () => { srv.close(); await db.close(); });

// ---- search and updatedSince ----

test("q searches title and description, and every word must appear", async () => {
  const ids = async (q: string) => (await get(`/v1/jobs?q=${encodeURIComponent(q)}`)).json.data.items.map((i: any) => i.id);
  assert.deepEqual(await ids("logo"), ["job-3", "job-1"]);
  assert.deepEqual(await ids("logo animated"), ["job-3"]);
  assert.deepEqual(await ids("página"), ["job-2"]);
  assert.deepEqual(await ids("nothing like this"), []);
});

test("q and updatedSince default to the copy, and the request is plain: the text goes in one filter value", async () => {
  db.log.length = 0;
  const { json } = await get("/v1/jobs?q=logo");
  assert.equal(json.data.source, "copy");
  const list = db.log.find((l) => l.target.includes("order=job_number.desc"))!;
  assert.ok(new URL(list.target, "http://x").searchParams.get("search") === "plfts(simple).logo");
});

test("a search text cannot add filters of its own", async () => {
  db.log.length = 0;
  await get("/v1/jobs?q=" + encodeURIComponent("x&status=eq.VERIFIED&select=*"));
  const list = db.log.find((l) => l.target.includes("order=job_number.desc"))!;
  const sp = new URL(list.target, "http://x").searchParams;
  assert.equal(sp.get("status"), null); assert.equal(sp.get("select"), "id,job_number,title,status,client,worker,delivery_count");
});

test("updatedSince returns only jobs whose content changed since then", async () => {
  const ids = async (t: string) => (await get(`/v1/jobs?updatedSince=${encodeURIComponent(t)}`)).json.data.items.map((i: any) => i.id);
  assert.deepEqual(await ids("2026-11-20T00:00:00Z"), ["job-4", "job-3"]);
  assert.deepEqual(await ids("2026-11-23T00:00:00Z"), []);
  assert.equal((await get("/v1/jobs?updatedSince=yesterday")).res.status, 400);
  assert.equal((await get("/v1/jobs?updatedSince=2026-11-20")).res.status, 400);
});

test("search and updatedSince combine with the other filters", async () => {
  const r = (await get(`/v1/jobs?q=logo&updatedSince=2026-11-15T00:00:00Z&status=OPEN`)).json.data.items.map((i: any) => i.id);
  assert.deepEqual(r, ["job-3"]);
});

test("q needs the copy: with source=contract it is refused, and with a down copy there is no silent fallback", async () => {
  const bad = await get("/v1/jobs?q=logo&source=contract");
  assert.equal(bad.res.status, 400); assert.equal(bad.json.error.field, "q");
  db.forceStatus = 500;
  try { assert.equal((await get("/v1/jobs?q=logo&source=auto")).res.status, 502); } finally { db.forceStatus = null; }
  assert.equal((await get("/v1/jobs?q=a")).res.status, 400, "too short");
  assert.equal((await get("/v1/jobs?q=" + "x".repeat(101))).res.status, 400, "too long");
});

// ---- health ----

test("a plain health check never reads the database", async () => {
  db.log.length = 0;
  const { json } = await get("/v1/health");
  assert.equal(json.data.copy, undefined); assert.equal(db.log.length, 0);
});

test("a deep health check reports the age of the copy and the last run", async () => {
  db.state.last_run_at = "2026-11-23T11:30:00+00:00";
  db.runs.push({ id: 1, ok: true, finished_at: "2026-11-23T11:30:05+00:00", new_jobs: 2, refreshed_jobs: 1, receipts: 3, failed_rows: 0, rounds: 1 });
  const { res, json } = await get("/v1/health?deep=true");
  assert.equal(res.status, 200);
  assert.equal(json.data.checks.chain, "ok"); assert.equal(json.data.checks.copy, "ok");
  assert.equal(json.data.copy.lagSeconds, 1800); assert.equal(json.data.copy.syncedAt, "2026-11-23T11:30:00.000Z");
  assert.equal(json.data.copy.copiedThrough, "job-4");
  assert.deepEqual(json.data.copy.lastRun, { ok: true, finishedAt: "2026-11-23T11:30:05.000Z", newJobs: 2, refreshedJobs: 1, receipts: 3, failedRows: 0, rounds: 1 });
});

test("a copy that is old, failing or unreachable is reported, and never turns the health check into a 503", async () => {
  clock += 4 * 3600 * 1000;
  assert.equal((await get("/v1/health?deep=true")).json.data.checks.copy, "stale");
  clock -= 4 * 3600 * 1000;
  db.runs.push({ id: 2, ok: false, finished_at: "2026-11-23T11:40:00+00:00", new_jobs: 0, refreshed_jobs: 0, receipts: 0, failed_rows: 2, rounds: 1 });
  assert.equal((await get("/v1/health?deep=true")).json.data.checks.copy, "failing");
  db.forceStatus = 500;
  try {
    const r = await get("/v1/health?deep=true");
    assert.equal(r.res.status, 200); assert.equal(r.json.data.checks.copy, "unavailable"); assert.equal(r.json.data.copy, undefined);
    assert.ok(!JSON.stringify(r.json).includes(KEY));
  } finally { db.forceStatus = null; }
});

// ---- the indexer records its runs ----

test("the store writes one row per run, keeps the newest 200, and never sends the key in Authorization", async () => {
  const store = createSupabaseStore({ url: db.url, secretKey: db.key });
  db.runs = []; db.log.length = 0;
  const t = new Date("2026-11-23T12:00:00Z");
  for (let i = 0; i < 205; i++) await store.recordRun!({ startedAt: t, finishedAt: new Date(t.getTime() + i * 1000), ok: i % 2 === 0, newJobs: 1, refreshedJobs: 2, receipts: 3, failedRows: 0, rounds: 1, lastJobNumber: 4, error: i === 1 ? "x".repeat(900) : null });
  assert.equal(db.runs.length, 200);
  assert.equal(db.runs[0].id, 6);
  assert.ok(db.runs.every((r) => r.error === null || r.error.length <= 500));
  for (const l of db.log) { assert.equal(l.authorization, undefined); assert.equal(l.apikey, db.key); }
});
