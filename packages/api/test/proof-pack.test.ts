import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createAllocynClient, verifyProofPack, proofDigest, PROOF_FORMAT } from "@allocyn/sdk";
import type { AllocynClient } from "@allocyn/sdk";
import { SimContract } from "../../sdk/src/core/contract/sim.ts";
import { createApiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { canonicalJson } from "../src/proof.ts";
import { run } from "../../cli/src/run.ts";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath } from "node:url";

const ALICE = "0x" + "a1".repeat(20), BOB = "0x" + "b2".repeat(20);
const sim = new SimContract();
let server: http.Server; let api: string; let reader: AllocynClient;
const getPack = async (id: string, envelope = false) => { const j = await (await fetch(`${api}/v1/jobs/${id}/proof`)).json() as any; return envelope ? j : j.data; };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const status = (r: Awaited<ReturnType<typeof verifyProofPack>>, id: string) => r.checks.find((c) => c.id === id)?.status;

before(async () => {
  await sim.directWrite(ALICE, "create_job", ["Logo files", "The studio logo as vector files.", ["Delivered as SVG", "Includes a usage guide"]]);
  await sim.directWrite(BOB, "accept_job", ["job-1"]);
  await sim.directWrite(BOB, "submit_delivery", ["job-1", "https://example.com/logo-package"]);
  await sim.directWrite(BOB, "evaluate_delivery", ["rcpt-1"]);
  await sim.directWrite(ALICE, "create_job", ["Second", "An open job.", ["First check", "Second check"]]);
  const mk = (c: "latest" | "final") => createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
  reader = await mk("latest");
  server = createApiServer({ config: loadConfig({ NODE_ENV: "test", RATE_LIMIT_MAX: "1000" }), clients: { latest: reader, final: await mk("final") } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("the proof is a portable pack: format fields, the same digest as before, and a note about transactions", async () => {
  const p = await getPack("job-1");
  assert.equal(p.format, PROOF_FORMAT); assert.equal(p.formatVersion, 1);
  assert.equal(p.digest.value, createHash("sha256").update(canonicalJson(p.facts), "utf8").digest("hex"), "the digest is the same SHA-256 the summary always had");
  assert.equal(p.digest.value, await proofDigest(p.facts));
  assert.ok(p.notes.some((n: string) => /transaction hashes/.test(n)));
  assert.ok(!JSON.stringify(p).includes("evidenceExcerpt"), "quotes from third-party pages stay out of the pack");
});

test("a fresh pack verifies against the contract; without a reader it is only consistent", async () => {
  const p = await getPack("job-1");
  const full = await verifyProofPack(p, { reader });
  assert.equal(full.verdict, "verified"); assert.equal(full.jobId, "job-1");
  assert.deepEqual(full.checks.map((c) => c.status), ["pass", "pass", "pass", "pass", "pass", "pass"]);
  const offline = await verifyProofPack(p);
  assert.equal(offline.verdict, "consistent"); assert.equal(status(offline, "chain"), "skipped");
  assert.equal((await verifyProofPack(await getPack("job-1", true), { reader })).verdict, "verified", "the { success, data } answer works as it is");
  assert.match(full.caveat, /not a payment/);
});

test("a pack for a job that is still open verifies too, and a job that moved on is reported as changed, not as forged", async () => {
  const p = await getPack("job-2");
  assert.equal(p.final, false);
  assert.equal((await verifyProofPack(p, { reader })).verdict, "verified");
  await sim.directWrite(BOB, "accept_job", ["job-2"]);
  const later = await verifyProofPack(p, { reader });
  assert.equal(later.verdict, "mismatch"); assert.equal(status(later, "digest"), "pass");
  assert.match(later.checks.find((c) => c.id === "chain")!.detail, /may have changed legitimately/);
});

test("an altered file is caught by the digest; a forger who fixes the digest is caught by the contract", async () => {
  const p = await getPack("job-1");
  const edited = clone(p); edited.facts.job.title = "Something else";
  const r1 = await verifyProofPack(edited, { reader });
  assert.equal(r1.verdict, "mismatch"); assert.equal(status(r1, "digest"), "fail"); assert.equal(status(r1, "hashes"), "fail");

  const forged = clone(p); forged.facts.deliveries[0].overallStatus = forged.facts.deliveries[0].overallStatus === "VERIFIED" ? "NEEDS_REVISION" : "VERIFIED";
  forged.digest.value = await proofDigest(forged.facts);
  const r2 = await verifyProofPack(forged, { reader });
  assert.equal(r2.verdict, "mismatch"); assert.equal(status(r2, "digest"), "pass"); assert.equal(status(r2, "chain"), "fail");
  assert.match(r2.checks.find((c) => c.id === "chain")!.detail, /final|differ/);
  assert.equal((await verifyProofPack(forged)).verdict, "consistent", "offline alone cannot catch a careful forger: that is why --chain exists");
});

test("a pack for another contract, a self-contradicting pack and non-packs are refused", async () => {
  const p = await getPack("job-1");
  const other = clone(p); other.facts.contract.address = "0x" + "11".repeat(20); other.digest.value = await proofDigest(other.facts);
  assert.equal(status(await verifyProofPack(other), "contract"), "fail");
  const odd = clone(p); odd.final = !odd.final;
  assert.equal(status(await verifyProofPack(odd), "consistency"), "fail");
  const noHash = clone(p); noHash.facts.deliveries[0].evidenceHash = null; noHash.digest.value = await proofDigest(noHash.facts);
  assert.equal(status(await verifyProofPack(noHash), "consistency"), "fail");
  for (const junk of [null, 5, "x", [], {}, { facts: {} }]) assert.equal((await verifyProofPack(junk)).verdict, "invalid");
  const old = clone(p); delete old.format; delete old.formatVersion;
  const r = await verifyProofPack(old); assert.equal(r.verdict, "invalid"); assert.match(r.checks[0]!.detail, /older than 1\.8\.0/);
});

test("evidence is opt-in, goes through the given fetch, and a changed page warns without contradicting the pack", async () => {
  const p = await getPack("job-1"); let asked: string[] = [];
  const fakeFetch = (async (u: string) => { asked.push(u); return new Response("not the same bytes", { status: 200 }); }) as unknown as typeof fetch;
  await verifyProofPack(p, { reader, fetch: fakeFetch }); assert.deepEqual(asked, []);
  const r = await verifyProofPack(p, { reader, checkEvidence: true, fetch: fakeFetch });
  assert.deepEqual(asked, ["https://example.com/logo-package"]);
  assert.equal(status(r, "evidence"), "warn"); assert.equal(r.verdict, "verified");
});

test("the CLI verifies a saved file: offline and against the contract; exit 1 on a bad pack", async () => {
  const p = await getPack("job-1"); const files: Record<string, string> = { "good.json": JSON.stringify(p), "env.json": JSON.stringify(await getPack("job-1", true)), "bad.json": JSON.stringify({ ...p, facts: { ...p.facts, job: { ...p.facts.job, title: "Nope" } } }), "junk.json": "not json" };
  const go = async (args: string[], extra: Record<string, unknown> = {}) => {
    const out: string[] = [], err: string[] = [];
    const code = await run(args, { fetch, out: (s) => out.push(s), err: (s) => err.push(s), env: {}, readFile: async (f) => { if (!(f in files)) throw new Error("ENOENT"); return files[f]!; }, ...extra });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const chainReader = async () => reader;
  let r = await go(["verify", "good.json"]); assert.equal(r.code, 0); assert.match(r.out, /CONSISTENT/); assert.match(r.out, /NOT read/);
  r = await go(["verify", "good.json", "--chain"], { chainReader }); assert.equal(r.code, 0); assert.match(r.out, /^VERIFIED: job-1/);
  r = await go(["verify", "env.json", "--chain", "--json"], { chainReader }); assert.equal(JSON.parse(r.out).verdict, "verified");
  r = await go(["verify", "bad.json", "--chain"], { chainReader }); assert.equal(r.code, 1); assert.match(r.out, /MISMATCH/); assert.match(r.out, /✗ digest/);
  r = await go(["verify", "junk.json"]); assert.equal(r.code, 3);
  r = await go(["verify", "missing.json"]); assert.equal(r.code, 3); assert.match(r.err, /Could not read/);
  r = await go(["verify"]); assert.equal(r.code, 2);
  r = await go(["verify", "good.json", "--chain"]); assert.equal(r.code, 3); assert.match(r.err, /--chain/);
});

test("the verify page offers the pack as a download and points at the offline check", async () => {
  const html = await (await fetch(`${api}/verify/job-1`)).text();
  assert.match(html, /href="\/v1\/jobs\/job-1\/proof" download="allocyn-proof-job-1\.json"/);
  assert.match(html, /allocyn verify proof\.json --chain/);
});

test("the built CLI bundle verifies a file and standard input with plain node (--chain is not tested here: it needs the live network)", async () => {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../cli");
  execFileSync(process.execPath, [path.join(cli, "scripts/build.mjs")], { stdio: "pipe" });
  const bin = path.join(cli, "dist/cli.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-")); const file = path.join(dir, "proof.json");
  const p = await getPack("job-1"); fs.writeFileSync(file, JSON.stringify(p));
  const exec = (args: string[], input?: string) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn(process.execPath, [bin, ...args]); let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code, out })); if (input !== undefined) c.stdin.end(input); else c.stdin.end();
  });
  const a = await exec(["verify", file]); assert.equal(a.code, 0); assert.match(a.out, /CONSISTENT: job-1/);
  const b = await exec(["verify", "-"], JSON.stringify(p)); assert.equal(b.code, 0); assert.match(b.out, /CONSISTENT/);
  const bad = JSON.parse(JSON.stringify(p)); bad.facts.job.description = "changed";
  const c = await exec(["verify", "-"], JSON.stringify(bad)); assert.equal(c.code, 1); assert.match(c.out, /MISMATCH/);
  fs.rmSync(dir, { recursive: true });
});
