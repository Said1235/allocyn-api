import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the few PostgREST calls the indexer makes, with in-memory tables.
 * It enforces the rules the real tables enforce (key header, address format, status values, the receipt to job link),
 * so the tests exercise those paths. It is NOT Supabase: it proves our requests, not the hosted service.
 */
export interface FakeDb {
  url: string;
  key: string;
  jobs: Map<string, any>;
  receipts: Map<string, any>;
  state: { last_job_number: number; last_run_at: string | null; last_error: string | null; contract_address: string | null; network: string | null };
  /** Every request seen: method, path with query, headers of interest and parsed body. */
  log: Array<{ method: string; target: string; apikey: string | undefined; authorization: string | undefined; ua: string | undefined; body: any }>;
  /** Job ids the "database" refuses with a 400, as a check constraint would. */
  rejectIds: Set<string>;
  /** True: behave like the public role (the private column of indexer_state is refused). */
  publicRole: boolean;
  /** Rows of indexer_runs, oldest first. */
  runs: any[];
  /** False: the `job_stats` function is missing, as before its migration (PostgREST answers 404). */
  rpcEnabled: boolean;
  /** When set, every request answers with this status (a downed or locked database). */
  forceStatus: number | null;
  close(): Promise<void>;
}

const ADDR = /^0x[0-9a-f]{40}$/;
const STATUS = new Set(["OPEN", "IN_PROGRESS", "VERIFIED", "NEEDS_REVISION", "INCONCLUSIVE"]);

export async function startFakePostgrest(key = "sb_secret_test_key_123"): Promise<FakeDb> {
  const db: FakeDb = {
    url: "", key, jobs: new Map(), receipts: new Map(), log: [], rejectIds: new Set(), forceStatus: null, publicRole: false, runs: [], rpcEnabled: true,
    state: { last_job_number: 0, last_run_at: null, last_error: null, contract_address: null, network: null },
    close: async () => {},
  };
  const send = (res: http.ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : undefined;
      const target = req.url ?? "";
      db.log.push({ method: req.method ?? "", target, apikey: req.headers.apikey as string | undefined, authorization: req.headers.authorization, ua: req.headers["user-agent"], body });
      if (db.forceStatus) return send(res, db.forceStatus, { message: "forced" });
      if (req.headers.apikey !== db.key) return send(res, 401, { message: "Invalid API key" });
      if (req.headers.authorization) return send(res, 401, { message: "Invalid JWT" }); // what the platform does with a non-JWT key in Authorization
      const u = new URL(target, "http://x");
      const table = u.pathname.replace("/rest/v1/", "");

      if (table === "indexer_state") {
        if (req.method === "GET") {
          // The public role may read only these columns (the real table grants exactly them); last_error stays private.
          const asked = (u.searchParams.get("select") ?? "").split(",");
          if (asked.includes("last_error") && db.publicRole) return send(res, 403, { code: "42501", message: "permission denied for table indexer_state" });
          return send(res, 200, [{ last_job_number: db.state.last_job_number, last_run_at: db.state.last_run_at, contract_address: db.state.contract_address, network: db.state.network }]);
        }
        if (req.method === "PATCH") { Object.assign(db.state, body); return send(res, 204); }
      }
      if (table === "rpc/job_stats" && req.method === "POST") {
        if (!db.rpcEnabled) return send(res, 404, { code: "PGRST202", message: "Could not find the function public.job_stats in the schema cache" });
        const { p_client, p_worker } = body ?? {};
        const js = [...db.jobs.values()].filter((j) => (!p_client || j.client === String(p_client).toLowerCase()) && (!p_worker || j.worker === String(p_worker).toLowerCase()));
        const rs = p_client ? null : [...db.receipts.values()].filter((r) => !p_worker || r.worker === String(p_worker).toLowerCase());
        const n = (rows: any[], f: (r: any) => boolean) => rows.filter(f).length;
        return send(res, 200, {
          jobs: { total: js.length, byStatus: Object.fromEntries([...STATUS].map((s) => [s, n(js, (j) => j.status === s)])) },
          receipts: rs && { total: rs.length, byOutcome: { VERIFIED: n(rs, (r) => r.overall_status === "VERIFIED"), NEEDS_REVISION: n(rs, (r) => r.overall_status === "NEEDS_REVISION"), INCONCLUSIVE: n(rs, (r) => r.overall_status === "INCONCLUSIVE"), PENDING: n(rs, (r) => r.status === "PENDING") } },
        });
      }
      if (table === "indexer_runs") {
        if (req.method === "GET") {
          if ((u.searchParams.get("select") ?? "").split(",").includes("error") && db.publicRole) return send(res, 403, { code: "42501", message: "permission denied for table indexer_runs" });
          return send(res, 200, [...db.runs].sort((a, b) => b.finished_at.localeCompare(a.finished_at)).slice(0, Number(u.searchParams.get("limit") ?? 1000)));
        }
        if (req.method === "POST") { const id = (db.runs.at(-1)?.id ?? 0) + 1; db.runs.push({ id, ...body }); return send(res, 201, [{ id }]); }
        if (req.method === "DELETE") { const m = /^lte\.(\d+)$/.exec(u.searchParams.get("id") ?? ""); if (m) db.runs = db.runs.filter((r) => r.id > Number(m[1])); return send(res, 204); }
      }
      if ((table === "jobs" || table === "receipts") && req.method === "HEAD") {
        // select=id plus PostgREST filters (col=eq.value, col=is.null). Answers with the exact count in Content-Range.
        const rows = [...(table === "jobs" ? db.jobs : db.receipts).values()].filter((r) => {
          for (const [col, f] of u.searchParams) {
            if (["select", "order", "limit"].includes(col)) continue;
            if (f.startsWith("eq.")) { if (String(r[col]) !== f.slice(3)) return false; }
            else if (f === "is.null") { if (r[col] !== null && r[col] !== undefined) return false; }
            else return false;
          }
          return true;
        });
        res.writeHead(200, { "Content-Range": rows.length ? `0-${rows.length - 1}/${rows.length}` : "*/0" });
        return res.end();
      }
      if (table === "jobs" && req.method === "GET" && u.searchParams.get("order") === "job_number.desc") {
        // The public list: filters on status/client/worker, a job_number upper bound, newest first.
        const lim = Number(u.searchParams.get("limit") ?? 1000);
        const lt = u.searchParams.get("job_number");
        const cols = (u.searchParams.get("select") ?? "").split(",");
        const num = (j: any) => Number(String(j.id).slice(4));
        const rows = [...db.jobs.values()].filter((j) => {
          for (const c of ["status", "client", "worker"]) { const f = u.searchParams.get(c); if (f?.startsWith("eq.") && String(j[c]) !== f.slice(3)) return false; }
          const q = u.searchParams.get("search");
          if (q?.startsWith("plfts(simple).")) { const hay = `${j.title ?? ""} ${j.description ?? ""}`.toLowerCase(); if (!q.slice(14).toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false; }
          const up = u.searchParams.get("updated_at");
          if (up?.startsWith("gte.") && !(j.updated_at && j.updated_at >= up.slice(4))) return false;
          return !lt || num(j) < Number(lt.slice(3));
        }).sort((a, b) => num(b) - num(a)).slice(0, lim);
        return send(res, 200, rows.map((j) => Object.fromEntries(cols.map((c) => [c, c === "job_number" ? num(j) : j[c] ?? null]))));
      }
      if (table === "jobs" && req.method === "GET") {
        const lim = Number(u.searchParams.get("limit") ?? 1000);
        const rows = [...db.jobs.values()].filter((j) => j.status !== "VERIFIED").sort((a, b) => a.synced_at.localeCompare(b.synced_at)).slice(0, lim);
        return send(res, 200, rows.map((j) => ({ id: j.id })));
      }
      if (req.method === "POST" && (table === "jobs" || table === "receipts") && u.searchParams.get("on_conflict") === "id") {
        if (!String(req.headers.prefer).includes("resolution=merge-duplicates")) return send(res, 400, { message: "missing merge-duplicates" });
        const rows: any[] = body;
        for (const r of rows) {
          if (table === "jobs") {
            if ("job_number" in r) return send(res, 400, { code: "428C9", message: "cannot insert a non-DEFAULT value into column job_number" });
            if (db.rejectIds.has(r.id)) return send(res, 400, { code: "23514", message: `new row for relation "jobs" violates check constraint (${r.id})` });
            if (!/^job-[1-9][0-9]{0,8}$/.test(r.id) || !ADDR.test(r.client) || (r.worker !== null && !ADDR.test(r.worker)) || !STATUS.has(r.status))
              return send(res, 400, { code: "23514", message: `new row for relation "jobs" violates check constraint (${r.id})` });
          } else if (!db.jobs.has(r.job_id)) {
            return send(res, 409, { code: "23503", message: "violates foreign key constraint" });
          }
        }
        // PostgREST applies a batch atomically: a bad row refuses the whole request.
        for (const r of rows) (table === "jobs" ? db.jobs : db.receipts).set(r.id, r);
        return send(res, 201);
      }
      return send(res, 404, { message: `unhandled ${req.method} ${target}` });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  db.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  db.close = () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  return db;
}
