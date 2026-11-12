import { AllocynError } from "@allocyn/sdk";
import type { AllocynClient } from "@allocyn/sdk";
import type { Ctx } from "./routes.ts";
import { parseQuery } from "./params.ts";

const SCAN_LIMIT = 100; // ids read per request, at most
const CHUNK = 10;       // read in parallel, this many at a time
const LATEST_TTL_MS = 15_000;
const latestCache = new WeakMap<object, { n: number; at: number }>();

async function exists(client: AllocynClient, n: number): Promise<boolean> {
  try { await client.getJob(`job-${n}`); return true; }
  catch (e) { if (e instanceof AllocynError && e.code === "JOB_NOT_FOUND") return false; throw e; }
}

/**
 * The contract has no "list" or "count" view, but it numbers jobs job-1, job-2, ... without gaps. The newest
 * one is found by doubling and then bisecting, which takes about 2 * log2(n) reads. Cached for a few seconds.
 */
export async function latestJobNumber(client: AllocynClient, now: number): Promise<number> {
  const hit = latestCache.get(client);
  if (hit && now - hit.at < LATEST_TTL_MS) return hit.n;
  let n = 0;
  if (await exists(client, 1)) {
    let lo = 1, hi = 2;
    while (hi < 1 << 22 && (await exists(client, hi))) { lo = hi; hi *= 2; }
    while (hi - lo > 1) { const mid = lo + Math.floor((hi - lo) / 2); if (await exists(client, mid)) lo = mid; else hi = mid; }
    n = lo;
  }
  latestCache.set(client, { n, at: now });
  return n;
}

export async function listJobs(ctx: Ctx, consistency: "latest" | "final") {
  const client = ctx.client(consistency);
  const q = parseQuery({ query: LIST_QUERY }, ctx.query);
  const limit = q.limit ? Number(q.limit) : 20;
  const latest = await latestJobNumber(client, ctx.now().getTime());
  const start = Math.min(latest, q.before ? Number(q.before.slice(4)) - 1 : latest);
  const items: Array<{ id: string; title: string; status: string; client: string; worker: string | null; deliveryCount: number }> = [];
  let next = start, nextCursor: string | null = null, scanned = 0;

  scan: while (next >= 1 && scanned < SCAN_LIMIT) {
    const ids: number[] = [];
    for (let i = next; i >= 1 && ids.length < CHUNK && scanned + ids.length < SCAN_LIMIT; i--) ids.push(i);
    const jobs = await Promise.all(ids.map((n) => client.getJob(`job-${n}`).catch((e) => { if (e instanceof AllocynError && e.code === "JOB_NOT_FOUND") return null; throw e; })));
    for (let k = 0; k < ids.length; k++) {
      const j = jobs[k]; scanned++; next = ids[k]! - 1;
      if (!j) continue;
      if (q.status && j.status !== q.status) continue;
      if (q.client && j.client !== q.client.toLowerCase()) continue;
      if (q.worker && (j.worker ?? "") !== q.worker.toLowerCase()) continue;
      items.push({ id: j.id, title: j.title, status: j.status, client: j.client, worker: j.worker, deliveryCount: j.deliveryCount });
      if (items.length >= limit) break scan;
    }
  }
  if (next >= 1) nextCursor = `job-${next + 1}`; // "older than this id" continues exactly where the scan stopped
  return { items, nextCursor, latest: latest ? `job-${latest}` : null, scanned };
}

import type { QueryParam } from "./params.ts";
export const LIST_QUERY: QueryParam[] = [
  { name: "limit", description: "How many jobs to return, 1 to 50 (default 20).", schema: { type: "integer", minimum: 1, maximum: 50 }, example: "20" },
  { name: "before", description: "Cursor: only jobs older than this id. Use the `nextCursor` of the previous page.", schema: { type: "string", pattern: "^job-[1-9][0-9]{0,8}$" }, example: "job-10" },
  { name: "status", description: "Only jobs in this status.", schema: { type: "string", enum: ["OPEN", "IN_PROGRESS", "VERIFIED", "NEEDS_REVISION", "INCONCLUSIVE"] }, example: "VERIFIED" },
  { name: "client", description: "Only jobs created by this address.", schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, example: "0x" + "a1".repeat(20) },
  { name: "worker", description: "Only jobs accepted by this address.", schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, example: "0x" + "b2".repeat(20) },
];
