import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createAllocynClient } from "@allocyn/sdk";
import { SimContract } from "../../sdk/src/core/contract/sim.ts";
import { createApiServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";

const ALICE = "0x" + "a1".repeat(20), BOB = "0x" + "b2".repeat(20);
const sim = new SimContract();
let server: http.Server; let base: string;

before(async () => {
  await sim.directWrite(ALICE, "create_job", ["Logo files", "The studio logo as vector files.", ["Delivered as SVG", "Includes a usage guide"]]);
  await sim.directWrite(BOB, "accept_job", ["job-1"]);
  await sim.directWrite(BOB, "submit_delivery", ["job-1", "https://example.com/logo-package"]);
  await sim.directWrite(BOB, "evaluate_delivery", ["rcpt-1"]);
  await sim.directWrite(ALICE, "create_job", ['<script>alert(1)</script> & "quotes"', "An open job.", ["<img src=x onerror=alert(1)>", "Second check"]]);
  const mk = (c: "latest" | "final") => createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
  server = createApiServer({ config: loadConfig({ NODE_ENV: "test", RATE_LIMIT_MAX: "1000" }), clients: { latest: await mk("latest"), final: await mk("final") } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("a verified job renders a readable page with status, criteria, deliveries and how to check it", async () => {
  const res = await fetch(`${base}/verify/job-1`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /text\/html/);
  const html = await res.text();
  assert.match(html, /<h1>Logo files<\/h1>/);
  assert.match(html, />VERIFIED</); assert.match(html, />final</);
  assert.match(html, /Delivered as SVG/); assert.match(html, />MET</);
  assert.match(html, /example\.com\/logo-package/);
  assert.match(html, /\/v1\/jobs\/job-1\/proof/); assert.match(html, /allocyn evidence rcpt-1/);
  assert.match(html, /not a payment, an escrow, a dispute resolution or a guarantee of quality/);
  assert.match(html, /<meta property="og:title" content="job-1 · VERIFIED · Allocyn">/);
  assert.match(res.headers.get("cache-control")!, /public, max-age=300/, "a final job may be cached");
});

test("nothing from the chain is ever interpreted as HTML, and the page ships a strict CSP with no script", async () => {
  const res = await fetch(`${base}/verify/job-2`);
  const html = await res.text();
  assert.ok(!html.includes("<script"), "no script tag at all");
  assert.ok(!html.includes("<img src=x"), "criteria text is escaped");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quotes&quot;/);
  assert.match(res.headers.get("content-security-policy")!, /default-src 'none'/);
  assert.ok(!/script-src/.test(res.headers.get("content-security-policy")!));
  assert.equal(res.headers.get("cache-control"), "no-cache", "a job that is not final is never cached");
  assert.match(html, /not judged yet/); assert.match(html, /not final/);
  assert.match(html, /name="robots" content="noindex,nofollow"/);
});

test("unknown and invalid ids give a friendly HTML error with the right status", async () => {
  const missing = await fetch(`${base}/verify/job-99`);
  assert.equal(missing.status, 404); assert.match(await missing.text(), /No such job/);
  const bad = await fetch(`${base}/verify/not-a-job`);
  assert.equal(bad.status, 400); assert.match(await bad.text(), /not a valid job id/);
  const xss = await fetch(`${base}/verify/${encodeURIComponent("<script>")}`);
  assert.ok(!(await xss.text()).includes("<script>"));
});

test("HEAD works, other methods are not served by this page", async () => {
  const head = await fetch(`${base}/verify/job-1`, { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(await head.text(), "");
  const post = await fetch(`${base}/verify/job-1`, { method: "POST" });
  assert.ok(post.status >= 400);
});
