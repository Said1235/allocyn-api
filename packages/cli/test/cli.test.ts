import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAllocynClient } from "@allocyn/sdk";
import { SimContract } from "../../sdk/src/core/contract/sim.ts";
import { createApiServer } from "../../api/src/server.ts";
import { loadConfig } from "../../api/src/config.ts";
import { run, CLI_VERSION } from "../src/run.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const ALICE = "0x" + "a1".repeat(20), BOB = "0x" + "b2".repeat(20);
const sim = new SimContract();
let server: http.Server; let api: string;

before(async () => {
  await sim.directWrite(ALICE, "create_job", ["Logo files", "The studio logo as vector files.", ["Delivered as SVG", "Includes a usage guide"]]);
  await sim.directWrite(BOB, "accept_job", ["job-1"]);
  await sim.directWrite(BOB, "submit_delivery", ["job-1", "https://example.com/logo-package"]);
  await sim.directWrite(BOB, "evaluate_delivery", ["rcpt-1"]);
  await sim.directWrite(ALICE, "create_job", ["Second", "An open job.", ["First check", "Second check"]]);
  const mk = (c: "latest" | "final") => createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
  server = createApiServer({ config: loadConfig({ NODE_ENV: "test", RATE_LIMIT_MAX: "1000" }), clients: { latest: await mk("latest"), final: await mk("final") } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function cli(args: string[], env: Record<string, string> = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await run(args, { fetch, out: (s) => out.push(s), err: (s) => err.push(s), env });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("job, receipts, proof and jobs print the API's data as JSON", async () => {
  const job = await cli(["job", "job-1", "--api", api]);
  assert.equal(job.code, 0); assert.equal(JSON.parse(job.out).status, "VERIFIED");
  assert.equal(JSON.parse((await cli(["receipts", "job-1", "--api", api])).out).length, 1);
  assert.equal(JSON.parse((await cli(["receipt", "rcpt-1", "--api", api])).out).id, "rcpt-1");
  const proof = JSON.parse((await cli(["proof", "job-1", "--api", api])).out);
  assert.equal(proof.final, true); assert.match(proof.digest.value, /^[0-9a-f]{64}$/);
  const list = JSON.parse((await cli(["jobs", "--status", "OPEN", "--limit=5", "--api", api])).out);
  assert.deepEqual(list.items.map((j: any) => j.id), ["job-2"]);
  assert.equal(JSON.parse((await cli(["limits", "--api", api])).out).source, "contract");
  assert.equal(JSON.parse((await cli(["meta", "--api", api])).out).canWrite, false);
  assert.equal(JSON.parse((await cli(["health", "--deep", "--api", api])).out).checks.chain, "ok");
  const wait = JSON.parse((await cli(["wait", "job-1", "--api", api])).out);
  assert.match(wait.version, /^[0-9a-f]{16}$/);
});

test("the API address can come from ALLOCYN_API_URL, and --envelope keeps { success, data }", async () => {
  const r = await cli(["job", "job-2", "--envelope"], { ALLOCYN_API_URL: api });
  assert.equal(JSON.parse(r.out).success, true);
  assert.equal(JSON.parse((await cli(["job", "job-1", "--consistency", "final", "--api", api])).out).id, "job-1");
});

test("badge prints the SVG, or just its URL", async () => {
  const svg = await cli(["badge", "job-1", "--api", api]);
  assert.match(svg.out, /^<svg /); assert.match(svg.out, /verified/);
  assert.equal((await cli(["badge", "job-1", "--url", "--api", api])).out, `${api}/v1/jobs/job-1/badge.svg`);
  const missing = await cli(["badge", "job-99", "--api", api]);
  assert.equal(missing.code, 1); assert.match(missing.err, /error 404/);
});

test("API errors exit 1 with the code and message on stderr; nothing on stdout", async () => {
  const r = await cli(["job", "job-99", "--api", api]);
  assert.equal(r.code, 1); assert.equal(r.out, ""); assert.match(r.err, /error JOB_NOT_FOUND/);
  const bad = await cli(["jobs", "--limit", "0", "--api", api]);
  assert.equal(bad.code, 1); assert.match(bad.err, /field: limit/);
});

test("usage mistakes exit 2 with a plain message", async () => {
  for (const args of [["job", "--api", api], ["frobnicate", "--api", api], ["job", "job-1"], ["job", "job-1", "--api", "not a url"], ["job", "job-1", "--api", "http://example.com"], ["job", "job-1", "--bogus", "--api", api], ["job", "job-1", "--api"], ["job", "job-1", "--consistency", "soon", "--api", api]]) {
    const r = await cli(args); assert.equal(r.code, 2, args.join(" ")); assert.ok(r.err.length > 0, args.join(" "));
  }
  assert.equal((await cli([])).code, 2);
  assert.match((await cli(["--help"])).out, /Commands:/); assert.equal((await cli(["--help"])).code, 0);
  assert.equal((await cli(["-v"])).out, CLI_VERSION);
});

test("an unreachable API exits 3; a non-Allocyn answer is explained", async () => {
  const down = await cli(["health", "--api", "http://127.0.0.1:1"]);
  assert.equal(down.code, 3); assert.match(down.err, /Could not reach/);
  const html = await run(["health", "--api", api], { fetch: (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch, out: () => {}, err: () => {}, env: {} });
  assert.equal(html, 3);
});

test("the built bundle runs with plain node, no dependencies, and reports its version", async () => {
  execFileSync(process.execPath, [path.join(here, "../scripts/build.mjs")], { stdio: "pipe" });
  const bin = path.join(here, "../dist/cli.js");
  // async: the API under test runs in this same process, so it must stay free to answer
  const exec = promisify(execFile);
  assert.equal((await exec(process.execPath, [bin, "--version"])).stdout.trim(), CLI_VERSION);
  const r = await exec(process.execPath, [bin, "job", "job-1", "--api", api]);
  assert.equal(JSON.parse(r.stdout).id, "job-1");
  await assert.rejects(exec(process.execPath, [bin, "job", "job-99", "--api", api]), (e: any) => e.code === 1 && /JOB_NOT_FOUND/.test(e.stderr));
});

test("evidence: the page is downloaded on this machine and compared with the receipt; exit 4 unless unchanged", async () => {
  const { createHash } = await import("node:crypto");
  const pageText = "Delivered as SVG. Includes a usage guide.";
  const hash = createHash("sha256").update(pageText).digest("hex");
  const prev = sim.evaluator;
  sim.evaluator = (_u: string, n: number) => ({ statuses: Array(n).fill("MET"), evidenceHash: hash, evidenceSize: Buffer.byteLength(pageText) }) as any;
  await sim.directWrite(ALICE, "create_job", ["Evidence job", "Used by the evidence test.", ["First check", "Second check"]]);
  await sim.directWrite(BOB, "accept_job", ["job-3"]);
  const rid = await sim.directWrite(BOB, "submit_delivery", ["job-3", "https://pages.example.org/evidence"]);
  await sim.directWrite(BOB, "evaluate_delivery", [String(rid)]);
  sim.evaluator = prev;
  const ridText = String(rid);
  const withPage = (body: string, status = 200) => (async (input: any, init?: any) => {
    const u = String(input);
    if (u.startsWith(api)) return fetch(input, init);
    const r = new Response(body, { status }); Object.defineProperty(r, "url", { value: u }); return r;
  }) as typeof fetch;
  const go = async (f: typeof fetch) => { const out: string[] = []; const code = await run(["evidence", ridText, "--api", api], { fetch: f, out: (s) => out.push(s), err: () => {}, env: {} }); return { code, body: JSON.parse(out.join("\n")) }; };
  const same = await go(withPage(pageText));
  assert.equal(same.code, 0); assert.equal(same.body.status, "unchanged");
  const changed = await go(withPage(pageText + " edited"));
  assert.equal(changed.code, 4); assert.equal(changed.body.status, "changed");
  const gone = await go(withPage("nope", 404));
  assert.equal(gone.code, 4); assert.equal(gone.body.status, "unreachable");
  const bad = await cli(["evidence", "rcpt-99", "--api", api]);
  assert.equal(bad.code, 1);
});

test("prepare shows what the person would sign and sends nothing", async () => {
  const r = await cli(["prepare", "job-2", "--action", "accept", "--api", api]);
  assert.equal(r.code, 0);
  const d = JSON.parse(r.out);
  assert.equal(d.canProceed, true); assert.equal(d.sent, false);
  assert.deepEqual(d.intent, { contractMethod: "accept_job", args: ["job-2"] });
  const bad = await cli(["prepare", "job-2", "--api", api]);
  assert.equal(bad.code, 1); assert.match(bad.err, /field: action/);
  const sub = await cli(["prepare", "job-2", "--action", "submit", "--delivery-url", "https://example.org/x", "--api", api]);
  assert.equal(sub.code, 0); assert.equal(JSON.parse(sub.out).canProceed, false);
});

// ---- commands that read the optional database copy ----

import { createCopyReader } from "../../api/src/copy.ts";
import { startFakePostgrest } from "../../api/test/fixtures/fake-postgrest.ts";

test("events, address, stats and the new jobs filters read the database copy", async () => {
  const KEY = "sb_publishable_test_key";
  const db = await startFakePostgrest(KEY); db.publicRole = true;
  db.state.last_job_number = 2; db.state.last_run_at = "2026-11-24T06:44:00+00:00";
  db.jobs.set("job-1", { id: "job-1", title: "Logo files", description: "The studio logo", status: "VERIFIED", client: ALICE, worker: BOB, delivery_count: 1 });
  db.jobs.set("job-2", { id: "job-2", title: "Second", description: "An open job", status: "OPEN", client: ALICE, worker: null, delivery_count: 0 });
  db.receipts.set("rcpt-1", { id: "rcpt-1", job_id: "job-1", worker: BOB, status: "EVALUATED", overall_status: "VERIFIED" });
  db.events.push({ id: 1, created_at: "2026-11-24T06:00:00+00:00", job_id: "job-1", type: "job_created", from_status: null, to_status: "OPEN", client: ALICE, worker: null, data: {} });
  db.events.push({ id: 2, created_at: "2026-11-24T06:10:00+00:00", job_id: "job-1", type: "job_accepted", from_status: null, to_status: null, client: ALICE, worker: BOB, data: {} });
  const mk = (c: "latest" | "final") => createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
  const withCopy = createApiServer({ config: loadConfig({ NODE_ENV: "test", RATE_LIMIT_MAX: "1000" }), clients: { latest: await mk("latest"), final: await mk("final") }, copy: createCopyReader({ url: db.url, key: KEY }) });
  await new Promise<void>((r) => withCopy.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(withCopy.address() as AddressInfo).port}`;
  try {
    const events = JSON.parse((await cli(["events", "--after", "0", "--limit", "10", "--worker", BOB, "--api", url])).out);
    assert.deepEqual(events.items.map((e: any) => e.id), [2]); assert.equal(events.cursor, 2);
    assert.deepEqual(JSON.parse((await cli(["events", "--type", "job_created", "--job", "job-1", "--api", url])).out).items.map((e: any) => e.id), [1]);
    const addr = JSON.parse((await cli(["address", BOB, "--api", url])).out);
    assert.equal(addr.address, BOB); assert.equal(addr.asWorker.jobs.total, 1); assert.equal(addr.asWorker.deliveries.byOutcome.VERIFIED, 1);
    const stats = JSON.parse((await cli(["stats", "--client", ALICE, "--api", url])).out);
    assert.equal(stats.jobs.total, 2); assert.equal(stats.receipts, null);
    const found = JSON.parse((await cli(["jobs", "--q", "logo", "--api", url])).out);
    assert.equal(found.source, "copy"); assert.deepEqual(found.items.map((j: any) => j.id), ["job-1"]);
    const copyList = JSON.parse((await cli(["jobs", "--source", "copy", "--status", "OPEN", "--api", url])).out);
    assert.deepEqual(copyList.items.map((j: any) => j.id), ["job-2"]);
    const since = await cli(["jobs", "--updated-since", "yesterday", "--api", url]);
    assert.equal(since.code, 1); assert.match(since.err, /updatedSince/);
    // a server with no copy: the error is explained, exit 1
    const none = await cli(["events", "--api", api]);
    assert.equal(none.code, 1); assert.match(none.err, /COPY_UNAVAILABLE/);
    assert.equal((await cli(["address", "--api", url])).code, 2, "address needs an argument");
  } finally { withCopy.closeAllConnections(); withCopy.close(); await db.close(); }
});
