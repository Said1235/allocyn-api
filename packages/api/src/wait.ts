import { createHash } from "node:crypto";
import type { JobDto } from "@allocyn/sdk";
import type { Ctx } from "./routes.ts";
import { parseQuery } from "./params.ts";
import { canonicalJson } from "./proof.ts";
import type { QueryParam } from "./params.ts";

export const WAIT_QUERY: QueryParam[] = [
  { name: "since", description: "The `version` returned by the previous call. Leave it out on the first call: the answer is immediate.", schema: { type: "string", pattern: "^[0-9a-f]{16}$" }, example: "0123456789abcdef" },
  { name: "timeout", description: "How many seconds to wait for a change, 1 to 25 (default 15). The server may use less: it always answers before `REQUEST_TIMEOUT_MS`.", schema: { type: "integer", minimum: 1, maximum: 25 }, example: "15" },
];

/** A short fingerprint of everything about a job that can change: parties, status, delivery count and receipts. */
export function jobVersion(job: Pick<JobDto, "status" | "deliveryCount" | "worker" | "receiptIds">): string {
  return createHash("sha256").update(canonicalJson({ status: job.status, deliveryCount: job.deliveryCount, worker: job.worker, receiptIds: job.receiptIds }), "utf8").digest("hex").slice(0, 16);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Long poll: answers as soon as the job's version differs from `since`, or when the wait ends. A stateless
 * alternative to webhooks: nothing is stored, the caller just asks again with the `version` it got.
 */
export async function waitForJob(ctx: Ctx, consistency: "latest" | "final") {
  const q = parseQuery({ query: WAIT_QUERY }, ctx.query);
  const client = ctx.client(consistency);
  const id = ctx.params.jobId!;
  const asked = q.timeout ? Number(q.timeout) : 15;
  const waitMs = Math.max(0, Math.min(asked * 1000, ctx.timeoutMs - 2500));
  const started = Date.now();
  for (;;) {
    const job = await client.getJob(id);
    const version = jobVersion(job);
    const waited = Math.round((Date.now() - started) / 100) / 10;
    if (!q.since || version !== q.since) return { changed: !!q.since, version, waitedSeconds: waited, job };
    if (Date.now() - started + ctx.pollMs >= waitMs) return { changed: false, version, waitedSeconds: waited, job };
    await sleep(ctx.pollMs);
  }
}
