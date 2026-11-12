/**
 * The Allocyn command line. It talks to a deployed Allocyn API over HTTP: it has no dependencies, no wallet and
 * cannot write. Exit codes: 0 ok, 1 the API answered with an error, 2 wrong usage, 3 could not reach the API.
 */
export const CLI_VERSION = "0.1.0";

export interface Io {
  fetch: typeof fetch;
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
}

const HELP = `allocyn ${CLI_VERSION}: read Allocyn jobs and receipts from the API (read-only)

Usage: allocyn <command> [arguments] [options]

Commands:
  health [--deep]                    Is the API up (and, with --deep, the network)?
  meta                               Network, contract and API facts
  limits                             Input limits read from the contract
  jobs                               List jobs, newest first
        [--status S] [--client ADDR] [--worker ADDR] [--limit N] [--before job-N]
  job <job-id>                       One job
  receipts <job-id>                  Every receipt of a job
  receipt <rcpt-id>                  One receipt
  proof <job-id>                     Shareable proof summary of a job
  wait <job-id> [--since V] [--timeout S]   Wait until the job changes
  badge <job-id> [--url]             Print the badge SVG, or its URL with --url
  tx <0x-hash>                       Where a transaction is in consensus

Options:
  --api <url>            Base URL of the API (or set ALLOCYN_API_URL)
  --consistency <c>      latest (default) or final
  --envelope             Print the whole { success, data } answer instead of data
  -h, --help             Show this help
  -v, --version          Show the version

The API URL has no default: point it at your own deployment.`;

class Usage extends Error {}

function parse(argv: string[]) {
  const flags: Record<string, string | true> = {}; const pos: string[] = [];
  const withValue = new Set(["api", "consistency", "status", "client", "worker", "limit", "before", "since", "timeout"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h") flags.help = true;
    else if (a === "-v") flags.version = true;
    else if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (withValue.has(k)) {
        const v = inline ?? argv[++i];
        if (v === undefined || v.startsWith("--")) throw new Usage(`--${k} needs a value.`);
        flags[k] = v;
      } else if (["deep", "url", "envelope", "help", "version"].includes(k)) flags[k] = true;
      else throw new Usage(`Unknown option --${k}. Try --help.`);
    } else pos.push(a);
  }
  return { flags, pos };
}

const one = (pos: string[], name: string) => { if (pos.length !== 2) throw new Usage(`Usage: allocyn ${pos[0]} <${name}>`); return encodeURIComponent(pos[1]!); };

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const { flags, pos } = parse(argv);
    if (flags.version) { io.out(CLI_VERSION); return 0; }
    if (flags.help || pos.length === 0) { io.out(HELP); return pos.length === 0 && !flags.help ? 2 : 0; }
    const apiRaw = (flags.api as string | undefined) ?? io.env.ALLOCYN_API_URL;
    if (!apiRaw) throw new Usage("Say which API to read: --api https://your-api.example, or set ALLOCYN_API_URL.");
    let api: URL; try { api = new URL(apiRaw); } catch { throw new Usage(`"${apiRaw}" is not a valid URL.`); }
    if (api.protocol !== "https:" && api.hostname !== "localhost" && api.hostname !== "127.0.0.1") throw new Usage("The API URL must use https (http is only accepted for localhost).");
    const base = api.href.replace(/\/+$/, "");

    const q = new URLSearchParams();
    const add = (...names: string[]) => { for (const n of names) if (flags[n] !== undefined) q.set(n, String(flags[n])); };
    const cmd = pos[0]!; let path: string; let svg = false;
    switch (cmd) {
      case "health": path = "/v1/health"; if (flags.deep) q.set("deep", "true"); break;
      case "meta": path = "/v1/meta"; break;
      case "limits": path = "/v1/limits"; break;
      case "jobs": path = "/v1/jobs"; add("status", "client", "worker", "limit", "before", "consistency"); break;
      case "job": path = `/v1/jobs/${one(pos, "job-id")}`; add("consistency"); break;
      case "receipts": path = `/v1/jobs/${one(pos, "job-id")}/receipts`; add("consistency"); break;
      case "receipt": path = `/v1/receipts/${one(pos, "rcpt-id")}`; add("consistency"); break;
      case "proof": path = `/v1/jobs/${one(pos, "job-id")}/proof`; add("consistency"); break;
      case "wait": path = `/v1/jobs/${one(pos, "job-id")}/wait`; add("since", "timeout", "consistency"); break;
      case "badge": path = `/v1/jobs/${one(pos, "job-id")}/badge.svg`; add("consistency"); svg = true; break;
      case "tx": path = `/v1/transactions/${one(pos, "0x-hash")}`; break;
      default: throw new Usage(`Unknown command "${cmd}". Try --help.`);
    }
    if (flags.consistency && !["latest", "final"].includes(String(flags.consistency))) throw new Usage('--consistency must be "latest" or "final".');
    const url = `${base}${path}${q.toString() ? `?${q}` : ""}`;
    if (svg && flags.url) { io.out(url); return 0; }

    let res: Response;
    try { res = await io.fetch(url, { headers: { Accept: svg ? "image/svg+xml" : "application/json", "User-Agent": `allocyn-cli/${CLI_VERSION}` }, signal: AbortSignal.timeout(40_000) }); }
    catch (e) { io.err(`Could not reach ${base}: ${e instanceof Error ? e.message : String(e)}`); return 3; }
    const text = await res.text();
    if (svg && res.ok) { io.out(text); return 0; }
    let body: any;
    try { body = JSON.parse(text); } catch { if (svg) { io.err(`error ${res.status}: the API did not return JSON (the job may not exist).`); return 1; } io.err(`The answer from ${base} is not JSON (HTTP ${res.status}). Is that the Allocyn API?`); return 3; }
    if (!body || body.success !== true) {
      const e = body?.error ?? {};
      io.err(`error ${e.code ?? res.status}: ${e.message ?? "the API reported an error"}${e.field ? ` (field: ${e.field})` : ""}${e.retryable ? " [retryable]" : ""}`);
      if (flags.envelope) io.out(JSON.stringify(body, null, 2));
      return 1;
    }
    io.out(JSON.stringify(flags.envelope ? body : body.data, null, 2));
    return 0;
  } catch (e) {
    if (e instanceof Usage) { io.err(e.message); return 2; }
    io.err(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    return 3;
  }
}
