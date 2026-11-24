#!/usr/bin/env node
// A reference agent for the Allocyn API. No dependencies: it speaks the Model Context Protocol over HTTP with plain fetch.
//
// What it does: finds open jobs, reads each one, asks the API what accepting it would involve, and (with --watch)
// follows the event feed. What it never does: sign, send a transaction, hold a key or decide for anyone.
// There is no language model in it on purpose. It shows the calls an agent makes; the judgment is yours.
//
//   node examples/agent/agent.mjs --base https://your-api.example --actor 0xYourAddress --q logo --watch

const READ_ONLY_TOOLS = ["list_jobs", "get_job", "prepare_action", "list_events", "get_address_record"];

export function createMcpClient(base, fetchImpl = fetch) {
  let id = 0;
  const rpc = async (method, params) => {
    const res = await fetchImpl(`${base.replace(/\/+$/, "")}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`MCP ${method}: ${json.error.message}`);
    return json.result;
  };
  return {
    tools: async () => (await rpc("tools/list")).tools.map((t) => t.name),
    /** Calls one tool. A tool error (a 4xx or 5xx of the API) comes back as `{ error }`, not as an exception. */
    call: async (name, args = {}) => {
      if (!READ_ONLY_TOOLS.includes(name)) throw new Error(`The reference agent only uses read-only tools, not ${name}.`);
      const result = await rpc("tools/call", { name, arguments: args });
      const body = JSON.parse(result.content[0].text);
      return result.isError ? { error: body.error ?? body } : body.data ?? body;
    },
  };
}

/**
 * One pass: look for open jobs and say, for each, what accepting it would involve.
 * @param {{ base: string, actor?: string, q?: string, limit?: number, watch?: boolean, watchSeconds?: number, log?: (line: string) => void, fetch?: typeof fetch }} o
 */
export async function run(o) {
  const log = o.log ?? ((l) => console.log(l));
  const mcp = createMcpClient(o.base, o.fetch);
  const report = { found: [], events: [] };

  const names = await mcp.tools();
  const missing = READ_ONLY_TOOLS.filter((t) => !names.includes(t));
  if (missing.length) log(`This API does not offer: ${missing.join(", ")}. Some steps will be skipped.`);

  // 1. Find open jobs. source=auto uses the database copy when there is one and the contract otherwise.
  const list = await mcp.call("list_jobs", { status: "OPEN", limit: o.limit ?? 5, ...(o.q ? { q: o.q } : {}), source: "auto" });
  if (list.error) { log(`Could not list jobs: ${list.error.message ?? JSON.stringify(list.error)}`); return report; }
  log(`Found ${list.items.length} open job(s)${o.q ? ` matching "${o.q}"` : ""} (read from the ${list.source}${list.syncedAt ? `, as of ${list.syncedAt}` : ""}).`);

  for (const item of list.items) {
    // 2. Read the job itself from the contract: the list is a summary, the job has the terms.
    const job = await mcp.call("get_job", { jobId: item.id });
    if (job.error) { log(`  ${item.id}: could not read it (${job.error.message}).`); continue; }
    log(`\n${job.id} "${job.title}"`);
    for (const c of job.criteria) log(`  - ${typeof c === "string" ? c : c.text ?? JSON.stringify(c)}`);

    // 3. Ask what accepting would involve. This reads the contract; nothing is signed or sent.
    const prep = await mcp.call("prepare_action", { jobId: job.id, action: "accept", ...(o.actor ? { actor: o.actor } : {}) });
    if (prep.error) { log(`  Could not prepare: ${prep.error.message}`); continue; }
    const row = { id: job.id, title: job.title, canProceed: prep.canProceed, reasons: prep.reasons, whoMaySign: prep.whoMaySign, sdk: prep.sdk, appLink: prep.appLink, sent: prep.sent };
    report.found.push(row);
    log(prep.canProceed ? `  Accepting is possible${o.actor ? " for you" : ""}. Who signs: ${prep.whoMaySign}.` : `  Accepting is not possible now: ${prep.reasons.join(" ")}`);
    if (prep.canProceed) {
      log(`  The person would sign: ${prep.sdk}`);
      if (prep.appLink) log(`  Or in the app: ${prep.appLink}`);
      log("  Nothing was sent. Deciding whether to take the job is for the person.");
    }
  }

  // 4. Follow what changes. The feed is cursor based: ask again with the cursor you got.
  if (o.watch) {
    let cursor;
    const first = await mcp.call("list_events", { limit: 1 });
    if (first.error) { log(`No event feed here: ${first.error.message}`); return report; }
    cursor = first.cursor;
    log(`\nWatching for new events after #${cursor} (up to ${o.watchSeconds ?? 20} s)...`);
    const feed = await mcp.call("list_events", { after: cursor, wait: Math.min(25, o.watchSeconds ?? 20) });
    if (feed.error) { log(`Could not read the feed: ${feed.error.message}`); return report; }
    for (const e of feed.items) { report.events.push(e); log(`  #${e.id} ${e.type} ${e.jobId}${e.toStatus ? ` -> ${e.toStatus}` : ""} (seen ${e.detectedAt})`); }
    if (!feed.items.length) log("  Nothing new in that time.");
  }
  return report;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--watch") o.watch = true;
    else if (a === "--base") o.base = argv[++i];
    else if (a === "--actor") o.actor = argv[++i];
    else if (a === "--q") o.q = argv[++i];
    else if (a === "--limit") o.limit = Number(argv[++i]);
    else if (a === "--watch-seconds") o.watchSeconds = Number(argv[++i]);
    else throw new Error(`Unknown option ${a}`);
  }
  if (!o.base) throw new Error("--base <the API's URL> is required.");
  return o;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(parseArgs(process.argv.slice(2))).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
}
