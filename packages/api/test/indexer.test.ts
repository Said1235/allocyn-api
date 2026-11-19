import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createAllocynClient } from "@allocyn/sdk";
import { SimContract } from "../../sdk/src/core/contract/sim.ts";
import { runIndexer, createSupabaseStore, IndexerError } from "../src/indexer.ts";
import { startFakePostgrest, type FakeDb } from "./fixtures/fake-postgrest.ts";

const ALICE = "0x" + "a1".repeat(20);
const BOB = "0x" + "b2".repeat(20);
const sim = new SimContract();
let calls = 0;
const spy: SimContract = Object.create(sim);
spy.call = async (m: string, a: readonly unknown[]) => { calls++; return sim.call(m, a); };
let client: Awaited<ReturnType<typeof createAllocynClient>>;
let db: FakeDb;
const T0 = new Date("2026-11-19T10:00:00Z");
let tick = 0;
const clock = () => new Date(T0.getTime() + 1000 * tick++);

before(async () => {
  // job-1 verified with one receipt; job-2 in progress with a pending receipt; job-3..job-6 open
  await sim.directWrite(ALICE, "create_job", ["Logo files", "The studio logo as vector files.", ["Delivered as SVG", "Includes a usage guide"]]);
  await sim.directWrite(BOB, "accept_job", ["job-1"]);
  await sim.directWrite(BOB, "submit_delivery", ["job-1", "https://example.com/logo-package"]);
  await sim.directWrite(BOB, "evaluate_delivery", ["rcpt-1"]);
  await sim.directWrite(ALICE, "create_job", ["Landing copy", "Write the landing page copy.", ["Under 300 words", "Has a call to action"]]);
  await sim.directWrite(BOB, "accept_job", ["job-2"]);
  await sim.directWrite(BOB, "submit_delivery", ["job-2", "https://example.com/copy"]);
  for (let i = 3; i <= 6; i++) await sim.directWrite(ALICE, "create_job", [`Job ${i}`, "An open job.", ["First check", "Second check"]]);
  client = await createAllocynClient({ gateway: spy, actor: null, readConsistency: "final" });
});

const opened: FakeDb[] = [];
const fresh = async (key?: string) => { db = await startFakePostgrest(key); opened.push(db); return createSupabaseStore({ url: db.url, secretKey: db.key }); };
after(async () => { await Promise.all(opened.map((d) => d.close())); });

test("first run copies every job and receipt, and remembers the position and the contract", async () => {
  const store = await fresh();
  const r = await runIndexer({ client, store, network: "studionet", now: clock });
  assert.equal(r.latest, 6); assert.equal(r.position, 6); assert.equal(r.newJobs, 6); assert.equal(r.refreshedJobs, 0);
  assert.equal(db.jobs.size, 6); assert.equal(db.receipts.size, 2);
  assert.equal(db.jobs.get("job-1").status, "VERIFIED"); assert.equal(db.jobs.get("job-2").status, "IN_PROGRESS");
  assert.equal(db.receipts.get("rcpt-1").overall_status, "VERIFIED"); assert.equal(db.receipts.get("rcpt-1").job_id, "job-1");
  assert.equal(db.state.last_job_number, 6); assert.equal(db.state.last_error, null);
  assert.equal(db.state.contract_address, client.contractAddress); assert.equal(db.state.network, "studionet");
  assert.deepEqual(r.failed, []); assert.deepEqual(r.missing, []);
  await db.close();
});

test("the key goes in `apikey` only, never in Authorization or the URL, and job_number is never sent", async () => {
  const store = await fresh();
  await runIndexer({ client, store, network: "studionet", now: clock });
  assert.ok(db.log.length > 3);
  for (const l of db.log) {
    assert.equal(l.apikey, db.key); assert.equal(l.authorization, undefined);
    assert.ok(!l.target.includes(db.key)); assert.match(l.ua ?? "", /^allocyn-indexer/);
    if (l.body) for (const row of [].concat(l.body)) assert.ok(!("job_number" in (row as object)));
  }
  await db.close();
});

test("a second run changes nothing, re-reads only jobs that can still change, and never re-reads verified ones", async () => {
  const store = await fresh();
  await runIndexer({ client, store, network: "studionet", now: clock });
  const before = calls;
  const r = await runIndexer({ client, store, network: "studionet", now: clock });
  assert.equal(r.newJobs, 0); assert.equal(r.refreshedJobs, 5, "jobs 2 to 6 are not VERIFIED");
  assert.equal(db.jobs.size, 6);
  assert.ok(calls > before);
  const posts = db.log.filter((l) => l.method === "POST" && l.target.startsWith("/rest/v1/jobs"));
  for (const p of posts.slice(1)) assert.ok(!(p.body as any[]).some((j) => j.id === "job-1"), "job-1 is final and is not rewritten");
  await db.close();
});

test("a change in the contract shows up on the next run (accept, then evaluate)", async () => {
  const store = await fresh();
  await runIndexer({ client, store, network: "studionet", now: clock });
  assert.equal(db.jobs.get("job-3").status, "OPEN");
  await sim.directWrite(BOB, "accept_job", ["job-3"]);
  await runIndexer({ client, store, network: "studionet", now: clock });
  assert.equal(db.jobs.get("job-3").status, "IN_PROGRESS"); assert.equal(db.jobs.get("job-3").worker, BOB);
  await sim.directWrite(BOB, "evaluate_delivery", ["rcpt-2"]);
  await runIndexer({ client, store, network: "studionet", now: clock });
  assert.equal(db.receipts.get("rcpt-2").status, "EVALUATED");
  assert.equal(db.jobs.get("job-2").status, db.receipts.get("rcpt-2").overall_status);
  await db.close();
});

test("maxNew pages through new jobs across runs; the position only moves as far as it read", async () => {
  const store = await fresh();
  const a = await runIndexer({ client, store, network: "studionet", now: clock, maxNew: 4 });
  assert.equal(a.position, 4); assert.equal(a.newJobs, 4); assert.equal(db.jobs.size, 4); assert.equal(db.state.last_job_number, 4);
  const b = await runIndexer({ client, store, network: "studionet", now: clock, maxNew: 4 });
  assert.equal(b.position, 6); assert.equal(db.jobs.size, 6);
  await db.close();
});

test("one refused row does not stop the others: it is skipped, reported, and noted in last_error", async () => {
  const store = await fresh();
  db.rejectIds.add("job-4");
  const r = await runIndexer({ client, store, network: "studionet", now: clock });
  assert.equal(db.jobs.size, 5); assert.ok(!db.jobs.has("job-4"));
  assert.equal(r.failed.length, 1); assert.equal(r.failed[0]!.id, "job-4");
  assert.equal(r.position, 6);
  assert.match(db.state.last_error ?? "", /job-4/);
  assert.equal(db.receipts.size, 2, "receipts of the stored jobs still went in");
  await db.close();
});

test("a wrong key stops the run with a clear error that does not contain the key, and the position does not move", async () => {
  db = await startFakePostgrest("sb_secret_right"); opened.push(db);
  const store = createSupabaseStore({ url: db.url, secretKey: "sb_secret_WRONG_value" });
  await assert.rejects(() => runIndexer({ client, store, network: "studionet", now: clock }), (e: unknown) => {
    assert.ok(e instanceof IndexerError); assert.equal(e.status, 401); assert.ok(!e.message.includes("WRONG_value")); return true;
  });
  assert.equal(db.state.last_job_number, 0);
  await db.close();
});

test("a database outage (500) is not retried row by row", async () => {
  const store = await fresh();
  await runIndexer({ client, store, network: "studionet", now: clock, maxNew: 1 });
  db.forceStatus = 503;
  const n = db.log.length;
  await assert.rejects(() => runIndexer({ client, store, network: "studionet", now: clock }), /503/);
  assert.ok(db.log.length - n <= 2, "stops at the first answer");
  await db.close();
});

test("a database that mirrors another contract is refused", async () => {
  const store = await fresh();
  db.state.contract_address = "0x" + "ee".repeat(20);
  await assert.rejects(() => runIndexer({ client, store, network: "studionet", now: clock }), /mirrors 0xeeee/);
  assert.equal(db.jobs.size, 0);
  await db.close();
});

test("the store refuses a non-https URL (except localhost) and a missing key", () => {
  assert.throws(() => createSupabaseStore({ url: "http://example.com", secretKey: "k" }), /https/);
  assert.throws(() => createSupabaseStore({ url: "not a url", secretKey: "k" }), /absolute URL/);
  assert.throws(() => createSupabaseStore({ url: "https://x.supabase.co", secretKey: "" }), /secret key/);
});
