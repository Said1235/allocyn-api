/**
 * Read-only access to the optional database copy (Supabase). The API function only ever holds the PUBLIC key,
 * which Supabase row level security limits to reading jobs, receipts and the public part of the index status.
 * Plain fetch, no dependency. Keys go in the `apikey` header only: the new Supabase keys are not JWTs.
 */

export interface CopyStatus {
  lastJobNumber: number;
  lastRunAt: string | null;
  contract: string | null;
  network: string | null;
}

export interface CopyJobRow { id: string; job_number: number; title: string; status: string; client: string; worker: string | null; delivery_count: number }

export interface CopyStatsRaw {
  jobs: { total: number; byStatus: Record<string, number> };
  receipts: { total: number; byOutcome: Record<string, number> } | null;
}

export interface CopyEventRow { id: number; created_at: string; job_id: string; type: string; from_status: string | null; to_status: string | null; client: string; worker: string | null; data: Record<string, unknown> }

export interface CopyRun { ok: boolean; finishedAt: string; newJobs: number; refreshedJobs: number; receipts: number; failedRows: number; rounds: number }

export interface CopyReader {
  /** The public part of the indexer's state, or null when the indexer has never written it. */
  status(): Promise<CopyStatus | null>;
  /** Exact number of rows that match the PostgREST filters, e.g. `{ status: "eq.OPEN", worker: "eq.0x…" }`. */
  count(table: "jobs" | "receipts", filters: Record<string, string>): Promise<number>;
  /** Jobs newest first, one indexed query. `before` keeps only job numbers lower than it. */
  listJobs(o: { filters: Record<string, string>; before?: number; limit: number; search?: string; updatedSince?: string }): Promise<CopyJobRow[]>;
  /** All the counts of /v1/stats in one call (the `job_stats` function). A 404 `CopyError` means the migration is not applied. */
  stats(o: { client: string | null; worker: string | null }): Promise<CopyStatsRaw>;
  /** Job events in ascending id order. With `after`: those with a higher id. Without it: the newest `limit` of them. */
  listEvents(o: { filters: Record<string, string>; after?: number; limit: number }): Promise<CopyEventRow[]>;
  /** The newest indexer run, or null when none was recorded. */
  lastRun(): Promise<CopyRun | null>;
}

export class CopyError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) { super(message); this.name = "CopyError"; this.status = status; }
}

/** Throws when the key could write: a Supabase secret key, or a legacy key whose role is service_role. */
export function assertPublicKey(key: string): void {
  if (/^sb_secret_/i.test(key)) throw new CopyError("That is a Supabase secret key. The API only accepts the public (publishable) key.");
  if (key.startsWith("eyJ")) {
    try {
      const payload = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8"));
      if (payload && payload.role === "service_role") throw new CopyError("That is a service_role key. The API only accepts the public (publishable or anon) key.");
    } catch (e) { if (e instanceof CopyError) throw e; /* not a readable JWT: let Supabase judge it */ }
  }
}

export interface CopyReaderOptions { url: string; key: string; fetch?: typeof fetch; timeoutMs?: number }

export function createCopyReader(o: CopyReaderOptions): CopyReader {
  let base: URL;
  try { base = new URL(o.url); } catch { throw new CopyError("The database URL must be an absolute URL."); }
  const local = base.hostname === "localhost" || base.hostname === "127.0.0.1";
  if (base.protocol !== "https:" && !local) throw new CopyError("The database URL must use https.");
  if (!o.key) throw new CopyError("A public key is required.");
  assertPublicKey(o.key);
  const f = o.fetch ?? fetch;

  // POST exists for one reason: calling the read-only `job_stats` function. Nothing here writes a row.
  async function call(method: "GET" | "HEAD" | "POST", pathAndQuery: string, count = false, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await f(`${base.origin}/rest/v1/${pathAndQuery}`, {
        method,
        headers: { apikey: o.key, "User-Agent": "allocyn-api/1", Accept: "application/json", ...(count ? { Prefer: "count=exact" } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(o.timeoutMs ?? 6000),
      });
    } catch (e) {
      throw new CopyError(`Could not reach the database copy: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new CopyError(`The database copy answered ${res.status}.`, res.status);
    return res;
  }

  return {
    async status() {
      const res = await call("GET", "indexer_state?id=eq.1&select=last_job_number,last_run_at,contract_address,network");
      const rows = (await res.json()) as Array<{ last_job_number: number; last_run_at: string | null; contract_address: string | null; network: string | null }>;
      const r = rows[0];
      if (!r) return null;
      return { lastJobNumber: r.last_job_number, lastRunAt: r.last_run_at, contract: r.contract_address, network: r.network };
    },
    async count(table, filters) {
      const q = new URLSearchParams({ select: "id", ...filters });
      const res = await call("HEAD", `${table}?${q.toString()}`, true);
      const m = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
      if (!m) throw new CopyError("The database copy did not return a row count.");
      return Number(m[1]);
    },
    async listJobs({ filters, before, limit, search, updatedSince }) {
      const q = new URLSearchParams({ select: "id,job_number,title,status,client,worker,delivery_count", order: "job_number.desc", limit: String(Math.max(1, Math.floor(limit))), ...filters });
      if (before !== undefined) q.set("job_number", `lt.${Math.floor(before)}`);
      if (search) q.set("search", `plfts(simple).${search}`);
      if (updatedSince) q.set("updated_at", `gte.${updatedSince}`);
      const rows = await (await call("GET", `jobs?${q.toString()}`)).json();
      if (!Array.isArray(rows)) throw new CopyError("The database copy returned an unexpected answer.");
      return rows as CopyJobRow[];
    },
    async stats({ client, worker }) {
      const out = (await (await call("POST", "rpc/job_stats", false, { p_client: client, p_worker: worker })).json()) as CopyStatsRaw | null;
      const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
      if (!out || !out.jobs || !num(out.jobs.total) || (out.receipts !== null && (!out.receipts || !num(out.receipts.total)))) throw new CopyError("The database copy returned unexpected statistics.");
      return out;
    },
    async listEvents({ filters, after, limit }) {
      const q = new URLSearchParams({ select: "id,created_at,job_id,type,from_status,to_status,client,worker,data", limit: String(Math.max(1, Math.floor(limit))), ...filters });
      if (after !== undefined) { q.set("id", `gt.${Math.floor(after)}`); q.set("order", "id.asc"); } else q.set("order", "id.desc");
      const rows = await (await call("GET", `job_events?${q.toString()}`)).json();
      if (!Array.isArray(rows)) throw new CopyError("The database copy returned an unexpected answer.");
      return (after !== undefined ? rows : rows.reverse()) as CopyEventRow[];
    },
    async lastRun() {
      const res = await call("GET", "indexer_runs?select=ok,finished_at,new_jobs,refreshed_jobs,receipts,failed_rows,rounds&order=finished_at.desc&limit=1");
      const r = ((await res.json()) as Array<{ ok: boolean; finished_at: string; new_jobs: number; refreshed_jobs: number; receipts: number; failed_rows: number; rounds: number }>)[0];
      return r ? { ok: r.ok, finishedAt: new Date(r.finished_at).toISOString(), newJobs: r.new_jobs, refreshedJobs: r.refreshed_jobs, receipts: r.receipts, failedRows: r.failed_rows, rounds: r.rounds } : null;
    },
  };
}
