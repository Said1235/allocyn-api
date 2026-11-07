import type { AllocynClient } from "@allocyn/sdk";
import { ApiError } from "./http.ts";

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
}
export interface Route {
  method: "GET";
  path: string;
  operationId: string;
  tag: "System" | "Jobs" | "Receipts" | "Transactions";
  summary: string;
  description: string;
  pathParams: Param[];
  /** Does this route accept ?consistency= ? */
  chainRead: boolean;
  /** Does this route accept ?deep= ? */
  deep?: boolean;
  cache: "no-store" | "short";
  schemaRef: string;
  /** Statuses besides 200 the route can return (documented in OpenAPI). */
  errors: number[];
  handler: (ctx: Ctx, consistency: "latest" | "final") => Promise<unknown>;
}

const jobId: Param = { name: "jobId", description: 'Job id, e.g. "job-1". Ids are assigned by the contract: never invent one.', schema: { type: "string", pattern: "^job-[1-9][0-9]*$" }, example: "job-1" };
const receiptId: Param = { name: "receiptId", description: 'Receipt id, e.g. "rcpt-1".', schema: { type: "string", pattern: "^rcpt-[1-9][0-9]*$" }, example: "rcpt-1" };
const deliveryIndex: Param = { name: "deliveryIndex", description: "1-based delivery number within the job.", schema: { type: "integer", minimum: 1 }, example: "1" };
const txHash: Param = { name: "txHash", description: "GenLayer transaction hash: 0x followed by 64 hex characters.", schema: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, example: "0x" + "ab".repeat(32) };

export const ROUTES: Route[] = [
  {
    method: "GET", path: "/v1/health", operationId: "getHealth", tag: "System", summary: "Liveness",
    description: "Says the API process is up. Add `?deep=true` to also read the contract once (job-1) and report whether the network answers. A deep check that fails returns 503.",
    pathParams: [], chainRead: false, deep: true, cache: "no-store", schemaRef: "Health", errors: [400, 429, 503],
    handler: async (ctx, _c) => {
      const base = { status: "ok" as const, time: ctx.now().toISOString(), checks: {} as Record<string, string> };
      if (ctx.query.get("deep") === "true") {
        try { await ctx.probe(); base.checks.chain = "ok"; }
        catch { throw new ApiError(503, "UPSTREAM_UNAVAILABLE", "The API is running but the GenLayer network did not answer.", { retryable: true }); }
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
    method: "GET", path: "/v1/jobs/{jobId}", operationId: "getJob", tag: "Jobs", summary: "Read a job",
    description: "The job's terms, parties, status and receipt ids, read from the contract. `integrity` reports whether the hashes recompute from the returned terms.",
    pathParams: [jobId], chainRead: true, cache: "no-store", schemaRef: "Job", errors: [400, 404, 429, 502],
    handler: async (ctx, c) => ctx.client(c).getJob(ctx.params.jobId!),
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
    pathParams: [jobId, deliveryIndex], chainRead: true, cache: "no-store", schemaRef: "Receipt", errors: [400, 404, 429, 502],
    handler: async (ctx, c) => {
      const idx = ctx.params.deliveryIndex!;
      if (!/^[1-9][0-9]{0,5}$/.test(idx)) throw new ApiError(400, "INVALID_ARGUMENT", "deliveryIndex is a whole number starting at 1.", { field: "deliveryIndex" });
      return ctx.client(c).getReceiptByIndex(ctx.params.jobId!, Number(idx));
    },
  },
  {
    method: "GET", path: "/v1/receipts/{receiptId}", operationId: "getReceipt", tag: "Receipts", summary: "Read a receipt by id",
    description: "A receipt by its contract id.",
    pathParams: [receiptId], chainRead: true, cache: "no-store", schemaRef: "Receipt", errors: [400, 404, 429, 502],
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
const compiled = ROUTES.map((r) => ({ route: r, re: new RegExp("^" + r.path.replace(/\{(\w+)\}/g, "(?<$1>[^/]+)") + "$") }));

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
