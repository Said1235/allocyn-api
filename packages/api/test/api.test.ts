import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createAllocynClient } from "@allocyn/sdk";
import { SimContract } from "../../sdk/src/core/contract/sim.ts";
import { createApiServer } from "../src/server.ts";
import { loadConfig, ConfigError } from "../src/config.ts";
import type { ApiConfig } from "../src/config.ts";
import { buildOpenApi } from "../src/openapi.ts";
import { ROUTES } from "../src/routes.ts";
import { validate } from "./schema.ts";
import { canonicalJson } from "../src/proof.ts";
import { renderBadge } from "../src/badge.ts";
import { createHash } from "node:crypto";

const ALICE = "0x" + "a1".repeat(20);
const BOB = "0x" + "b2".repeat(20);
const sim = new SimContract();
let server: http.Server; let base: string; let cfg: ApiConfig; let spec: any;
let clock = 1_000_000;

const mkCfg = (over: Partial<ApiConfig> = {}): ApiConfig => ({ ...loadConfig({ NODE_ENV: "test", CORS_ORIGINS: "https://app.example" }), ...over });

async function start(c: ApiConfig, docs?: Parameters<typeof createApiServer>[0]["docs"]) {
  const mk = (readConsistency: "latest" | "final") => createAllocynClient({ gateway: sim, actor: null, readConsistency });
  const s = createApiServer({ config: c, clients: { latest: await mk("latest"), final: await mk("final") }, now: () => clock, ...(docs ? { docs } : {}) });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}
const get = async (p: string, init: RequestInit = {}) => {
  const res = await fetch(base + p, init);
  const text = await res.text();
  return { res, text, json: text ? JSON.parse(text) : null };
};

before(async () => {
  await sim.directWrite(ALICE, "create_job", ["Logo files", "The studio logo as vector files.", ["Delivered as SVG", "Includes a usage guide"]]);
  await sim.directWrite(BOB, "accept_job", ["job-1"]);
  await sim.directWrite(BOB, "submit_delivery", ["job-1", "https://example.com/logo-package"]);
  await sim.directWrite(BOB, "evaluate_delivery", ["rcpt-1"]);
  await sim.directWrite(ALICE, "create_job", ["Second", "An open job.", ["First check", "Second check"]]);
  cfg = mkCfg();
  const st = await start(cfg); server = st.s; base = st.url;
  spec = buildOpenApi(cfg);
});
after(() => server.close());

const SAMPLE: Record<string, string> = {
  "/v1/health": "/v1/health", "/v1/meta": "/v1/meta", "/v1/limits": "/v1/limits",
  "/v1/jobs/{jobId}": "/v1/jobs/job-1",
  "/v1/jobs/{jobId}/proof": "/v1/jobs/job-1/proof",
  "/v1/jobs/{jobId}/badge.svg": "/v1/jobs/job-1/badge.svg",
  "/v1/jobs/{jobId}/receipts": "/v1/jobs/job-1/receipts",
  "/v1/jobs/{jobId}/receipts/{deliveryIndex}": "/v1/jobs/job-1/receipts/1",
  "/v1/receipts/{receiptId}": "/v1/receipts/rcpt-1",
  "/v1/transactions/{txHash}": "/v1/transactions/0x" + "1".repeat(64),
};

test("every route returns the uniform success envelope and matches its OpenAPI schema", async () => {
  for (const r of ROUTES) {
    const url = SAMPLE[r.path]!;
    let target = url;
    if (r.path.startsWith("/v1/transactions")) {
      sim.connectAs(ALICE);
      const hash = await sim.send("create_job", ["Tx probe", "A probe job.", ["First check", "Second check"]]);
      await sim.getTx(hash); await sim.getTx(hash); await sim.getTx(hash);
      target = `/v1/transactions/${hash}`;
      sim.connectAs(null);
    }
    if (r.contentType) {
      const res = await fetch(base + target);
      assert.equal(res.status, 200, r.path);
      assert.equal(res.headers.get("content-type"), r.contentType);
      assert.ok(res.headers.get("x-request-id"));
      assert.ok(spec.paths[r.path].get.responses["200"].content[r.contentType], `${r.path} documents its media type`);
      assert.match(await res.text(), /^<svg /);
      continue;
    }
    const { res, json } = await get(target);
    assert.equal(res.status, 200, `${r.path} -> ${res.status} ${JSON.stringify(json)}`);
    assert.equal(json.success, true);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.ok(res.headers.get("x-request-id"));
    const op = spec.paths[r.path][r.method.toLowerCase()];
    const schema = op.responses["200"].content["application/json"].schema;
    assert.deepEqual(validate(schema, json, spec), [], r.path);
  }
});

test("OpenAPI paths are exactly the implemented routes, and every documented status is declared", () => {
  assert.equal(spec.openapi, "3.1.0");
  assert.deepEqual(Object.keys(spec.paths).sort(), ROUTES.map((r) => r.path).sort());
  for (const r of ROUTES) {
    const op = spec.paths[r.path][r.method.toLowerCase()];
    assert.equal(op.operationId, r.operationId);
    const inPath = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(op.parameters.filter((p: any) => p.in === "path").map((p: any) => p.name).sort(), inPath);
    for (const s of r.errors) assert.ok(op.responses[String(s)], `${r.path} declares ${s}`);
  }
  assert.ok(Object.keys(spec.paths).every((p) => !JSON.stringify(spec.paths[p]).includes('"post"')));
});

test("served /openapi.json equals the generated document", async () => {
  const { json } = await get("/openapi.json");
  assert.deepEqual(json, JSON.parse(JSON.stringify(spec)));
});

test("job and receipt content comes from the contract", async () => {
  const { json: job } = await get("/v1/jobs/job-1");
  assert.equal(job.data.status, "VERIFIED");
  assert.equal(job.data.worker, BOB);
  assert.equal(job.data.integrity.agreementHashMatches, true);
  const { json: list } = await get("/v1/jobs/job-1/receipts");
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].status, "EVALUATED");
  const { json: open } = await get("/v1/jobs/job-2");
  assert.equal(open.data.status, "OPEN");
  assert.equal(open.data.worker, null);
  assert.deepEqual((await get("/v1/jobs/job-2/receipts")).json.data, []);
});

test("meta states the API cannot write", async () => {
  const { json } = await get("/v1/meta");
  assert.equal(json.data.canWrite, false);
  assert.equal(json.data.actor, null);
  assert.equal(json.data.network.chainId, 61999);
  assert.equal(json.data.contractProfile.limitsSource, "audited-source");
});

test("not found and validation errors use the error envelope with proper codes", async () => {
  const cases: [string, number, string][] = [
    ["/v1/jobs/job-99", 404, "JOB_NOT_FOUND"],
    ["/v1/receipts/rcpt-99", 404, "RECEIPT_NOT_FOUND"],
    ["/v1/jobs/job-1/receipts/2", 404, "RECEIPT_NOT_FOUND"],
    ["/v1/jobs/job-0", 400, "INVALID_ARGUMENT"],
    ["/v1/jobs/abc", 400, "INVALID_ARGUMENT"],
    ["/v1/jobs/job-1/receipts/0", 400, "INVALID_ARGUMENT"],
    ["/v1/jobs/job-1/receipts/1.5", 400, "INVALID_ARGUMENT"],
    ["/v1/receipts/job-1", 400, "INVALID_ARGUMENT"],
    ["/v1/transactions/0x12", 400, "INVALID_ARGUMENT"],
    ["/v1/jobs/job-1?consistency=fast", 400, "INVALID_ARGUMENT"],
    ["/v1/jobs/job-1?foo=1", 400, "INVALID_ARGUMENT"],
    ["/v1/nope", 404, "NOT_FOUND"],
    ["/v1/jobs/%E0%A4%A", 400, "INVALID_ARGUMENT"],
  ];
  for (const [path, status, code] of cases) {
    const { res, json } = await get(path);
    assert.equal(res.status, status, path);
    assert.equal(json.success, false, path);
    assert.equal(json.error.code, code, path);
    assert.deepEqual(validate({ $ref: "#/components/schemas/ErrorResponse" }, json, spec), [], path);
    assert.ok(!/at .*\.ts|node_modules|stack/i.test(JSON.stringify(json)), "no stack traces");
  }
});

test("writes are refused: every non-GET method is 405 and nothing is sent", async () => {
  const sent = sim.sendCount;
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
    const { res, json } = await get("/v1/jobs", { method: m, body: m === "DELETE" ? undefined : "{}" });
    assert.ok([404, 405].includes(res.status));
    void json;
    const r2 = await get("/v1/jobs/job-1", { method: m, body: m === "DELETE" ? undefined : "{}" });
    assert.equal(r2.res.status, 405);
    assert.equal(r2.json.error.code, "METHOD_NOT_ALLOWED");
    assert.match(r2.res.headers.get("allow") ?? "", /GET/);
  }
  assert.equal(sim.sendCount, sent);
});

test("consistency=final is accepted and echoed; default comes from config", async () => {
  const f = await get("/v1/jobs/job-1?consistency=final");
  assert.equal(f.res.status, 200);
  assert.equal(f.res.headers.get("x-allocyn-consistency"), "final");
  assert.equal((await get("/v1/jobs/job-1")).res.headers.get("x-allocyn-consistency"), "latest");
});

test("upstream failures are 502 and retryable, with no internals leaked", async () => {
  sim.callError = new Error("fetch failed: ECONNREFUSED 10.0.0.5:443 secret-host");
  const { res, json } = await get("/v1/jobs/job-1");
  sim.callError = null;
  assert.equal(res.status, 502);
  assert.equal(json.error.code, "UPSTREAM_UNAVAILABLE");
  assert.equal(json.error.retryable, true);
  assert.ok(!JSON.stringify(json).includes("secret-host"));
});

test("health: shallow is always ok; deep reports the chain and 503s when it is down", async () => {
  assert.equal((await get("/v1/health")).json.data.status, "ok");
  const deep = await get("/v1/health?deep=true");
  assert.equal(deep.json.data.checks.chain, "ok");
  sim.callError = new Error("down");
  const down = await get("/v1/health?deep=true");
  sim.callError = null;
  assert.equal(down.res.status, 503);
  assert.equal(down.json.error.code, "UPSTREAM_UNAVAILABLE");
});

test("CORS: allowed origin echoed, other origins get no allow header, preflight is 204", async () => {
  const ok = await get("/v1/meta", { headers: { Origin: "https://app.example" } });
  assert.equal(ok.res.headers.get("access-control-allow-origin"), "https://app.example");
  const no = await get("/v1/meta", { headers: { Origin: "https://evil.example" } });
  assert.equal(no.res.headers.get("access-control-allow-origin"), null);
  const pre = await fetch(base + "/v1/jobs/job-1", { method: "OPTIONS", headers: { Origin: "https://app.example", "Access-Control-Request-Method": "GET" } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-methods") ?? "", /GET/);
});

test("rate limiting returns 429 with Retry-After, then recovers after the window", async () => {
  const c = mkCfg({ rateLimit: { max: 3, windowMs: 60000 } });
  const st = await start(c);
  try {
    const hit = () => fetch(st.url + "/v1/meta");
    for (let i = 0; i < 3; i++) assert.equal((await hit()).status, 200);
    const r = await hit();
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) >= 1);
    const body = await r.json() as any;
    assert.equal(body.error.code, "RATE_LIMITED");
    assert.equal(body.error.retryable, true);
    clock += 61000;
    assert.equal((await hit()).status, 200);
  } finally { st.s.close(); }
});

test("a slow upstream becomes 504 after the request timeout", async () => {
  const c = mkCfg({ requestTimeoutMs: 30 });
  const slow = new SimContract(); await slow.directWrite(ALICE, "create_job", ["T", "d", ["aa check", "bb check"]]);
  const orig = slow.call.bind(slow);
  slow.call = async (m, a) => { await new Promise((r) => setTimeout(r, 200)); return orig(m, a); };
  const mk = (rc: "latest" | "final") => createAllocynClient({ gateway: slow, actor: null, readConsistency: rc });
  const s = createApiServer({ config: c, clients: { latest: await mk("latest"), final: await mk("final") }, now: () => clock });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/v1/jobs/job-1`);
    assert.equal(res.status, 504);
    assert.equal(((await res.json()) as any).error.code, "UPSTREAM_TIMEOUT");
  } finally { s.close(); }
});

test("docs are served under /docs/, path traversal is refused, / redirects", async () => {
  const docs = (p: string) => (p === "/docs/" ? { status: 200, type: "text/html", body: "<h1>docs</h1>" } : null);
  const st = await start(mkCfg(), docs);
  try {
    assert.equal(await (await fetch(st.url + "/docs/")).text(), "<h1>docs</h1>");
    const r = await fetch(st.url + "/", { redirect: "manual" });
    assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "/docs/");
    const t = await fetch(st.url + "/docs/..%2f..%2fetc%2fpasswd");
    assert.equal(t.status, 404);
  } finally { st.s.close(); }
});

test("config: safe defaults, production needs explicit CORS, secrets are refused", () => {
  const d = loadConfig({});
  assert.equal(d.network, "studionet"); assert.deepEqual(d.corsOrigins, ["*"]);
  assert.throws(() => loadConfig({ NODE_ENV: "production", CORS_ORIGINS: "*" }), ConfigError);
  assert.deepEqual(loadConfig({ NODE_ENV: "production" }).corsOrigins, []);
  assert.throws(() => loadConfig({ PRIVATE_KEY: "0xabc" }), /never uses private keys/);
  assert.throws(() => loadConfig({ GENLAYER_NETWORK: "mainnet" }), ConfigError);
  assert.throws(() => loadConfig({ ALLOCYN_CONTRACT_ADDRESS: "nope" }), ConfigError);
  assert.throws(() => loadConfig({ GENLAYER_RPC_URL: "https://other.example" }), /preset/);
  assert.throws(() => loadConfig({ RATE_LIMIT_MAX: "0" }), ConfigError);
  assert.equal(loadConfig({ GENLAYER_RPC_URL: "https://studio.genlayer.com/api/" }).network, "studionet");
});

test("/v1/limits reads get_limits from the contract and flags a mismatch with the pinned copy", async () => {
  const ok = await get("/v1/limits");
  assert.equal(ok.json.data.source, "contract");
  assert.equal(ok.json.data.matchesPinned, true);
  assert.equal(ok.json.data.contract.maxCriteria, 20);
  assert.equal(ok.json.data.client.maxCriteria, 5);

  const other = new SimContract();
  other.limitsOverride = { max_criteria: 40 };
  const mk = (rc: "latest" | "final") => createAllocynClient({ gateway: other, actor: null, readConsistency: rc, limitsTtlMs: 0 });
  const st = createApiServer({ config: mkCfg(), clients: { latest: await mk("latest"), final: await mk("final") }, now: () => clock });
  await new Promise<void>((r) => st.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(st.address() as AddressInfo).port}/v1/limits`);
    const j = await res.json() as any;
    assert.equal(j.data.matchesPinned, false);
    assert.deepEqual(j.data.differences, ["maxCriteria"]);
    assert.equal(j.data.contract.maxCriteria, 40);
    assert.equal(j.data.pinned.maxCriteria, 20);
  } finally { st.close(); }
});

test("/v1/limits is a 502 when the address is not an Allocyn contract (no get_limits)", async () => {
  const other = new SimContract();
  const orig = other.call.bind(other);
  other.call = async (m, a) => { if (m === "get_limits") throw new Error("method get_limits not found"); return orig(m, a); };
  const mk = (rc: "latest" | "final") => createAllocynClient({ gateway: other, actor: null, readConsistency: rc });
  const st = createApiServer({ config: mkCfg(), clients: { latest: await mk("latest"), final: await mk("final") }, now: () => clock });
  await new Promise<void>((r) => st.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(st.address() as AddressInfo).port}/v1/limits`);
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as any).success, false);
  } finally { st.close(); }
});

test("proof: facts come from the contract, the digest recomputes, excerpts stay out, open jobs are not final", async () => {
  const { json } = await get("/v1/jobs/job-1/proof");
  const p = json.data;
  assert.equal(p.status, "VERIFIED"); assert.equal(p.final, true);
  assert.equal(p.facts.job.worker, BOB); assert.equal(p.facts.deliveries.length, 1);
  assert.equal(p.facts.deliveries[0].results.length, 2);
  assert.equal(p.digest.value, createHash("sha256").update(canonicalJson(p.facts), "utf8").digest("hex"));
  assert.ok(!JSON.stringify(p).includes("evidenceExcerpt"), "quotes from third-party pages are not part of the proof");
  assert.match(p.contractUrl, /^https:\/\/.+\/address\/0x[0-9a-fA-F]{40}$/);
  assert.ok(p.notes.some((n: string) => /not a signature/.test(n)) && p.notes.some((n: string) => /not a payment/.test(n)));
  // the same facts always hash the same, whatever the key order
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  const open = (await get("/v1/jobs/job-2/proof")).json.data;
  assert.equal(open.status, "OPEN"); assert.equal(open.final, false); assert.deepEqual(open.facts.deliveries, []);
  assert.equal((await get("/v1/jobs/job-99/proof")).res.status, 404);
  assert.equal((await get("/v1/jobs/job-1/proof?consistency=final")).res.status, 200);
  assert.equal((await get("/v1/jobs/job-1/proof?x=1")).res.status, 400);
});

test("badge: shows the status, escapes text, and errors are badges with the right status code", async () => {
  const ok = await fetch(base + "/v1/jobs/job-1/badge.svg");
  const svg = await ok.text();
  assert.equal(ok.status, 200); assert.match(ok.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(svg, />verified</); assert.match(svg, /aria-label="allocyn job-1: verified"/);
  assert.ok(!/<script|href=|javascript:/i.test(svg));
  assert.match(await (await fetch(base + "/v1/jobs/job-2/badge.svg")).text(), />open</);
  const missing = await fetch(base + "/v1/jobs/job-99/badge.svg");
  assert.equal(missing.status, 404); assert.equal(missing.headers.get("content-type"), "image/svg+xml"); assert.match(await missing.text(), /job not found/);
  const bad = await fetch(base + "/v1/jobs/job-0/badge.svg");
  assert.equal(bad.status, 400); assert.match(await bad.text(), /invalid job id/);
  const head = await fetch(base + "/v1/jobs/job-1/badge.svg", { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(await head.text(), "");
  const nasty = renderBadge("a<b", '"x"&y', "ok", "t<i>tle");
  assert.ok(!nasty.includes("a<b") && !nasty.includes("<i>") && nasty.includes("&quot;x&quot;&amp;y") && nasty.includes("t&lt;i&gt;tle"), "badge text is escaped");
  assert.match(renderBadge("a<b", "m", "ok", "t"), /a&lt;b/);
  assert.equal((await fetch(base + "/v1/jobs/job-1/badge.svg", { method: "POST" })).status, 405);
});
