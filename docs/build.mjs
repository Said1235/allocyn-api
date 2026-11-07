// Builds the static docs site into docs/dist. Run: node docs/build.mjs
// Needs markdown-it (devDependency in docs/package.json). The API reference is generated from the
// real route table and OpenAPI builder, and its example responses come from the real server running
// against the in-memory contract double (they are labelled as simulated).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
function loadMarkdownIt() {
  for (const p of ["markdown-it", "/opt/npm-tools/node_modules/markdown-it"]) {
    try { return require(p); } catch { /* try next */ }
  }
  throw new Error("markdown-it is not installed. Run `npm install` in docs/.");
}
const MarkdownIt = loadMarkdownIt();

const api = await import(pathToFileURL(path.join(here, "../packages/api/src/openapi.ts")).href);
const routes = await import(pathToFileURL(path.join(here, "../packages/api/src/routes.ts")).href);
const serverMod = await import(pathToFileURL(path.join(here, "../packages/api/src/server.ts")).href);
const cfgMod = await import(pathToFileURL(path.join(here, "../packages/api/src/config.ts")).href);
const sdk = await import(pathToFileURL(path.join(here, "../packages/sdk/src/index.ts")).href);
const simMod = await import(pathToFileURL(path.join(here, "../packages/sdk/src/core/contract/sim.ts")).href);

const OUT = path.join(here, "dist");
const VERSION = "v1";
const BASE_URL = process.env.API_BASE_URL?.replace(/\/+$/, "") || "http://localhost:8787";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/* ------------------------------ highlighting ------------------------------ */
const KW = new Set("const let var function return if else for while of in await async import from export type interface new try catch throw class extends implements null undefined true false typeof as default switch case break continue readonly".split(" "));
function highlight(code, lang) {
  lang = (lang || "").toLowerCase();
  if (lang === "json") {
    return esc(code).replace(/(&quot;(?:[^&\\]|\\.|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?\b)/g, (m, s, colon, lit, num) => {
      if (s) return colon ? `<span class="tk-key">${s}</span>${colon}` : `<span class="tk-str">${s}</span>`;
      if (lit) return `<span class="tk-kw">${lit}</span>`;
      return `<span class="tk-num">${num}</span>`;
    });
  }
  if (lang === "bash" || lang === "sh") {
    return code.split("\n").map((line) => {
      const i = line.indexOf(" #");
      const main = i >= 0 && !/["']/.test(line.slice(0, i).split("").filter((c) => c === '"' || c === "'").join("")) ? line.slice(0, i) : line;
      const com = main === line ? "" : line.slice(i);
      if (/^\s*#/.test(line)) return `<span class="tk-com">${esc(line)}</span>`;
      const h = esc(main).replace(/(&quot;.*?&quot;|'[^']*')/g, '<span class="tk-str">$1</span>').replace(/^(\s*)([\w./-]+)/, '$1<span class="tk-fn">$2</span>').replace(/(\s)(--?[\w-]+)/g, '$1<span class="tk-kw">$2</span>');
      return h + (com ? `<span class="tk-com">${esc(com)}</span>` : "");
    }).join("\n");
  }
  if (["ts", "tsx", "js", "jsx", "typescript", "javascript"].includes(lang)) {
    const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:[^`\\]|\\[\s\S])*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(\s*\()?/g;
    let out = "", last = 0, m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index));
      if (m[1]) out += `<span class="tk-com">${esc(m[1])}</span>`;
      else if (m[2]) out += `<span class="tk-str">${esc(m[2])}</span>`;
      else if (m[3]) out += `<span class="tk-num">${m[3]}</span>`;
      else if (KW.has(m[4])) out += `<span class="tk-kw">${m[4]}</span>${esc(m[5] ?? "")}`;
      else if (m[5]) out += `<span class="tk-fn">${m[4]}</span>${esc(m[5])}`;
      else out += esc(m[4]);
      last = re.lastIndex;
    }
    return out + esc(code.slice(last));
  }
  return esc(code);
}
const codeBlock = (code, lang, note) => `<div class="code"><div class="bar"><span>${esc(lang || "text")}${note ? " · " + esc(note) : ""}</span><button class="copy" type="button">Copy</button></div><pre><code>${highlight(code.replace(/\n$/, ""), lang)}</code></pre></div>`;

/* -------------------------------- diagrams -------------------------------- */
const DEFS = `<defs><marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1l8 4-8 4z"/></marker></defs>`;
const box = (x, y, w, h, label, cls = "", sub = "") => `<rect class="box ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="9"/><text x="${x + w / 2}" y="${y + h / 2 + (sub ? -2 : 5)}" text-anchor="middle">${label}</text>${sub ? `<text class="sub" x="${x + w / 2}" y="${y + h / 2 + 14}" text-anchor="middle">${sub}</text>` : ""}`;
const edge = (d, dash) => `<path class="edge${dash ? " dash" : ""}" d="${d}" marker-end="url(#ar)"/>`;
const lbl = (x, y, t, anchor = "middle") => `<text class="sub" x="${x}" y="${y}" text-anchor="${anchor}">${t}</text>`;
const DIAGRAMS = {
  job: `<svg viewBox="0 0 760 300" role="img" aria-label="Job status diagram: OPEN, accept, IN_PROGRESS, evaluate, then VERIFIED, NEEDS_REVISION or INCONCLUSIVE; the last two can loop back to IN_PROGRESS by submitting another delivery.">${DEFS}
    ${box(20, 125, 110, 44, "OPEN", "gold")}${edge("M130 147H208")}${lbl(169, 138, "acceptJob")}
    ${box(210, 125, 150, 44, "IN_PROGRESS", "gold", "delivery submitted")}
    ${edge("M360 140C420 140 430 52 498 52")}${edge("M360 147H498")}${edge("M360 154C420 154 430 242 498 242")}${lbl(430, 140, "evaluateDelivery")}
    ${box(500, 30, 160, 44, "VERIFIED", "ok", "final")}${box(500, 125, 160, 44, "NEEDS_REVISION", "warn")}${box(500, 220, 160, 44, "INCONCLUSIVE", "bad")}
    <path class="edge" d="M660 147H690V242H660"/><path class="edge dash" d="M690 195V285H285V171" marker-end="url(#ar)"/>${lbl(488, 281, "submitDelivery again (up to 2 deliveries in total)")}
  </svg>`,
  tx: `<svg viewBox="0 0 760 210" role="img" aria-label="Transaction phases: awaiting wallet, submitted, in consensus, decided, finalized. Cancelled, undetermined or timed out end with nothing recorded.">${DEFS}
    ${box(10, 40, 125, 44, "awaiting_wallet")}${edge("M135 62H160")}${box(162, 40, 105, 44, "submitted")}${edge("M267 62H292")}${box(294, 40, 120, 44, "in_consensus")}${edge("M414 62H439")}${box(441, 40, 140, 44, "decided", "gold", "ACCEPTED")}${edge("M581 62H606")}${box(608, 40, 140, 44, "finalized", "ok", "FINALIZED")}
    ${edge("M354 84V138", true)}${box(204, 140, 300, 44, "cancelled · undetermined · timed_out", "bad", "nothing was recorded")}
    ${lbl(510, 112, "decided is not proof: re-read the job", "start")}
  </svg>`,
  arch: `<svg viewBox="0 0 760 290" role="img" aria-label="Architecture: a wallet or your own backend account signs writes through the SDK; an agent or app reads through the read-only API; both talk to the Allocyn contract on GenLayer Studionet.">${DEFS}
    ${box(10, 20, 190, 50, "Browser wallet", "gold", "signs with the person's key")}${box(10, 90, 190, 50, "Your backend account", "gold", "an identity you own")}
    ${box(10, 190, 190, 50, "Agent or app", "", "no wallet needed")}
    ${box(280, 55, 170, 50, "@allocyn/sdk", "gold", "reads + signed writes")}${box(280, 190, 170, 50, "Allocyn API", "ok", "read-only GET /v1")}
    ${box(540, 100, 210, 70, "Allocyn contract", "", "GenLayer Studionet")}
    ${edge("M200 45C240 45 240 70 280 72")}${edge("M200 115C240 115 240 90 280 90")}${edge("M200 215H280")}${edge("M450 80C500 80 500 120 540 125")}${edge("M450 215C500 215 500 160 540 155")}
    ${lbl(240, 33, "signs")}${lbl(240, 207, "GET", "middle")}${lbl(495, 100, "reads + writes", "start")}${lbl(495, 205, "reads only", "start")}
  </svg>`,
};

/* ----------------------------- markdown -> html ----------------------------- */
const md = new MarkdownIt({ html: true, linkify: false, typographer: false });
md.renderer.rules.fence = (tokens, i) => {
  const t = tokens[i];
  return codeBlock(t.content, (t.info || "").trim().split(/\s+/)[0]);
};
const defaultHeading = md.renderer.rules.heading_open;
md.renderer.rules.heading_open = (tokens, i, o, env, self) => {
  const t = tokens[i];
  if (t.tag === "h2" || t.tag === "h3") {
    const text = tokens[i + 1].children.map((c) => c.content).join("");
    const id = slugify(text);
    t.attrSet("id", id);
    env.toc.push({ level: t.tag, id, text });
    env.sections.push({ h: text, t: "" });
  }
  return defaultHeading ? defaultHeading(tokens, i, o, env, self) : self.renderToken(tokens, i, o);
};
md.renderer.rules.heading_close = (tokens, i, o, env, self) => {
  const t = tokens[i];
  if (t.tag === "h2" || t.tag === "h3") {
    const id = env.toc[env.toc.length - 1].id;
    return `<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></${t.tag}>\n`;
  }
  return self.renderToken(tokens, i, o);
};

function frontMatter(raw) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!m) throw new Error("missing front matter");
  const meta = {};
  for (const line of m[1].split("\n")) { const k = line.indexOf(":"); meta[line.slice(0, k).trim()] = line.slice(k + 1).trim(); }
  return { meta, body: raw.slice(m[0].length) };
}
const plain = (html) => html.replace(/<pre[\s\S]*?<\/pre>/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

/* ------------------------- API reference generation ------------------------ */
async function simulatedExamples() {
  const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
  const sim = new simMod.SimContract();
  await sim.directWrite(A, "create_job", ["Logo files", "The studio logo as vector files.", ["Delivered as SVG", "Includes a usage guide"]]);
  await sim.directWrite(B, "accept_job", ["job-1"]);
  await sim.directWrite(B, "submit_delivery", ["job-1", "https://example.org/logo-package"]);
  await sim.directWrite(B, "evaluate_delivery", ["rcpt-1"]);
  sim.connectAs(A);
  const hash = await sim.send("create_job", ["Another job", "A second job.", ["First check", "Second check"]]);
  await sim.getTx(hash); await sim.getTx(hash); await sim.getTx(hash);
  const cfg = cfgMod.loadConfig({ NODE_ENV: "test" });
  const mk = (c) => sdk.createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
  const s = serverMod.createApiServer({ config: cfg, clients: { latest: await mk("latest"), final: await mk("final") } });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  const out = {};
  try {
    for (const r of routes.ROUTES) {
      let p = r.path.replace("{jobId}", "job-1").replace("{deliveryIndex}", "1").replace("{receiptId}", "rcpt-1").replace("{txHash}", hash);
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      out[r.path] = { status: res.status, body: JSON.parse(await res.text()), url: p };
    }
    const nf = await fetch(`http://127.0.0.1:${port}/v1/jobs/job-99`);
    out.__notfound = { status: nf.status, body: await nf.json() };
  } finally { s.close(); }
  return out;
}

function paramsTable(rows) {
  if (!rows.length) return "";
  return `<table><thead><tr><th>Name</th><th>In</th><th>Type</th><th>Description</th></tr></thead><tbody>${rows.map((r) => `<tr><td><code>${esc(r.name)}</code></td><td>${r.in}</td><td>${esc(Array.isArray(r.schema.type) ? r.schema.type.join(" | ") : r.schema.type)}${r.schema.enum ? ": " + r.schema.enum.map((e) => `<code>${esc(e)}</code>`).join(", ") : ""}${r.schema.pattern ? `<br><code>${esc(r.schema.pattern)}</code>` : ""}</td><td>${esc(r.description)}</td></tr>`).join("")}</tbody></table>`;
}

async function referenceHtml(spec) {
  const ex = await simulatedExamples();
  let html = `<div class="base"><label>API base URL for “Try it”<input id="base" type="url" value="${esc(BASE_URL)}" autocomplete="off" spellcheck="false"></label></div>`;
  html += `<p>The “Try it” forms send a real request from your browser to the base URL above. They only work while that API is running and allows this page's origin in <code>CORS_ORIGINS</code> (the docs served by the API itself are same-origin).</p>`;
  html += `<p class="sim">Example responses below were produced by running the real server code against the <strong>in-memory test double of the contract</strong> when these docs were built. They show the exact shapes; the values are not from the network.</p>`;
  const byTag = {};
  for (const r of routes.ROUTES) (byTag[r.tag] ||= []).push(r);
  for (const [tag, rs] of Object.entries(byTag)) {
    html += `<h3 id="${slugify(tag)}">${esc(tag)}<a class="anchor" href="#${slugify(tag)}" aria-label="Link to this section">#</a></h3>`;
    for (const r of rs) {
      const op = spec.paths[r.path][r.method.toLowerCase()];
      const e = ex[r.path];
      const params = op.parameters.map((p) => ({ ...p }));
      const inputs = params.map((p) => p.in === "path"
        ? `<label>${esc(p.name)}<input data-p="${esc(p.name)}" value="${esc(String(p.example ?? ""))}" size="${p.name === "txHash" ? 30 : 12}" autocomplete="off" spellcheck="false" required></label>`
        : `<label>${esc(p.name)}<select data-q="${esc(p.name)}"><option value="">(default)</option>${p.schema.enum.map((v) => `<option>${esc(v)}</option>`).join("")}</select></label>`).join("");
      const curl = `curl -s '${BASE_URL}${e.url}'`;
      html += `<section class="ep" id="${esc(r.operationId)}"><header><span class="m">GET</span><span class="p">${esc(r.path)}</span></header><div class="body">
        <p><strong>${esc(r.summary)}.</strong> ${esc(r.description).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>
        ${params.length ? "<h4>Parameters</h4>" + paramsTable(params) : ""}
        <h4>Responses</h4>
        <table><thead><tr><th>Status</th><th>Meaning</th></tr></thead><tbody><tr><td>200</td><td>Success: <code>{ "success": true, "data": ${esc(r.schemaRef)} }</code></td></tr>${r.errors.map((s) => `<tr><td>${s}</td><td>${esc(op.responses[String(s)].description)}</td></tr>`).join("")}<tr><td>500</td><td>Unexpected server error.</td></tr></tbody></table>
        <h4>Example request</h4>${codeBlock(curl, "bash")}
        <h4>Example response <span class="sim">(simulated contract, status ${e.status})</span></h4>${codeBlock(JSON.stringify(e.body, null, 2), "json")}
        <h4>Try it</h4>
        <form class="try" data-path="${esc(r.path)}">${inputs}<button type="submit">Send request</button></form>
        <div class="out" hidden>${codeBlock("", "response")}</div>
      </div></section>`;
    }
  }
  html += `<h3 id="error-example">Error example<a class="anchor" href="#error-example" aria-label="Link to this section">#</a></h3>${codeBlock(`GET /v1/jobs/job-99  →  HTTP ${ex.__notfound.status}\n` + JSON.stringify(ex.__notfound.body, null, 2), "json")}`;
  return html;
}

/* ---------------------------------- build ---------------------------------- */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const files = fs.readdirSync(path.join(here, "content")).filter((f) => f.endsWith(".md")).sort();
const pages = [];
for (const f of files) {
  const { meta, body } = frontMatter(fs.readFileSync(path.join(here, "content", f), "utf8"));
  const slug = f.replace(/^\d+-/, "").replace(/\.md$/, "");
  pages.push({ slug, ...meta, body });
}
const spec = api.buildOpenApi({ apiBaseUrl: BASE_URL, network: "studionet" });
fs.writeFileSync(path.join(OUT, "openapi.json"), JSON.stringify(spec, null, 2));

const groups = [...new Set(pages.map((p) => p.group))];
const index = [];
const LOGO = "logo.png";
fs.copyFileSync(path.join(here, "assets/logo.png"), path.join(OUT, LOGO));
fs.copyFileSync(path.join(here, "assets/style.css"), path.join(OUT, "style.css"));
fs.copyFileSync(path.join(here, "assets/app.js"), path.join(OUT, "app.js"));
fs.writeFileSync(path.join(OUT, "versions.json"), JSON.stringify({ current: VERSION, versions: [{ id: VERSION, path: "/docs/", status: "current" }] }, null, 2));

const rendered = [];
for (const p of pages) {
  const env = { toc: [], sections: [{ h: p.title, t: "" }] };
  let html = md.render(p.body, env);
  html = html.replace(/<div class="diagram" data-diagram="(\w+)"><\/div>/g, (_, n) => {
    if (!DIAGRAMS[n]) throw new Error("unknown diagram " + n);
    return `<figure class="diagram">${DIAGRAMS[n]}</figure>`;
  });
  if (p.generated === "openapi") {
    html += await referenceHtml(spec);
    env.toc.push(...[...new Set(routes.ROUTES.map((r) => r.tag))].map((t) => ({ level: "h3", id: slugify(t), text: t })));
  }
  rendered.push({ p, html, env });
}

const pageHtml = ({ p, html, env }, i) => {
  const prev = rendered[i - 1]?.p, next = rendered[i + 1]?.p;
  const nav = groups.map((g) => `<h2>${esc(g)}</h2>` + pages.filter((x) => x.group === g).map((x) => `<a href="${x.slug}.html"${x.slug === p.slug ? ' aria-current="page"' : ""}>${esc(x.title)}</a>`).join("")).join("");
  const toc = env.toc.map((t) => `<a class="${t.level}" href="#${t.id}">${esc(t.text)}</a>`).join("");
  return `<!doctype html>
<html lang="en" data-theme="dark" data-root="./">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title)} · Allocyn API docs</title><meta name="description" content="${esc(p.summary)}">
<link rel="icon" href="${LOGO}"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Unbounded:wght@400;500&family=Instrument+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="style.css"></head>
<body><a class="skip" href="#main">Skip to content</a>
<header class="top"><button class="icon menu-btn" id="menu" aria-expanded="false" aria-controls="side">Menu</button>
<a class="brand" href="introduction.html"><img src="${LOGO}" alt="" width="26" height="26">Allocyn<small>API &amp; SDK</small></a><span class="ver" title="Documentation version">${VERSION}</span><span class="spacer"></span>
<div class="search"><input id="q" type="search" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off"><kbd>/</kbd><div id="results" class="results" role="listbox"></div></div>
<button class="icon" id="theme" type="button"></button></header>
<div class="layout"><nav class="side" id="side" aria-label="Documentation">${nav}</nav>
<main id="main"><article>${html}
<div class="pager">${prev ? `<a href="${prev.slug}.html"><small>Previous</small>${esc(prev.title)}</a>` : "<span></span>"}${next ? `<a href="${next.slug}.html"><small>Next</small>${esc(next.title)}</a>` : ""}</div></article></main>
<aside class="toc" aria-label="On this page">${toc ? "<b>On this page</b>" + toc : ""}</aside></div>
<script src="app.js"></script></body></html>`;
};

rendered.forEach((r, i) => {
  fs.writeFileSync(path.join(OUT, `${r.p.slug}.html`), pageHtml(r, i));
  // search index: split the plain text per heading
  const parts = r.html.split(/(?=<h[23] )/);
  const sections = parts.map((part) => {
    const h = /<h[23][^>]*>([\s\S]*?)<a class="anchor"/.exec(part);
    return { h: h ? plain(h[1]) : r.p.title, t: plain(part).slice(0, 1200) };
  });
  index.push({ slug: r.p.slug, title: r.p.title, summary: r.p.summary, sections });
});
// ---- landing page (index.html) ----
function loadLinks() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(here, "site.config.json"), "utf8")); } catch { /* optional */ }
  const pick = (env, key) => {
    const v = (process.env[env] || cfg[key] || "").trim();
    if (!v) return null;
    let u; try { u = new URL(v); } catch { throw new Error(`${key} is not a valid URL: ${v}`); }
    if (u.protocol !== "https:") throw new Error(`${key} must be an https:// URL`);
    return u.href;
  };
  return { appUrl: pick("ALLOCYN_APP_URL", "appUrl"), repoUrl: pick("ALLOCYN_REPO_URL", "repoUrl") };
}

async function landingHtml(links) {
  const ex = (await simulatedExamples());
  const job = ex["/v1/jobs/{jobId}"].body.data;
  const rec = ex["/v1/jobs/{jobId}/receipts"].body.data[0];
  const shown = JSON.stringify({ success: true, data: { id: job.id, status: job.status, worker: job.worker.slice(0, 8) + "…", receiptIds: job.receiptIds, results: rec.results.map((r) => ({ criterionId: r.criterionId, status: r.status })) } }, null, 2);
  const ticks = (r, n) => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2, r2 = r - (i % 5 === 0 ? 4 : 2); return `<line x1="${(100 + Math.cos(a) * r).toFixed(2)}" y1="${(100 + Math.sin(a) * r).toFixed(2)}" x2="${(100 + Math.cos(a) * r2).toFixed(2)}" y2="${(100 + Math.sin(a) * r2).toFixed(2)}"/>`; }).join("");
  const rings = `<svg class="rings" viewBox="0 0 200 200" aria-hidden="true" focusable="false"><g class="a"><circle cx="100" cy="100" r="97"/>${ticks(97, 90)}</g><g class="b"><circle cx="100" cy="100" r="82" stroke-dasharray="1 5"/><circle class="dot" cx="182" cy="100" r="2.4"/></g><circle cx="100" cy="100" r="68"/></svg>`;
  const ext = (label, href, primary) => href ? `<a class="btn${primary ? " primary" : ""}" href="${esc(href)}" rel="noopener">${label}</a>` : "";
  const endpoints = routes.ROUTES.map((r) => `<tr><td><code>GET ${esc(r.path)}</code></td><td>${esc(r.summary)}</td></tr>`).join("");
  const run = codeBlock("cd allocyn\nnpm install\ncp .env.example .env\nnpm start", "bash");
  const read = codeBlock(`curl -s ${BASE_URL}/v1/jobs/job-1`, "bash");
  const write = codeBlock("const allocyn = await createAllocynClient({\n  signer: { type: \"provider\", provider: window.ethereum, address },\n});\nawait allocyn.createJob({ title, description, criteria });", "ts");
  return `<!doctype html>
<html lang="en" data-theme="dark" data-root="./">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Allocyn API and SDK</title><meta name="description" content="Read Allocyn jobs, receipts and transactions from any app or agent. Writes are signed by your own wallet.">
<link rel="icon" href="${LOGO}"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Unbounded:wght@400;500&family=Instrument+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="style.css"><link rel="stylesheet" href="landing.css"></head>
<body class="lp"><a class="skip" href="#main">Skip to content</a>
<header class="top"><a class="brand" href="index.html"><img src="${LOGO}" alt="" width="26" height="26">Allocyn<small>API &amp; SDK</small></a>
<nav class="nav" aria-label="Main"><a href="quickstart.html">Quickstart</a><a href="rest-reference.html">REST</a><a href="sdk-reference.html">SDK</a><a href="faq.html">FAQ</a></nav><span class="spacer"></span>
${links.appUrl ? `<a class="btn" style="height:36px;padding:0 16px;font-size:14px" href="${esc(links.appUrl)}" rel="noopener">Open the app</a>` : ""}
<button class="icon" id="theme" type="button"></button></header>
<main id="main">
<section class="hero"><div class="wrap hero-grid">
  <div><h1>Verified work, readable by any app or agent.</h1>
  <p class="lede">The Allocyn API reads jobs, receipts and transaction status straight from the contract. The SDK sends writes, signed by your own wallet.</p>
  <div class="cta"><a class="btn primary" href="quickstart.html">Start with the quickstart</a><a class="btn" href="rest-reference.html">REST reference</a>${ext("Open the app", links.appUrl, false)}${ext("View the repository", links.repoUrl, false)}</div>
  <p class="fine">Studionet only. The API is read-only, holds no keys and no database.</p></div>
  <div class="instrument" role="img" aria-label="Example response of GET /v1/jobs/job-1: a verified job with its per-criterion results. Simulated data.">${rings}
    <div class="sheet"><div class="bar"><span>GET /v1/jobs/job-1</span><b>200</b></div><pre>${esc(shown)}</pre><div class="sim">Simulated example, from the test double of the contract.</div></div></div>
</div></section>

<section class="block" id="start"><div class="wrap"><h2>Use it in three steps</h2><p class="sub">No account and no API key. Reading needs nothing; writing needs the wallet of whoever is acting.</p>
<ol class="steps">
<li><h3>Run the API</h3><p>Node 22.6 or newer. It starts on port 8787 and serves these docs.</p>${run}</li>
<li><h3>Read a job</h3><p>Any HTTP client works. Every answer is <code>{ success, data }</code> or <code>{ success: false, error }</code>.</p>${read}</li>
<li><h3>Write with the SDK</h3><p>The person's wallet signs. The SDK sends one transaction and re-reads the contract before reporting success.</p>${write}</li>
</ol></div></section>

<section class="block"><div class="wrap"><h2>Two doors, one rule</h2><p class="sub">Nothing in Allocyn signs on behalf of someone else, and nothing asks for a private key or seed phrase.</p>
<div class="doors">
<div class="door"><h3>REST API</h3><p class="who">read-only · no wallet</p><ul><li>Jobs, receipts, transaction status</li><li>Live limits from the contract</li><li>OpenAPI 3.1 and a live try-it</li></ul><a class="btn" href="rest-reference.html">Open the reference</a></div>
<div class="door"><h3>SDK (<code>@allocyn/sdk</code>)</h3><p class="who">reads + writes · the participant signs</p><ul><li>Create, accept, deliver, evaluate</li><li>Typed errors that keep the transaction hash</li><li>Never resends on its own, never invents an id</li></ul><a class="btn" href="sdk-reference.html">Open the reference</a></div>
</div></div></section>

<section class="block"><div class="wrap"><h2>How a job moves</h2><p class="sub">A client writes the terms, a worker delivers a public link, validators judge it against the criteria. Up to two deliveries per job.</p>
<figure class="diagram" style="margin:0">${DIAGRAMS.job}</figure></div></section>

<section class="block"><div class="wrap"><h2>Endpoints at a glance</h2><p class="sub">All <code>GET</code>. Generated from the same route table the server uses.</p>
<table><thead><tr><th>Endpoint</th><th>What it returns</th></tr></thead><tbody>${endpoints}</tbody></table></div></section>

<section class="block"><div class="wrap"><h2>What it is not</h2><p class="sub">Said plainly, so nobody builds on a wrong idea.</p>
<ul class="notlist">
<li><b>Not payments or escrow.</b>No money moves, and a verdict does not release or hold funds.</li>
<li><b>Not dispute resolution.</b>Not a legal determination of any kind.</li>
<li><b>Not a measure of quality.</b>A verified job means validators judged the text met the written criteria.</li>
<li><b>Not immune to prompt injection.</b>A delivered page is untrusted text that a model reads.</li>
<li><b>Not tested on the live network from here.</b>Tests use a simulated contract; the checks to run yourself are in the docs.</li>
<li><b>Not a relay.</b>Sending transactions signed elsewhere is not implemented.</li>
</ul></div></section>

<section class="block closing"><div class="wrap"><h2>Ready to read your first job?</h2><div class="cta"><a class="btn primary" href="quickstart.html">Quickstart</a><a class="btn" href="introduction.html">Read the docs</a><a class="btn" href="/openapi.json">OpenAPI JSON</a>${ext("Open the app", links.appUrl, false)}${ext("View the repository", links.repoUrl, false)}</div></div></section>
</main>
<footer class="lp-foot"><div class="wrap"><span>Allocyn API and SDK · docs ${VERSION}</span><nav aria-label="Footer"><a href="introduction.html">Introduction</a><a href="limits.html">Limits</a><a href="errors.html">Errors</a><a href="security-privacy.html">Security</a><a href="networks.html">Networks</a><a href="changelog.html">Changelog</a>${links.appUrl ? `<a href="${esc(links.appUrl)}" rel="noopener">App</a>` : ""}${links.repoUrl ? `<a href="${esc(links.repoUrl)}" rel="noopener">Repository</a>` : ""}</nav></div></footer>
<script src="app.js"></script></body></html>`;
}
fs.copyFileSync(path.join(here, "assets/landing.css"), path.join(OUT, "landing.css"));
fs.writeFileSync(path.join(OUT, "index.html"), await landingHtml(loadLinks()));
fs.writeFileSync(path.join(OUT, "search-index.json"), JSON.stringify(index));
console.log(`docs built: ${rendered.length} pages -> ${path.relative(process.cwd(), OUT)}`);
