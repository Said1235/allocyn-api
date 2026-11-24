import { ApiError } from "./http.ts";
import { CopyError } from "./copy.ts";
import type { Ctx } from "./routes.ts";
import { parseQuery } from "./params.ts";
import type { QueryParam } from "./params.ts";

const TYPES = ["job_created", "job_accepted", "delivery_submitted", "delivery_evaluated", "status_changed"] as const;
const ADDR = "^0x[0-9a-fA-F]{40}$";

export const EVENTS_QUERY: QueryParam[] = [
  { name: "after", description: "Cursor: only events with a higher id. Use the `cursor` of the previous answer. Leave it out to get the newest events.", schema: { type: "integer", minimum: 0 }, example: "0" },
  { name: "limit", description: "How many events to return, 1 to 100 (default 50).", schema: { type: "integer", minimum: 1, maximum: 100 }, example: "50" },
  { name: "job", description: "Only events of this job.", schema: { type: "string", pattern: "^job-[1-9][0-9]{0,8}$" }, example: "job-1" },
  { name: "type", description: "Only this kind of event.", schema: { type: "string", enum: [...TYPES] }, example: "status_changed" },
  { name: "worker", description: "Only events of jobs accepted by this address.", schema: { type: "string", pattern: ADDR }, example: "0x" + "b2".repeat(20) },
  { name: "client", description: "Only events of jobs created by this address.", schema: { type: "string", pattern: ADDR }, example: "0x" + "a1".repeat(20) },
  { name: "wait", description: "Seconds to wait for a new event when there is none yet, 0 to 25 (default 0). The server may wait less: it always answers before `REQUEST_TIMEOUT_MS`.", schema: { type: "integer", minimum: 0, maximum: 25 }, example: "15" },
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const POLL_MS_MIN = 2000;

/**
 * A feed of what changed in the jobs, read from the database copy. Cursor based, with an optional long poll.
 * Events are written by the database when the indexer changes a row, so `detectedAt` is when the indexer saw
 * the change, not when it happened on the network, and nothing newer than `syncedAt` is here.
 */
export async function getEvents(ctx: Ctx) {
  const copy = ctx.copy;
  if (!copy) throw new ApiError(503, "COPY_UNAVAILABLE", "This server has no database copy configured, so it has no event feed.", { retryable: false });
  const q = parseQuery({ query: EVENTS_QUERY }, ctx.query);
  const limit = q.limit ? Number(q.limit) : 50;
  const after = q.after !== undefined ? Number(q.after) : undefined;
  const filters: Record<string, string> = {
    ...(q.job ? { job_id: `eq.${q.job}` } : {}), ...(q.type ? { type: `eq.${q.type}` } : {}),
    ...(q.worker ? { worker: `eq.${q.worker.toLowerCase()}` } : {}), ...(q.client ? { client: `eq.${q.client.toLowerCase()}` } : {}),
  };
  const waitMs = Math.max(0, Math.min((q.wait ? Number(q.wait) : 0) * 1000, ctx.timeoutMs - 2500));
  const started = Date.now();
  try {
    let rows = await copy.listEvents({ filters, ...(after !== undefined ? { after } : {}), limit });
    let cursor = after ?? 0;
    const pollMs = Math.max(ctx.pollMs, POLL_MS_MIN);
    while (!rows.length && Date.now() - started + pollMs < waitMs) {
      await sleep(pollMs);
      rows = await copy.listEvents({ filters, after: cursor, limit });
    }
    if (rows.length) cursor = rows[rows.length - 1]!.id;
    const state = await copy.status();
    return {
      items: rows.map((r) => ({ id: r.id, type: r.type, jobId: r.job_id, detectedAt: new Date(r.created_at).toISOString(), fromStatus: r.from_status, toStatus: r.to_status, client: r.client, worker: r.worker, data: r.data })),
      cursor,
      source: "copy" as const,
      syncedAt: state?.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
      waitedSeconds: Math.round((Date.now() - started) / 100) / 10,
      notes: [
        "`detectedAt` is when the indexer saw the change, not when it happened on the network. Nothing newer than `syncedAt` is here.",
        "Pass `cursor` as `after` to continue. Events are kept, so a client that was away can catch up. Nothing is pushed: ask again.",
        "To rely on a job's state, read the job.",
      ],
    };
  } catch (e) {
    if (e instanceof CopyError) throw new ApiError(502, "UPSTREAM_UNAVAILABLE", "The database copy did not answer. Try again later.", { retryable: true });
    throw e;
  }
}
