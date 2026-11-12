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
import { createApiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { ROUTES } from "../src/routes.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const exec = promisify(execFile);
const ALICE = "0x" + "a1".repeat(20), BOB = "0x" + "b2".repeat(20);
const sim = new SimContract();
let server: http.Server; let api: string;
const hasPython = (() => { try { execFileSync("python3", ["--version"], { stdio: "pipe" }); return true; } catch { return false; } })();
const opts = { skip: hasPython ? false : "python3 is not installed" };

before(async () => {
  await sim.directWrite(ALICE, "create_job", ["Logo files", "The studio logo as vector files.", ["Delivered as SVG", "Includes a usage guide"]]);
  await sim.directWrite(BOB, "accept_job", ["job-1"]);
  await sim.directWrite(BOB, "submit_delivery", ["job-1", "https://example.com/logo-package"]);
  await sim.directWrite(BOB, "evaluate_delivery", ["rcpt-1"]);
  await sim.directWrite(ALICE, "create_job", ["Second", "An open job.", ["First check", "Second check"]]);
  const mk = (c: "latest" | "final") => createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
  server = createApiServer({ config: loadConfig({ NODE_ENV: "test", RATE_LIMIT_MAX: "1000" }), clients: { latest: await mk("latest"), final: await mk("final") }, waitPollMs: 40 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("the committed Python client is exactly what the route table generates, and has a method per route", () => {
  const out = execFileSync(process.execPath, [path.join(root, "scripts/gen-python-client.mjs"), "--check"], { stdio: "pipe" }).toString();
  assert.match(out, /up to date/);
  const src = execFileSync("cat", [path.join(root, "clients/python/allocyn_api.py")]).toString();
  for (const r of ROUTES) assert.ok(src.includes(`def ${r.operationId.replace(/([A-Z])/g, "_$1").toLowerCase()}(`), r.operationId);
  assert.ok(!/\bPOST\b|method="POST"|data=/.test(src), "the client cannot write");
});

test("python: reads, lists, waits, badges and typed errors work against the real server", opts, async () => {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(root, "clients/python"))})
from allocyn_api import AllocynApi, AllocynApiError
api = AllocynApi(${JSON.stringify(api)}, consistency="final")
out = {}
out["job"] = api.get_job("job-1")["status"]
out["receipt"] = api.get_job_receipt_by_index("job-1", 1)["id"]
out["receipts"] = len(api.list_job_receipts("job-1"))
out["open"] = [j["id"] for j in api.list_jobs(status="OPEN", limit=5)["items"]]
out["proof"] = api.get_job_proof("job-1")["final"]
out["badge"] = "verified" in api.get_job_badge("job-1")
out["limits"] = api.get_limits()["source"]
out["health"] = api.get_health(deep=True)["checks"]["chain"]
v = api.wait_for_job("job-1")["version"]
out["wait"] = [len(v), api.wait_for_job("job-1", since=v, timeout=1)["changed"]]
try:
    api.get_job("job-99")
except AllocynApiError as e:
    out["notfound"] = [e.status, e.code, e.retryable]
try:
    api.list_jobs(limit=0)
except AllocynApiError as e:
    out["badarg"] = [e.code, e.field]
try:
    api.get_job_badge("job-99")
except AllocynApiError as e:
    out["badge404"] = [e.status, e.code]
try:
    AllocynApi("http://127.0.0.1:1").get_meta()
except AllocynApiError as e:
    out["down"] = [e.code, e.retryable]
for bad in ("http://example.com", "not a url"):
    try:
        AllocynApi(bad)
    except ValueError:
        out.setdefault("badurl", 0); out["badurl"] += 1
print(json.dumps(out))
`;
  const { stdout } = await exec("python3", ["-I", "-c", script], { timeout: 60_000 });
  const r = JSON.parse(stdout);
  assert.deepEqual(r, {
    job: "VERIFIED", receipt: "rcpt-1", receipts: 1, open: ["job-2"], proof: true, badge: true, limits: "contract", health: "ok",
    wait: [16, false], notfound: [404, "JOB_NOT_FOUND", false], badarg: ["INVALID_ARGUMENT", "limit"], badge404: [404, "HTTP_404"],
    down: ["NETWORK_UNREACHABLE", true], badurl: 2,
  });
});
