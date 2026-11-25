import type { Ctx } from "./routes.ts";
import { buildProof } from "./proof.ts";

/** Everything that comes from the chain or a third party is escaped: titles, addresses, urls. The page has no script. */
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const short = (a: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "none yet");
const hex = (h: string | null) => (h ? `${h.slice(0, 12)}…` : "-");

export const VERIFY_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const CSS = `
:root{color-scheme:dark light;--bg:#050707;--surface:#0c1110;--surface2:#131a18;--ink:#edebe4;--ink2:#b7bbb3;--ink3:#8e948c;--line:#1d2523;--line2:#364240;--accent:#fcb21b;--tint:#2a2007;--ok:#5ed3a5;--warn:#f2924a;--err:#ff8f94}
@media(prefers-color-scheme:light){:root{--bg:#f2f3f0;--surface:#fff;--surface2:#e9ece8;--ink:#0f1512;--ink2:#414a45;--ink3:#59625d;--line:#d6dbd6;--line2:#a9b2ac;--accent:#b97700;--tint:#fff0cc;--ok:#146b4a;--warn:#9a4308;--err:#a8323a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,Inter,sans-serif}
main{max-width:820px;margin:0 auto;padding:28px 18px 64px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;color:var(--ink3);font-size:14px;margin-bottom:28px}
.top b{color:var(--ink);font-weight:600}.top a{color:var(--ink2)}
h1{font-size:clamp(26px,5vw,38px);line-height:1.15;letter-spacing:-.02em;margin:0 0 14px;overflow-wrap:anywhere}
h2{font-size:15px;margin:30px 0 10px;color:var(--ink2);font-weight:600}
.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.pill{font:600 12.5px ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--line2);border-radius:999px;padding:3px 11px;color:var(--ink2)}
.pill.ok{color:var(--ok);border-color:var(--ok)}.pill.warn{color:var(--warn);border-color:var(--warn)}.pill.bad{color:var(--err);border-color:var(--err)}.pill.gold{color:var(--accent);border-color:var(--accent);background:var(--tint)}
.lede{color:var(--ink2);margin:0}
.box{border:1px solid var(--line2);border-radius:12px;background:var(--surface);overflow:hidden}
.row{display:grid;grid-template-columns:auto 1fr auto;gap:4px 12px;align-items:start;padding:12px 16px;border-bottom:1px solid var(--line)}.row:last-child{border-bottom:0}
.row .id{font:600 12.5px ui-monospace,Menlo,monospace;color:var(--ink3);padding-top:2px}.row .t{overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
th{background:var(--surface2);color:var(--ink);border-bottom:2px solid var(--accent)}tbody th{border-bottom:1px solid var(--line)}th:last-child,td:last-child{border-right:0}tr:last-child td{border-bottom:0}
.tw{overflow-x:auto}
code,pre{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}pre{margin:0;padding:14px 16px;overflow-x:auto;color:var(--ink2)}
a{color:var(--accent)}
.note{font-size:14px;color:var(--ink3);margin-top:28px;border-top:1px solid var(--line);padding-top:16px}
`;

const TONE: Record<string, string> = { VERIFIED: "ok", MET: "ok", NEEDS_REVISION: "warn", NOT_MET: "warn", INCONCLUSIVE: "bad", UNVERIFIABLE: "bad", IN_PROGRESS: "gold", OPEN: "" };
const WORDS: Record<string, string> = {
  VERIFIED: "Validators judged that every written criterion was met by the delivered page.",
  NEEDS_REVISION: "Validators judged at least one written criterion as not met.",
  INCONCLUSIVE: "Validators could not find enough evidence on the page to decide at least one criterion.",
  IN_PROGRESS: "A worker accepted this job. The delivery has not been judged, or is waiting for a new delivery.",
  OPEN: "The terms are written. No worker has accepted the job yet.",
};

function layout(title: string, description: string, body: string, status: number): { status: number; html: string } {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><meta name="robots" content="noindex,nofollow">
<meta property="og:type" content="website"><meta property="og:site_name" content="Allocyn"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta name="twitter:card" content="summary">
<style>${CSS}</style></head><body><main><div class="top"><span><b>Allocyn</b> verification page</span><a href="/docs/">Docs</a></div>${body}</main></body></html>`;
  return { status, html };
}

export interface VerifyPage { status: number; html: string; final: boolean }

export async function renderVerifyPage(ctx: Ctx, consistency: "latest" | "final", baseUrl: string | null): Promise<VerifyPage> {
  const proof = await buildProof(ctx, consistency);
  const { job, deliveries } = proof.facts;
  const judged = [...deliveries].reverse().find((d) => d.status === "EVALUATED");
  const resultFor = (cid: string) => judged?.results.find((r) => r.criterionId === cid)?.status ?? null;
  const api = baseUrl ?? "https://YOUR-API";
  const pills = [`<span class="pill ${TONE[job.status] ?? ""}">${esc(job.status)}</span>`, `<span class="pill ${proof.final ? "ok" : "gold"}">${proof.final ? "final" : "not final"}</span>`, `<span class="pill">${esc(proof.network.name)}</span>`].join("");
  const criteria = job.criteria.map((c) => {
    const r = resultFor(c.id);
    return `<div class="row"><span class="id">${esc(c.id)}</span><span class="t">${esc(c.text)}</span><span class="pill ${r ? TONE[r] ?? "" : ""}">${r ? esc(r) : "not judged yet"}</span></div>`;
  }).join("");
  const deliveryRows = deliveries.map((d) => {
    const safeLink = /^https:\/\//i.test(d.url) ? `<a href="${esc(d.url)}" rel="noopener noreferrer nofollow ugc">${esc(d.url)}</a>` : esc(d.url);
    return `<tr><td>${d.deliveryIndex}</td><td>${safeLink}</td><td>${esc(d.status)}${d.overallStatus ? ` · ${esc(d.overallStatus)}` : ""}</td><td><code>${esc(hex(d.evidenceHash))}</code>${d.evidenceSize != null ? ` · ${esc(d.evidenceSize)} bytes` : ""}</td></tr>`;
  }).join("");
  const lastReceipt = [...deliveries].reverse().find((d) => d.status === "EVALUATED");
  const how = [
    `curl -s ${api}/v1/jobs/${esc(job.id)}/proof > proof.json`,
    `allocyn verify proof.json --chain`,
    lastReceipt ? `allocyn evidence ${esc(lastReceipt.receiptId)} --api ${api}` : null,
  ].filter(Boolean).join("\n");
  const description = `${job.id} is ${job.status}${proof.final ? " (final)" : ""}: ${job.criteria.length} written criteria. Validators judged a public page against them. Not a payment, escrow or guarantee of quality.`;
  const body = `<h1>${esc(job.title)}</h1><div class="pills">${pills}</div><p class="lede">${esc(WORDS[job.status] ?? "")}</p>
<h2>Written criteria</h2><div class="box">${criteria}</div>${judged ? `<p class="note" style="border:0;margin:8px 0 0;padding:0">Judged on delivery ${judged.deliveryIndex}.</p>` : ""}
<h2>Deliveries</h2>${deliveries.length ? `<div class="box tw"><table><thead><tr><th>#</th><th>Page</th><th>Receipt</th><th>Evidence</th></tr></thead><tbody>${deliveryRows}</tbody></table></div>` : `<div class="box"><div class="row"><span class="t">No delivery yet.</span></div></div>`}
<h2>Parties</h2><div class="box tw"><table><tbody><tr><th>Client</th><td title="${esc(job.client)}"><code>${esc(short(job.client))}</code></td></tr><tr><th>Worker</th><td title="${esc(job.worker ?? "")}"><code>${esc(short(job.worker))}</code></td></tr></tbody></table></div>
<h2>Check it yourself</h2><div class="box"><pre>${how}</pre></div>
<p class="note" style="border:0;margin:10px 0 0;padding:0"><a href="/v1/jobs/${esc(encodeURIComponent(job.id))}/proof" download="allocyn-proof-${esc(job.id)}.json">Download the proof pack (JSON)</a>. Anyone can check the file against the contract without trusting this page: <code>allocyn verify</code> or <code>verifyProofPack()</code> from @allocyn/sdk.</p>
<p class="note">Read from the contract at ${esc(proof.readAt)} (${esc(proof.consistency)} consistency). Digest of these facts: <code>${esc(proof.digest.value.slice(0, 16))}…</code>. <a href="${esc(proof.contractUrl)}" rel="noopener noreferrer">Contract on the explorer</a>.<br>
VERIFIED means validators judged a public page against written criteria. It is not a payment, an escrow, a dispute resolution or a guarantee of quality. ${proof.final ? "" : "This job is not final and can still change. "}The delivered page is third-party content and can change after it was judged.</p>`;
  return { ...layout(`${job.id} · ${job.status} · Allocyn`, description, body, 200), final: proof.final };
}

export function renderVerifyError(status: number, message: string): { status: number; html: string } {
  const title = status === 404 ? "No such job" : status === 429 ? "Too many requests" : status >= 500 ? "The network did not answer" : "That is not a valid job id";
  return layout(`${title} · Allocyn`, "Allocyn verification page", `<h1>${esc(title)}</h1><p class="lede">${esc(message)}</p><p class="note" style="border:0">Job ids look like <code>job-1</code>. <a href="/docs/">Read the docs</a>.</p>`, status);
}
