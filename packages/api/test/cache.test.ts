import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createAllocynClient } from "@allocyn/sdk";
import { SimContract } from "../../sdk/src/core/contract/sim.ts";
import { createApiServer } from "../src/server.ts";
import { loadConfig, ConfigError } from "../src/config.ts";
import type { ApiConfig } from "../src/config.ts";
import { RateLimiter, SharedRateLimiter } from "../src/ratelimit.ts";

const ALICE = "0x" + "a1".repeat(20);
const BOB = "0x" + "b2".repeat(20);
const sim = new SimContract();
let reads = 0;
// Counts every read of the contract, so a cached answer is visible as "no extra read".
const spy: SimContract = Object.create(sim);
spy.call = async (m: string, a: readonly unknown[]) => { reads++; return sim.call(m, a); };
let clock = 5_000_000;

async function start(cfg: ApiConfig, extra: Partial<Parameters<typeof createApiServer>[0]> = {}) {
  const mk = (c: "latest" | "final") => createAllocynClient({ gateway: spy, actor: null, readConsistency: c });
  const s = createApiServer({ config: cfg, clients: { latest: await mk("latest"), final: await mk("final") }, now: () => clock, ...extra });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}
let server: http.Server; let base: string;

before(async () => {
  await sim.directWrite(ALICE, "create_job", ["Logo files", "The studio logo as vector files.", ["Delivered as SVG", "Includes a usage guide"]]);
  await sim.directWrite(BOB, "accept_job", ["job-1"]);
  await sim.directWrite(BOB, "submit_delivery", ["job-1", "https://example.com/logo-package"]);
  await sim.directWrite(BOB, "evaluate_delivery", ["rcpt-1"]);
  await sim.directWrite(ALICE, "create_job", ["Second", "An open job.", ["First check", "Second check"]]);
  await sim.directWrite(ALICE, "create_job", ["Third", "A job with a pending delivery.", ["First check", "Second check"]]);
  await sim.directWrite(BOB, "accept_job", ["job-3"]);
  await sim.directWrite(BOB, "submit_delivery", ["job-3", "https://example.com/pending"]);
  const st = await start(loadConfig({ NODE_ENV: "test", RATE_LIMIT_MAX: "1000" })); server = st.s; base = st.url;
});
after(() => server.close());

test("ETag: an unchanged answer is a 304 with no body, a changed one is a full 200", async () => {
  const a = await fetch(base + "/v1/jobs/job-2");
  const etag = a.headers.get("etag")!;
  assert.match(etag, /^W\/"[0-9a-f]{24}"$/); assert.equal(a.headers.get("cache-control"), "no-cache");
  await a.text();
  const b = await fetch(base + "/v1/jobs/job-2", { headers: { "If-None-Match": etag } });
  assert.equal(b.status, 304); assert.equal(await b.text(), ""); assert.equal(b.headers.get("etag"), etag);
  const star = await fetch(base + "/v1/jobs/job-2", { headers: { "If-None-Match": "*" } });
  assert.equal(star.status, 304);
  const other = await fetch(base + "/v1/jobs/job-2", { headers: { "If-None-Match": 'W/"nope"' } });
  assert.equal(other.status, 200); assert.equal((await other.json()).data.id, "job-2");
  // a different job has a different tag
  const j1 = await fetch(base + "/v1/jobs/job-1"); await j1.text();
  assert.notEqual(j1.headers.get("etag"), etag);
  // not-found answers are not cached by the client
  const nf = await fetch(base + "/v1/jobs/job-99");
  assert.equal(nf.status, 404); assert.equal(nf.headers.get("cache-control"), "no-store"); assert.equal(nf.headers.get("etag"), null);
});

test("final reads of final data are cached by the server and by clients; everything else is revalidated", async () => {
  const first = await fetch(base + "/v1/jobs/job-1?consistency=final");
  assert.equal(first.headers.get("x-allocyn-cache"), "miss"); assert.equal(first.headers.get("cache-control"), "public, max-age=300");
  const body = await first.text();
  const before = reads;
  const second = await fetch(base + "/v1/jobs/job-1?consistency=final");
  assert.equal(second.headers.get("x-allocyn-cache"), "hit"); assert.equal(await second.text(), body);
  assert.equal(reads, before, "a cache hit reads nothing from the contract");
  // the proof of a final job is cached the same way
  await (await fetch(base + "/v1/jobs/job-1/proof?consistency=final")).text();
  const p2 = await fetch(base + "/v1/jobs/job-1/proof?consistency=final"); await p2.text();
  assert.equal(p2.headers.get("x-allocyn-cache"), "hit");
  // 'latest' may include non-finalized state: never cached for long
  const latest = await fetch(base + "/v1/jobs/job-1"); await latest.text();
  assert.equal(latest.headers.get("cache-control"), "no-cache"); assert.equal(latest.headers.get("x-allocyn-cache"), null);
  // an open job and a pending receipt can still change: never cached
  for (const p of ["/v1/jobs/job-2?consistency=final", "/v1/receipts/rcpt-2?consistency=final"]) {
    const a = await fetch(base + p); await a.text();
    const r0 = reads;
    const b = await fetch(base + p); await b.text();
    assert.equal(a.headers.get("cache-control"), "no-cache", p); assert.equal(b.headers.get("x-allocyn-cache"), "miss", p);
    assert.ok(reads > r0, `${p} is read again`);
  }
  // an evaluated receipt cannot change
  await (await fetch(base + "/v1/receipts/rcpt-1?consistency=final")).text();
  assert.equal((await fetch(base + "/v1/receipts/rcpt-1?consistency=final")).headers.get("x-allocyn-cache"), "hit");
});

test("the server's cache entries expire after an hour", async () => {
  await (await fetch(base + "/v1/jobs/job-1?consistency=final")).text();
  clock += 3_600_001;
  const r = await fetch(base + "/v1/jobs/job-1?consistency=final"); await r.text();
  assert.equal(r.headers.get("x-allocyn-cache"), "miss");
});

test("badge and health keep their own rules", async () => {
  const b = await fetch(base + "/v1/jobs/job-1/badge.svg"); await b.text();
  assert.equal(b.headers.get("cache-control"), "public, max-age=60"); assert.ok(b.headers.get("etag"));
  const h = await fetch(base + "/v1/health"); await h.text();
  assert.equal(h.headers.get("cache-control"), "no-store");
});

/* ------------------------------ shared rate limit ------------------------------ */

function fakeStore() {
  const counts = new Map<string, number>(); const calls: any[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const cmds = JSON.parse(String(init.body)) as string[][];
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization, cmds });
    const key = cmds[0]![1]!; counts.set(key, (counts.get(key) ?? 0) + 1);
    return new Response(JSON.stringify([{ result: counts.get(key) }, { result: 1 }]), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, counts, calls };
}
const storeEnv = { NODE_ENV: "test", RATE_LIMIT_MAX: "3", UPSTASH_REDIS_REST_URL: "https://store.example.upstash.io", UPSTASH_REDIS_REST_TOKEN: "tok" };

test("shared rate limit: two API instances count together, and the client address is stored hashed", async () => {
  const store = fakeStore();
  const a = await start(loadConfig(storeEnv), { fetch: store.fn });
  const b = await start(loadConfig(storeEnv), { fetch: store.fn });
  try {
    const codes: number[] = [];
    for (const u of [a.url, b.url, a.url, b.url, a.url]) codes.push((await fetch(u + "/v1/meta")).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429], "limit 3 holds across both instances");
    const r = await fetch(b.url + "/v1/meta"); assert.equal(r.status, 429); assert.ok(Number(r.headers.get("retry-after")) >= 1);
    assert.match(store.calls[0].url, /\/pipeline$/); assert.equal(store.calls[0].auth, "Bearer tok");
    assert.equal(store.calls[0].cmds[0][0], "INCR");
    assert.ok(![...store.counts.keys()].some((k) => k.includes("127.0.0.1")), "no raw address in the store");
  } finally { a.s.close(); b.s.close(); }
});

test("shared rate limit: if the store fails, the in-memory limiter takes over and the API stays up", async () => {
  const logs: any[] = [];
  const dead = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
  const a = await start(loadConfig(storeEnv), { fetch: dead, log: (l) => logs.push(l) });
  try {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(a.url + "/v1/meta")).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    assert.ok(logs.some((l) => l.level === "warn" && /store unavailable/.test(l.message)));
    const bad = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const lim = new SharedRateLimiter({ url: "https://s.example", token: "t", max: 2, windowMs: 1000, now: () => 0, fallback: new RateLimiter(2, 1000, () => 0), fetch: bad });
    assert.equal((await lim.check("k")).allowed, true);
  } finally { a.s.close(); }
});

test("config: the store needs both URL and token, and https", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "test", UPSTASH_REDIS_REST_URL: "https://x.example" }), ConfigError);
  assert.throws(() => loadConfig({ NODE_ENV: "test", UPSTASH_REDIS_REST_TOKEN: "t" }), ConfigError);
  assert.throws(() => loadConfig({ NODE_ENV: "test", UPSTASH_REDIS_REST_URL: "http://x.example", UPSTASH_REDIS_REST_TOKEN: "t" }), ConfigError);
  assert.equal(loadConfig({ NODE_ENV: "test" }).rateLimitStore, null);
  assert.deepEqual(loadConfig({ NODE_ENV: "test", KV_REST_API_URL: "https://x.example", KV_REST_API_TOKEN: "t" }).rateLimitStore, { url: "https://x.example", token: "t" });
  assert.throws(() => loadConfig({ NODE_ENV: "test", PRIVATE_KEY: "0xabc" }), ConfigError);
});
