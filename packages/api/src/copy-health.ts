import { CopyError } from "./copy.ts";
import type { CopyReader, CopyRun } from "./copy.ts";

/** The indexer runs hourly (and GitHub may start it late), so three hours without a run means something is wrong. */
export const STALE_AFTER_SECONDS = 3 * 3600;

export interface CopyHealth {
  syncedAt: string | null;
  lagSeconds: number | null;
  staleAfterSeconds: number;
  copiedThrough: string | null;
  lastRun: CopyRun | null;
}

/**
 * How old the copy is and how the last indexer run went. Never throws: a copy that cannot be read is reported as
 * `unavailable`, so a deep health check about the API and the network is not turned into a failure by an optional database.
 */
export async function readCopyHealth(copy: CopyReader, nowMs: number): Promise<{ check: "ok" | "stale" | "failing" | "unavailable"; copy: CopyHealth | null }> {
  try {
    const [status, run] = await Promise.all([copy.status(), copy.lastRun().catch((e) => { if (e instanceof CopyError && e.status === 404) return null; throw e; })]);
    const syncedAt = status?.lastRunAt ? new Date(status.lastRunAt).toISOString() : null;
    const lagSeconds = syncedAt ? Math.max(0, Math.round((nowMs - Date.parse(syncedAt)) / 1000)) : null;
    const stale = lagSeconds === null || lagSeconds > STALE_AFTER_SECONDS;
    const check = stale ? "stale" : run && !run.ok ? "failing" : "ok";
    return { check, copy: { syncedAt, lagSeconds, staleAfterSeconds: STALE_AFTER_SECONDS, copiedThrough: status && status.lastJobNumber > 0 ? `job-${status.lastJobNumber}` : null, lastRun: run } };
  } catch {
    return { check: "unavailable", copy: null };
  }
}
