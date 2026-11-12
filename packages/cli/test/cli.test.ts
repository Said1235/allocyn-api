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
