import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES } from "../../packages/api/src/routes.ts";
import { CONTRACT_LIMITS, CONTRACT_PROFILE, NETWORKS } from "../../packages/sdk/src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "../dist");
const content = path.join(here, "../content");
const read = (f: string) => fs.readFileSync(path.join(dist, f), "utf8");
const md = (name: string) => fs.readFileSync(path.join(content, name), "utf8");
const SECTIONS = ["introduction", "quickstart", "core-concepts", "auth-wallets", "rest-reference", "sdk-reference", "agents-mcp", "cli-python", "lifecycle", "verification-results", "limits", "errors", "security-privacy", "networks", "examples", "faq", "deploy", "changelog"];

test("all required sections (the 15 requested plus Deploying) are built, in the sidebar of every page", () => {
  for (const s of SECTIONS) assert.ok(fs.existsSync(path.join(dist, `${s}.html`)), s);
  for (const s of SECTIONS) {
    const html = read(`${s}.html`);
    for (const t of SECTIONS) assert.ok(html.includes(`href="${t}.html"`), `${s} links ${t}`);
    assert.match(html, /id="q"/);
  }
});

test("code blocks have copy buttons", () => {
  for (const s of ["quickstart", "examples", "rest-reference"]) assert.match(read(`${s}.html`), /class="copy"/);
});

test("every internal link and anchor resolves", () => {
  const ids = new Map<string, Set<string>>();
  for (const s of SECTIONS) ids.set(s, new Set([...read(`${s}.html`).matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!)));
  for (const s of SECTIONS) {
    for (const m of read(`${s}.html`).matchAll(/href="([^"]+)"/g)) {
      const h = m[1]!;
      if (/^(https?:|\/|#|mailto:)/.test(h) && !h.startsWith("#")) continue;
      if (h.startsWith("#")) { assert.ok(ids.get(s)!.has(h.slice(1)), `${s}: ${h}`); continue; }
      if (/\.(css|png)$/.test(h)) { assert.ok(fs.existsSync(path.join(dist, h)), h); continue; }
      const [page, anchor] = h.split("#");
      const slug = page!.replace(/\.html$/, "");
      assert.ok(SECTIONS.includes(slug), `${s}: broken link ${h}`);
      if (anchor) assert.ok(ids.get(slug)!.has(anchor), `${s}: missing anchor ${h}`);
    }
  }
});

test("the REST reference documents exactly the implemented routes, and openapi.json matches", () => {
  const html = read("rest-reference.html");
  const documented = [...html.matchAll(/<span class="p">([^<]+)<\/span>/g)].map((m) => m[1]!.replace(/&amp;/g, "&")).sort();
  assert.deepEqual(documented, ROUTES.map((r) => r.path).sort());
  const spec = JSON.parse(read("openapi.json"));
  assert.deepEqual(Object.keys(spec.paths).sort(), ROUTES.map((r) => r.path).sort());
  assert.match(html, /simulated/i);
});

test("limits in the docs equal the contract limits the SDK enforces", () => {
  const t = md("09-limits.md");
  const L = CONTRACT_LIMITS;
  const f = (n: number) => n.toLocaleString("en-US");
  for (const needle of [
    `${L.minCriteria} to ${L.maxCriteria}`, `${f(L.maxTitleLength)} characters`, `${f(L.maxDescriptionLength)} characters`,
    `${f(L.maxCriterionLength)} characters`, `${f(L.maxUrlLength)} characters`, `${f(L.maxContentBytes)} bytes`,
    `${L.minEvidenceExcerptLength} to ${L.maxEvidenceExcerptLength}`,
  ]) assert.ok(t.includes(needle), `limits page mentions "${needle}"`);
  assert.match(t, new RegExp(`\\| Deliveries per job \\| ${L.maxDeliveriesPerJob} \\|`));
  assert.ok(t.includes(CONTRACT_PROFILE.sourceSha256.slice(0, 8)));
  assert.ok(t.includes("get_limits"));
});

test("no page still quotes the previous contract revision's numbers or address", () => {
  const all = SECTIONS.map((s) => read(`${s}.html`)).join("\n");
  for (const stale of ["0xA2aB53A0", "14d94364", "proof-of-work-intelligent-contract", "100,000 bytes", "8–200", "2–5 criteria"]) {
    assert.ok(!all.includes(stale), `stale text: ${stale}`);
  }
});

test("the networks page states the real network and contract", () => {
  const t = md("12-networks.md"), n = NETWORKS.studionet;
  for (const v of [String(n.chainId), n.rpcUrl, n.explorerUrl, n.contractAddress!]) assert.ok(t.includes(v), v);
});

test("the error page lists every SDK error code", () => {
  const src = fs.readFileSync(path.join(here, "../../packages/sdk/src/errors.ts"), "utf8");
  const union = /export type AllocynErrorCode =([\s\S]*?);/.exec(src)![1]!;
  const codes = [...union.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]!);
  const page = md("10-errors.md");
  // STALE_CONTEXT exists in the type but the SDK never passes the guard that raises it.
  for (const c of codes.filter((c) => c !== "STALE_CONTEXT")) assert.ok(page.includes("`" + c + "`"), c);
  for (const c of ["[EXPECTED]", "[EXTERNAL]", "[TRANSIENT]", "[LLM_ERROR]"]) assert.ok(page.includes(c), c);
});

test("honest-statements guard: the required disclaimers are present, no private-key requests", () => {
  const all = SECTIONS.map((s) => read(`${s}.html`)).join("\n");
  assert.match(md("01-introduction.md"), /not a payment or escrow system/i);
  assert.match(md("01-introduction.md"), /not dispute resolution/i);
  assert.match(md("01-introduction.md"), /not an objective measure of quality/i);
  assert.match(md("01-introduction.md"), /prompt injection/i);
  assert.match(md("04-auth-wallets.md"), /not implemented/i);
  assert.match(md("16-changelog.md"), /Not\*\* run against the live/);
  assert.ok(!/enter your (private key|seed phrase)/i.test(all));
  assert.ok(!/TODO|FIXME|lorem ipsum/i.test(all));
});

test("every code sample of the quickstart that calls the SDK uses methods that exist", () => {
  const known = ["createJob", "acceptJob", "submitDelivery", "evaluateDelivery", "getJob", "getJobReceipts", "getReceipt", "getReceiptByIndex", "getTransaction", "getMeta", "getLimits", "createAllocynClient", "isAllocynError"];
  const text = ["02-quickstart.md", "06-sdk-reference.md", "13-examples.md"].map(md).join("\n");
  for (const m of text.matchAll(/\b(?:allocyn|client|worker|svc)\.(\w+)\(/g)) assert.ok(known.includes(m[1]!), `unknown SDK method ${m[1]}`);
});

import { execFileSync } from "node:child_process";
const build = (env: Record<string, string>) => execFileSync(process.execPath, [path.join(here, "../build.mjs")], { env: { ...process.env, ALLOCYN_APP_URL: "", ALLOCYN_REPO_URL: "", ...env }, stdio: "pipe" });

test("landing: app and repo links appear only when configured, and must be https", () => {
  try {
    build({});
    let html = read("index.html");
    assert.match(html, /readable by any app or agent/);
    assert.ok(!/Open the app/.test(html), "no app button while appUrl is not configured");
    const cfg = JSON.parse(fs.readFileSync(path.join(here, "../site.config.json"), "utf8"));
    if (cfg.repoUrl) assert.ok(html.includes(`href="${cfg.repoUrl}"`) && html.includes("View on GitHub"), "the configured repository is linked");
    else assert.ok(!/View on GitHub/.test(html), "no dead placeholder links");
    build({ ALLOCYN_APP_URL: "https://app.example.org/", ALLOCYN_REPO_URL: "https://github.com/example/allocyn" });
    html = read("index.html");
    assert.ok(html.includes('href="https://app.example.org/"') && html.includes("Open the app"));
    assert.ok(html.includes('href="https://github.com/example/allocyn"') && html.includes("View on GitHub"));
    assert.throws(() => build({ ALLOCYN_APP_URL: "http://insecure.example" }));
    assert.throws(() => build({ ALLOCYN_REPO_URL: "not a url" }));
  } finally { build({}); }
});

test("landing: every internal link resolves and the endpoint table lists every route", () => {
  const html = read("index.html");
  for (const m of html.matchAll(/href="([^"#]+)"/g)) {
    const h = m[1]!;
    if (/^(https?:|\/)/.test(h)) continue;
    assert.ok(fs.existsSync(path.join(dist, h)), `landing links ${h}`);
  }
  for (const r of ROUTES) assert.ok(html.includes(`GET ${r.path}`), r.path);
});

test("MCP: the docs page lists every tool, and llms.txt lists every route and tool", async () => {
  const { buildTools } = await import("../../packages/api/src/mcp.ts");
  const page = read("agents-mcp.html");
  const llms = read("llms.txt");
  for (const t of buildTools()) {
    assert.ok(page.includes(`<code>${t.name}</code>`), `page lists ${t.name}`);
    assert.ok(llms.includes(t.name), `llms.txt lists ${t.name}`);
  }
  for (const r of ROUTES) assert.ok(llms.includes(r.path), `llms.txt lists ${r.path}`);
  assert.match(page, /read-only/i);
  assert.match(page, /not<\/strong> yet been run against an external MCP client|has <strong>not<\/strong> yet been run against an external MCP client/);
  assert.ok(!/localhost/.test(llms) || process.env.API_BASE_URL === undefined, "llms.txt names the real base URL when one is configured");
});
