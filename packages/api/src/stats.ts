import { ApiError } from "./http.ts";
import { CopyError } from "./copy.ts";
import type { CopyReader } from "./copy.ts";
import type { Ctx } from "./routes.ts";
import type { QueryParam } from "./params.ts";

const JOB_STATUSES = ["OPEN", "IN_PROGRESS", "VERIFIED", "NEEDS_REVISION", "INCONCLUSIVE"] as const;
const OUTCOMES = ["VERIFIED", "NEEDS_REVISION", "INCONCLUSIVE"] as const;
const TTL_MS = 30_000;

export const STATS_QUERY: QueryParam[] = [
  { name: "client", description: "Count only the jobs created by this address. Deliveries are then not counted.", schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, example: "0x" + "a1".repeat(20) },
  { name: "worker", description: "Count only the jobs accepted by this address, and the deliveries made by it.", schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, example: "0x" + "b2".repeat(20) },
];

export interface Stats {
  source: "copy";
  contract: string | null;
  network: string | null;
  /** When the indexer last ran. Null if it never has. */
  syncedAt: string | null;
  /** The newest job id the copy has reached, or null when it holds none. */
  copiedThrough: string | null;
  filter: { client: string | null; worker: string | null };
  jobs: { total: number; byStatus: Record<(typeof JOB_STATUSES)[number], number> };
  /** Null when filtering by client: deliveries are tied to the worker, not to the client. */
  receipts: { total: number; byOutcome: Record<(typeof OUTCOMES)[number] | "PENDING", number> } | null;
  notes: string[];
}

const cache = new WeakMap<CopyReader, Map<string, { at: number; data: Stats }>>();

type Raw = Pick<Stats, "jobs" | "receipts">;

/** The old way: one exact count per number. Used when the `job_stats` function is not in the database yet. */
async function viaCounts(copy: CopyReader, client: string | null, worker: string | null): Promise<Raw> {
  const jobFilter: Record<string, string> = { ...(client ? { client: `eq.${client}` } : {}), ...(worker ? { worker: `eq.${worker}` } : {}) };
  const receiptFilter: Record<string, string> = worker ? { worker: `eq.${worker}` } : {};
  const [jobTotal, jobCounts, receipts] = await Promise.all([
    copy.count("jobs", jobFilter),
    Promise.all(JOB_STATUSES.map((s) => copy.count("jobs", { ...jobFilter, status: `eq.${s}` }))),
    client ? Promise.resolve(null) : Promise.all([
      copy.count("receipts", receiptFilter),
      ...OUTCOMES.map((o) => copy.count("receipts", { ...receiptFilter, overall_status: `eq.${o}` })),
      copy.count("receipts", { ...receiptFilter, status: "eq.PENDING" }),
    ]),
  ]);
  return {
    jobs: { total: jobTotal, byStatus: Object.fromEntries(JOB_STATUSES.map((s, i) => [s, jobCounts[i]!])) as Stats["jobs"]["byStatus"] },
    receipts: receipts && { total: receipts[0]!, byOutcome: { VERIFIED: receipts[1]!, NEEDS_REVISION: receipts[2]!, INCONCLUSIVE: receipts[3]!, PENDING: receipts[4]! } },
  };
}

/** One call to the `job_stats` function; if the database does not have it (404), the counts are made one by one. */
export async function readRaw(copy: CopyReader, client: string | null, worker: string | null): Promise<Raw> {
  try { return (await copy.stats({ client, worker })) as Raw; }
  catch (e) { if (e instanceof CopyError && e.status === 404) return viaCounts(copy, client, worker); throw e; }
}

export async function getStats(ctx: Ctx): Promise<Stats> {
  const copy = ctx.copy;
  if (!copy) throw new ApiError(503, "COPY_UNAVAILABLE", "This server has no database copy configured, so it cannot give statistics.", { retryable: false });
  const q = ctx.query;
  const client = q.get("client")?.toLowerCase() ?? null;
  const worker = q.get("worker")?.toLowerCase() ?? null;

  const key = `${client ?? ""}|${worker ?? ""}`;
  const now = ctx.now().getTime();
  const store = cache.get(copy) ?? new Map();
  cache.set(copy, store);
  const hit = store.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.data;

  try {
    const [status, raw] = await Promise.all([copy.status(), readRaw(copy, client, worker)]);
    const data: Stats = {
      source: "copy",
      contract: status?.contract ?? null, network: status?.network ?? null,
      syncedAt: status?.lastRunAt ? new Date(status.lastRunAt).toISOString() : null,
      copiedThrough: status && status.lastJobNumber > 0 ? `job-${status.lastJobNumber}` : null,
      filter: { client, worker },
      jobs: raw.jobs,
      receipts: raw.receipts,
      notes: [
        "These counts come from a copy of the contract's final reads, refreshed by an indexer. Check `syncedAt`: jobs created since then are not counted yet.",
        "`byOutcome` counts deliveries by the verdict the validators gave. `PENDING` are waiting to be judged. A delivery replaced before it was judged is only in `total`.",
        "To rely on one job, read that job: this is a summary, not proof.",
      ],
    };
    store.set(key, { at: now, data });
    return data;
  } catch (e) {
    if (e instanceof CopyError) throw new ApiError(502, "UPSTREAM_UNAVAILABLE", "The database copy did not answer. Try again later.", { retryable: true });
    throw e;
  }
}
