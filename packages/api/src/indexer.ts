import { AllocynError } from "@allocyn/sdk";
import type { AllocynClient, JobDto, ReceiptDto } from "@allocyn/sdk";
import { latestJobNumber } from "./jobs-list.ts";

/**
 * Copies public contract data into a Postgres table (Supabase) so lists and counts do not have to scan the chain.
 * The contract stays the source of truth: this only ever reads the contract with a read-only client and
 * writes rows that can be rebuilt at any time. Nothing here signs, sends or holds a wallet key.
 *
 * Only `final` reads should be passed in, so the copy never holds something the network could still change.
 */

export interface JobRow {
  id: string; title: string; description: string; criteria: unknown; client: string; worker: string | null;
  status: string; delivery_count: number; receipt_ids: string[]; terms_hash: string | null; agreement_hash: string | null;
  integrity: unknown; synced_at: string;
}
export interface ReceiptRow {
  id: string; job_id: string; delivery_index: number; worker: string; url: string; status: string;
  agreement_hash: string | null; evidence_hash: string | null; evidence_size: number | null; overall_status: string | null;
  evaluation_requested_by: string | null; results: unknown; synced_at: string;
}

export interface IndexStore {
  /** `contract` is null until the first run has recorded which contract this database mirrors. */
  getState(): Promise<{ lastJobNumber: number; contract: string | null }>;
  /** Jobs that can still change (anything but VERIFIED), the ones synced longest ago first. */
  staleJobIds(limit: number): Promise<string[]>;
  upsertJobs(rows: JobRow[]): Promise<void>;
  upsertReceipts(rows: ReceiptRow[]): Promise<void>;
  saveState(state: { lastJobNumber: number; lastError: string | null; contract: string; network: string }, now: Date): Promise<void>;
  /** Writes one row to `indexer_runs` and keeps the newest 200. Best effort: the caller ignores a failure here. */
  recordRun?(run: RunRecord): Promise<void>;
}

export interface RunRecord { startedAt: Date; finishedAt: Date; ok: boolean; newJobs: number; refreshedJobs: number; receipts: number; failedRows: number; rounds: number; lastJobNumber: number | null; error: string | null }

export class IndexerError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) { super(message); this.name = "IndexerError"; this.status = status; }
}

export function jobRow(j: JobDto, now: Date): JobRow {
  return {
    id: j.id, title: j.title, description: j.description, criteria: j.criteria, client: j.client, worker: j.worker,
    status: j.status, delivery_count: j.deliveryCount, receipt_ids: j.receiptIds, terms_hash: j.termsHash,
    agreement_hash: j.agreementHash, integrity: j.integrity, synced_at: now.toISOString(),
  };
}
export function receiptRow(r: ReceiptDto, now: Date): ReceiptRow {
  return {
    id: r.id, job_id: r.jobId, delivery_index: r.deliveryIndex, worker: r.worker, url: r.url, status: r.status,
    agreement_hash: r.agreementHash, evidence_hash: r.evidenceHash, evidence_size: r.evidenceSize,
    overall_status: r.overallStatus, evaluation_requested_by: r.evaluationRequestedBy, results: r.results,
    synced_at: now.toISOString(),
  };
}

export interface IndexResult {
  latest: number;
  /** Highest job number the stored position now points at. */
  position: number;
  newJobs: number;
  refreshedJobs: number;
  receipts: number;
  /** Numbers that the contract said did not exist, although they are below the newest one. */
  missing: string[];
  /** Rows the database refused. They are skipped so one bad row cannot stop the rest. */
  failed: Array<{ id: string; reason: string }>;
}

export interface RunOptions {
  client: AllocynClient;
  store: IndexStore;
  /** Network name, stored next to the contract address for whoever reads the database. */
  network: string;
  now?: () => Date;
  /** New jobs read per run, at most. */
  maxNew?: number;
  /** Already-stored jobs that can still change, re-read per run, at most. */
  maxRefresh?: number;
  /** Reads in parallel. */
  concurrency?: number;
}

async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

export async function runIndexer(opts: RunOptions): Promise<IndexResult> {
  const { client, store } = opts;
  const now = opts.now ?? (() => new Date());
  const maxNew = opts.maxNew ?? 40, maxRefresh = opts.maxRefresh ?? 20, conc = opts.concurrency ?? 5;
  const started = now();
  const latest = await latestJobNumber(client, started.getTime());
  const { lastJobNumber, contract } = await store.getState();
  // One database mirrors one contract. Mixing two would show jobs that do not belong together.
  if (contract !== null && contract.toLowerCase() !== client.contractAddress.toLowerCase()) {
    throw new IndexerError(`This database mirrors ${contract}, not ${client.contractAddress}. Use another database or clear the tables first.`);
  }

  const to = Math.min(latest, lastJobNumber + maxNew);
  const fresh: string[] = [];
  for (let n = lastJobNumber + 1; n <= to; n++) fresh.push(`job-${n}`);
  const freshSet = new Set(fresh);
  const stale = (await store.staleJobIds(maxRefresh)).filter((id) => !freshSet.has(id));

  const missing: string[] = [];
  const read = async (id: string): Promise<{ job: JobDto; receipts: ReceiptDto[] } | null> => {
    try {
      const job = await client.getJob(id);
      const receipts = job.receiptIds.length ? await client.getJobReceipts(id) : [];
      return { job, receipts };
    } catch (e) {
      if (e instanceof AllocynError && e.code === "JOB_NOT_FOUND") { missing.push(id); return null; }
      throw e;
    }
  };
  const got = (await mapLimit([...fresh, ...stale], conc, read)).filter((x): x is { job: JobDto; receipts: ReceiptDto[] } => x !== null);

  const at = now();
  const failed: IndexResult["failed"] = [];
  const jobRows = got.map((g) => jobRow(g.job, at));
  const okJobs = await writeRows(jobRows, (r) => store.upsertJobs(r), (r) => r.id, failed);
  // A receipt needs its job to exist first, so only the receipts of jobs that were stored go in.
  const stored = new Set(okJobs);
  const receiptRows = got.filter((g) => stored.has(g.job.id)).flatMap((g) => g.receipts.map((r) => receiptRow(r, at)));
  const okReceipts = await writeRows(receiptRows, (r) => store.upsertReceipts(r), (r) => r.id, failed);

  const failedIds = failed.map((f) => `${f.id}: ${f.reason}`);
  await store.saveState({ lastJobNumber: to, lastError: failedIds.length ? failedIds.slice(0, 5).join("; ").slice(0, 500) : null, contract: client.contractAddress, network: opts.network }, at);

  return {
    latest, position: to, newJobs: fresh.length - fresh.filter((id) => missing.includes(id)).length,
    refreshedJobs: stale.length - stale.filter((id) => missing.includes(id)).length,
    receipts: okReceipts.length, missing, failed,
  };
}

/** Writes in chunks. When a chunk is refused, retries its rows one by one to find the bad ones. */
async function writeRows<T>(rows: T[], write: (rows: T[]) => Promise<void>, id: (r: T) => string, failed: IndexResult["failed"]): Promise<string[]> {
  const ok: string[] = [];
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    try { await write(chunk); ok.push(...chunk.map(id)); continue; }
    catch (e) {
      // A network or key problem would fail every row: stop instead of retrying hundreds of times.
      if (!(e instanceof IndexerError) || e.status === undefined || e.status === 401 || e.status === 403 || e.status >= 500) throw e;
    }
    for (const r of chunk) {
      try { await write([r]); ok.push(id(r)); }
      catch (e) {
        if (!(e instanceof IndexerError) || e.status === undefined || e.status === 401 || e.status === 403 || e.status >= 500) throw e;
        failed.push({ id: id(r), reason: e.message.slice(0, 160) });
      }
    }
  }
  return ok;
}

// ---------- Supabase over its REST API (PostgREST), with plain fetch ----------

export interface SupabaseStoreOptions {
  url: string;
  /** A secret key (sb_secret_...) or the legacy service_role key. Sent in the `apikey` header only. */
  secretKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createSupabaseStore(o: SupabaseStoreOptions): IndexStore {
  let base: URL;
  try { base = new URL(o.url); } catch { throw new IndexerError("SUPABASE_URL must be an absolute URL."); }
  const local = base.hostname === "localhost" || base.hostname === "127.0.0.1";
  if (base.protocol !== "https:" && !local) throw new IndexerError("SUPABASE_URL must use https.");
  if (!o.secretKey) throw new IndexerError("A Supabase secret key is required.");
  const f = o.fetch ?? fetch;
  const origin = base.origin;

  async function call(method: string, pathAndQuery: string, body?: unknown, prefer?: string): Promise<unknown> {
    let res: Response;
    try {
      res = await f(`${origin}/rest/v1/${pathAndQuery}`, {
        method,
        // Secret keys are not JWTs: they go in `apikey` only, never in `Authorization`. The user agent must not look like a browser.
        headers: {
          apikey: o.secretKey, "User-Agent": "allocyn-indexer/1", Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(prefer ? { Prefer: prefer } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs ?? 20000),
      });
    } catch (e) {
      throw new IndexerError(`Could not reach the database: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try { const j = JSON.parse(text); detail = [j.code, j.message].filter(Boolean).join(" ") || detail; } catch { /* keep the raw text */ }
      throw new IndexerError(`Database answered ${res.status}: ${detail}`, res.status);
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    async getState() {
      const rows = (await call("GET", "indexer_state?id=eq.1&select=last_job_number,contract_address")) as Array<{ last_job_number: number; contract_address: string | null }>;
      if (!rows[0]) throw new IndexerError("The indexer_state row is missing. Apply the migrations first.");
      return { lastJobNumber: rows[0].last_job_number, contract: rows[0].contract_address };
    },
    async staleJobIds(limit) {
      const rows = (await call("GET", `jobs?status=neq.VERIFIED&select=id&order=synced_at.asc&limit=${Math.max(0, Math.floor(limit))}`)) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    },
    async upsertJobs(rows) { if (rows.length) await call("POST", "jobs?on_conflict=id", rows, "resolution=merge-duplicates,return=minimal"); },
    async upsertReceipts(rows) { if (rows.length) await call("POST", "receipts?on_conflict=id", rows, "resolution=merge-duplicates,return=minimal"); },
    async recordRun(r) {
      const rows = (await call("POST", "indexer_runs", {
        started_at: r.startedAt.toISOString(), finished_at: r.finishedAt.toISOString(), ok: r.ok, new_jobs: r.newJobs, refreshed_jobs: r.refreshedJobs,
        receipts: r.receipts, failed_rows: r.failedRows, rounds: r.rounds, last_job_number: r.lastJobNumber, error: r.error ? r.error.slice(0, 500) : null,
      }, "return=representation")) as Array<{ id: number }>;
      const id = rows[0]?.id;
      if (id && id > 200) await call("DELETE", `indexer_runs?id=lte.${id - 200}`, undefined, "return=minimal");
    },
    async saveState(s, now) {
      await call("PATCH", "indexer_state?id=eq.1", { last_job_number: s.lastJobNumber, last_run_at: now.toISOString(), last_error: s.lastError, contract_address: s.contract, network: s.network }, "return=minimal");
    },
  };
}
