import type { AllocynClient } from "@allocyn/sdk";
import { ApiError } from "./http.ts";
import { buildProof, isFinalJob } from "./proof.ts";
import { buildBadge } from "./badge.ts";
import { listJobs, LIST_QUERY } from "./jobs-list.ts";
import { readCopyHealth } from "./copy-health.ts";
import { waitForJob, WAIT_QUERY } from "./wait.ts";
import { prepareAction, PREPARE_QUERY } from "./prepare.ts";
import { getStats, STATS_QUERY } from "./stats.ts";
import { getEvents, EVENTS_QUERY } from "./events.ts";
import { getAddressRecord } from "./addresses.ts";
import type { CopyReader } from "./copy.ts";
import type { QueryParam } from "./params.ts";

/**
 * The route table is the single source of truth: the router, the OpenAPI document and the
 * documentation tests are all generated from / checked against it. Every route is a GET: this API
 * only reads the contract. Writes are signed by the caller's own wallet through @allocyn/sdk.
 */
export interface Param { name: string; description: string; schema: Record<string, unknown>; example: string }
export interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  client: (consistency: "latest" | "final") => AllocynClient;
  defaultConsistency: "latest" | "final";
  probe: () => Promise<void>;
  now: () => Date;
  /** The request timeout in ms: long-running handlers must answer before it. */
  timeoutMs: number;
  /** How often a waiting handler re-reads the contract, in ms. */
  pollMs: number;
  /** Where the Allocyn web app lives, for links in prepared actions. Null when not configured. */
  appUrl: string | null;
  /** The optional database copy (public key, read only). Null when this server has none. */
  copy: CopyReader | null;
}
export interface Route {
  method: "GET";
  path: string;
  operationId: string;
  tag: "System" | "Jobs" | "Receipts" | "Transactions";
  summary: string;
  description: string;
  pathParams: Param[];
  /** Extra query parameters (besides consistency and deep), validated by params.ts. */
  query?: QueryParam[];
  /** Does this route accept ?consistency= ? */
  chainRead: boolean;
  /** Does this route accept ?deep= ? */
  deep?: boolean;
  cache: "no-store" | "short";
  schemaRef: string;
  /** false = not exposed as an MCP tool (e.g. routes that return an image). */
  mcp?: boolean;
  /** Set when the route answers with a file instead of the JSON envelope. The handler then returns the file's text. */
  contentType?: "image/svg+xml";
  /** Says when an answer can never change again, so a read with ?consistency=final may be cached for a long time. */
  finalWhen?: (data: any) => boolean;
  /** Statuses besides 200 the route can return (documented in OpenAPI). */
  errors: number[];
  handler: (ctx: Ctx, consistency: "latest" | "final") => Promise<unknown>;
}

const jobId: Param = { name: "jobId", description: 'Job id, e.g. "job-1". Ids are assigned by the contract: never invent one.', schema: { type: "string", pattern: "^job-[1-9][0-9]*$" }, example: "job-1" };
const address: Param = { name: "address", description: "A wallet address: 0x followed by 40 hex characters, in any letter case.", schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, example: "0x" + "b2".repeat(20) };
const receiptId: Param = { name: "receiptId", description: 'Receipt id, e.g. "rcpt-1".', schema: { type: "string", pattern: "^rcpt-[1-9][0-9]*$" }, example: "rcpt-1" };
const deliveryIndex: Param = { name: "deliveryIndex", description: "1-based delivery number within the job.", schema: { type: "integer", minimum: 1 }, example: "1" };
const txHash: Param = { name: "txHash", description: "GenLayer transaction hash: 0x followed by 64 hex characters.", schema: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, example: "0x" + "ab".repeat(32) };

export const ROUTES: Route[] = [
  {
    method: "GET", path: "/v1/health", operationId: "getHealth", tag: "System", summary: "Liveness",
    description: "Says the API process is up. Add `?deep=true` to also read the contract once (job-1) and report whether the network answers. A deep check that fails returns 503. With a database copy configured, a deep check also reports how old the copy is and how the last indexer run went (`copy`); a copy that is stale or unreachable never turns the check into a 503, because the contract is the source of truth.",
    pathParams: [], chainRead: false, deep: true, cache: "no-store", schemaRef: "Health", errors: [400, 429, 503],
    handler: async (ctx, _c) => {
      const base = { status: "ok" as const, time: ctx.now().toISOString(), checks: {} as Record<string, string> };
      if (ctx.query.get("deep") === "true") {
        try { await ctx.probe(); base.checks.chain = "ok"; }
        catch { throw new ApiError(503, "UPSTREAM_UNAVAILABLE", "The API is running but the GenLayer network did not answer.", { retryable: true }); }
        if (ctx.copy) {
          const copyHealth = await readCopyHealth(ctx.copy, ctx.now().getTime());
          base.checks.copy = copyHealth.check;
          return copyHealth.copy ? { ...base, copy: copyHealth.copy } : base;
        }
      }
      return base;
    },
  },
  {
    method: "GET", path: "/v1/meta", operationId: "getMeta", tag: "System", summary: "Network, contract and API facts",
    description: "Which network and contract this API reads, the contract profile it was built for, and the read consistency in use. No network call.",
    pathParams: [], chainRead: false, cache: "short", schemaRef: "Meta", errors: [429],
    handler: async (ctx, c) => ({ ...ctx.client(c).getMeta(), api: { version: "v1" } }),
  },
  {
    method: "GET", path: "/v1/limits", operationId: "getLimits", tag: "System", summary: "Input limits",
    description: "The limits the contract reports right now (`get_limits()`), next to the copy this API was built for. `matchesPinned: false` means the contract changed and this API needs an update. `client` holds the stricter limits applied by this deployment's SDK. Answers are cached for 60 s.",
    pathParams: [], chainRead: false, cache: "short", schemaRef: "Limits", errors: [429, 502],
    handler: async (ctx, c) => ctx.client(c).getLimits(),
  },
  {
    method: "GET", path: "/v1/jobs", operationId: "listJobs", tag: "Jobs", summary: "List jobs",
    description: "Jobs from newest to oldest, with an optional filter by `status`, `client` or `worker`. The contract has no list view, so this reads job ids one by one, at most 100 per request, and filters what it reads: a page can hold fewer than `limit` jobs while `nextCursor` is not null. Pass `nextCursor` as `before` to continue exactly where the scan stopped. With `source=copy` (or `auto`) the list is read from the optional database copy instead: one indexed query, pages are full, but the data is final-only and as old as `syncedAt`. The default stays `contract`, which is live.",
    pathParams: [], query: LIST_QUERY, chainRead: true, cache: "no-store", schemaRef: "JobList", errors: [400, 429, 502, 503],
    handler: async (ctx, c) => listJobs(ctx, c),
  },
  {
    method: "GET", path: "/v1/stats", operationId: "getStats", tag: "Jobs", summary: "Counts and statistics",
    description: "How many jobs there are in each status, and how many deliveries got each verdict, optionally for one `client` or one `worker`. The contract has no count view, so these numbers come from an optional database copy that an indexer fills from final reads. The answer says when the copy was last refreshed (`syncedAt`). It answers `503 COPY_UNAVAILABLE` on a server that has no copy configured.",
    pathParams: [], query: STATS_QUERY, chainRead: false, cache: "short", schemaRef: "Stats", errors: [400, 429, 502, 503],
    handler: async (ctx) => getStats(ctx),
  },
  {
    method: "GET", path: "/v1/events", operationId: "listEvents", tag: "Jobs", summary: "Feed of job events",
    description: "What changed in the jobs, oldest first: a job was created or accepted, a delivery came in or got its verdict, a status moved. Cursor based: pass the `cursor` of one answer as `after` in the next, and add `wait` (up to 25 s) to hold the request until something new arrives. Events are stored, so a client that was away can catch up. Read from the optional database copy, so `detectedAt` is when the indexer saw the change, not when it happened on the network. Nothing is pushed and there are no webhooks. `503 COPY_UNAVAILABLE` on a server with no copy.",
    pathParams: [], query: EVENTS_QUERY, chainRead: false, cache: "no-store", schemaRef: "EventFeed", errors: [400, 429, 502, 503],
    handler: async (ctx) => getEvents(ctx),
  },
  {
    method: "GET", path: "/v1/addresses/{address}", operationId: "getAddressRecord", tag: "Jobs", summary: "What the copy holds about an address",
    description: "For one wallet address: how many jobs it created (as client) and accepted (as worker) in each status, how many deliveries it made and the verdicts they got, and its five newest jobs on each side. Counts only: no score, no ranking and no guarantee. Read from the optional database copy, so it is as old as `syncedAt`. `503 COPY_UNAVAILABLE` on a server with no copy. Answers are cached for 30 seconds.",
    pathParams: [address], chainRead: false, cache: "short", schemaRef: "AddressRecord", errors: [400, 429, 502, 503],
    handler: async (ctx) => getAddressRecord(ctx),
  },
  {
    method: "GET", path: "/v1/jobs/{jobId}", operationId: "getJob", tag: "Jobs", summary: "Read a job",
    description: "The job's terms, parties, status and receipt ids, read from the contract. `integrity` reports whether the hashes recompute from the returned terms.",
    pathParams: [jobId], chainRead: true, cache: "no-store", schemaRef: "Job", errors: [400, 404, 429, 502], finalWhen: (d) => isFinalJob(d),
    handler: async (ctx, c) => ctx.client(c).getJob(ctx.params.jobId!),
  },
  {
    method: "GET", path: "/v1/jobs/{jobId}/proof", operationId: "getJobProof", tag: "Jobs", summary: "Proof pack of a job",
    description: "A portable proof pack, safe to save and send as a file (`format: \"allocyn.proof\"`, version 1). It holds: the contract it lives in, its terms, parties, status and every delivery with the per-criterion verdicts, plus a SHA-256 digest of those facts and the steps to check them against the contract yourself. The digest is not a signature. `final: true` means the job cannot change any more. Anyone can check a saved pack without trusting this API: `verifyProofPack()` in @allocyn/sdk or `allocyn verify proof.json --chain` re-read the contract and compare. The contract stores no transaction hashes, so the pack has none.",
    pathParams: [jobId], chainRead: true, cache: "no-store", schemaRef: "Proof", errors: [400, 404, 429, 502], finalWhen: (d) => d.final === true,
    handler: async (ctx, c) => buildProof(ctx, c),
  },
  {
    method: "GET", path: "/v1/jobs/{jobId}/badge.svg", operationId: "getJobBadge", tag: "Jobs", summary: "Status badge (SVG)",
    description: "A small SVG badge with the job's status, for a README or a portfolio: `![job](https://your-api/v1/jobs/job-1/badge.svg)`. It says what the contract says right now and nothing more. A missing or invalid job still answers with a badge, with the matching status code.",
    pathParams: [jobId], chainRead: true, cache: "short", schemaRef: "Badge", errors: [400, 404, 429, 502], mcp: false, contentType: "image/svg+xml",
    handler: async (ctx, c) => buildBadge(ctx, c),
  },
  {
    method: "GET", path: "/v1/jobs/{jobId}/wait", operationId: "waitForJob", tag: "Jobs", summary: "Wait for a job to change",
    description: "Long poll, instead of webhooks. Call it once without `since` to get the job and its `version`; call it again with that `version` as `since` and it answers when the job changes (a worker accepted, a delivery came in, validators judged) or when the wait ends with `changed: false`. Nothing is stored: if you miss an answer, ask again. The wait is capped by `timeout` (at most 25 s) and by the server's request timeout.",
    pathParams: [jobId], query: WAIT_QUERY, chainRead: true, cache: "no-store", schemaRef: "JobWait", errors: [400, 404, 429, 502, 504],
    handler: async (ctx, c) => waitForJob(ctx, c),
  },
  {
    method: "GET", path: "/v1/jobs/{jobId}/prepare", operationId: "prepareAction", tag: "Jobs", summary: "Prepare an action for the person to sign",
    description: "Checks whether accepting, delivering or evaluating is possible on this job right now, and says exactly what the person would sign: the contract call, the SDK call and a link to the Allocyn app. It only READS the contract: it builds no transaction, holds no key and sends nothing (`sent` is always false). The person signs in their own wallet, and the contract checks everything again at that moment. For an agent: use it to start a flow, never to act on someone's behalf.",
    pathParams: [jobId], query: PREPARE_QUERY, chainRead: true, cache: "no-store", schemaRef: "PreparedAction", errors: [400, 404, 429, 502],
    handler: async (ctx, c) => prepareAction(ctx, c),
  },
  {
    method: "GET", path: "/v1/jobs/{jobId}/receipts", operationId: "listJobReceipts", tag: "Receipts", summary: "List a job's receipts",
    description: "Every receipt of the job, in delivery order (delivery 1 first).",
    pathParams: [jobId], chainRead: true, cache: "no-store", schemaRef: "ReceiptList", errors: [400, 404, 429, 502],
    handler: async (ctx, c) => ctx.client(c).getJobReceipts(ctx.params.jobId!),
  },
  {
    method: "GET", path: "/v1/jobs/{jobId}/receipts/{deliveryIndex}", operationId: "getJobReceiptByIndex", tag: "Receipts", summary: "Read one receipt by delivery number",
    description: "The receipt of delivery N of a job. A receipt is EVALUATED once validators have judged it; before that `results` is empty.",
    pathParams: [jobId, deliveryIndex], chainRead: true, cache: "no-store", schemaRef: "Receipt", errors: [400, 404, 429, 502], finalWhen: (d) => d.status !== "PENDING",
    handler: async (ctx, c) => {
      const idx = ctx.params.deliveryIndex!;
      if (!/^[1-9][0-9]{0,5}$/.test(idx)) throw new ApiError(400, "INVALID_ARGUMENT", "deliveryIndex is a whole number starting at 1.", { field: "deliveryIndex" });
      return ctx.client(c).getReceiptByIndex(ctx.params.jobId!, Number(idx));
    },
  },
  {
    method: "GET", path: "/v1/receipts/{receiptId}", operationId: "getReceipt", tag: "Receipts", summary: "Read a receipt by id",
    description: "A receipt by its contract id.",
    pathParams: [receiptId], chainRead: true, cache: "no-store", schemaRef: "Receipt", errors: [400, 404, 429, 502], finalWhen: (d) => d.status !== "PENDING",
    handler: async (ctx, c) => ctx.client(c).getReceipt(ctx.params.receiptId!),
  },
  {
    method: "GET", path: "/v1/transactions/{txHash}", operationId: "getTransaction", tag: "Transactions", summary: "Track a transaction",
    description: "Where a transaction is in GenLayer consensus. Read-only. `decided: true` does NOT prove the change was recorded: read the job or receipt to confirm.",
    pathParams: [txHash], chainRead: false, cache: "no-store", schemaRef: "Transaction", errors: [400, 429, 502],
    handler: async (ctx, c) => ctx.client(c).getTransaction(ctx.params.txHash!),
  },
];

export interface Matched { route: Route; params: Record<string, string> }
const compiled = ROUTES.map((r) => ({ route: r, re: new RegExp("^" + r.path.replace(/\./g, "\\.").replace(/\{(\w+)\}/g, "(?<$1>[^/]+)") + "$") }));

/** Matches a path. Returns the route, or the methods that would have matched another method. */
export function matchRoute(method: string, pathname: string): Matched | "method" | null {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  let pathMatched = false;
  for (const c of compiled) {
    const m = c.re.exec(p);
    if (!m) continue;
    pathMatched = true;
    if (c.route.method === method) return { route: c.route, params: { ...(m.groups ?? {}) } };
  }
  return pathMatched ? "method" : null;
}
