import { ApiError } from "./http.ts";
import { CopyError } from "./copy.ts";
import type { CopyReader } from "./copy.ts";
import type { Ctx } from "./routes.ts";
import { readRaw } from "./stats.ts";
import type { Stats } from "./stats.ts";
import { rowToSummary } from "./jobs-list.ts";
import type { Item } from "./jobs-list.ts";

const TTL_MS = 30_000;
const RECENT = 5;

export interface AddressRecord {
  address: string;
  source: "copy";
  contract: string | null;
  network: string | null;
  syncedAt: string | null;
  copiedThrough: string | null;
  asWorker: { jobs: Stats["jobs"]; deliveries: NonNullable<Stats["receipts"]> };
  asClient: { jobs: Stats["jobs"] };
  recent: { asWorker: Item[]; asClient: Item[] };
  notes: string[];
}

const cache = new WeakMap<CopyReader, Map<string, { at: number; data: AddressRecord }>>();

/**
 * What the copy holds about one address: the jobs it created (as client) and the jobs it accepted (as worker),
 * with how many ended in each verdict. Counts only. There is no score and no ranking: a few jobs say little,
 * and the verdict on a delivery is the validators' reading of that one delivery.
 */
export async function getAddressRecord(ctx: Ctx): Promise<AddressRecord> {
  const copy = ctx.copy;
  if (!copy) throw new ApiError(503, "COPY_UNAVAILABLE", "This server has no database copy configured, so it has no address records.", { retryable: false });
  if (!/^0x[0-9a-fA-F]{40}$/.test(ctx.params.address ?? "")) throw new ApiError(400, "INVALID_ARGUMENT", "address is not valid. A wallet address: 0x followed by 40 hex characters.", { field: "address" });
  const address = ctx.params.address!.toLowerCase();
  const now = ctx.now().getTime();
  const store = cache.get(copy) ?? new Map();
  cache.set(copy, store);
  const hit = store.get(address);
  if (hit && now - hit.at < TTL_MS) return hit.data;
  try {
    const [status, asWorker, asClient, recentWorker, recentClient] = await Promise.all([
      copy.status(),
      readRaw(copy, null, address),
      readRaw(copy, address, null),
      copy.listJobs({ filters: { worker: `eq.${address}` }, limit: RECENT }),
      copy.listJobs({ filters: { client: `eq.${address}` }, limit: RECENT }),
    ]);
    const data: AddressRecord = {
      address,
      source: "copy",
      contract: status?.contract ?? null, network: status?.network ?? null,
      syncedAt: status?.lastRunAt ? new Date(status.lastRunAt).toISOString() : null,
      copiedThrough: status && status.lastJobNumber > 0 ? `job-${status.lastJobNumber}` : null,
      asWorker: { jobs: asWorker.jobs, deliveries: asWorker.receipts! },
      asClient: { jobs: asClient.jobs },
      recent: { asWorker: recentWorker.map(rowToSummary), asClient: recentClient.map(rowToSummary) },
      notes: [
        "These are counts from a copy of the contract's final reads, as of `syncedAt`. They are not a score, a ranking or a guarantee of anything.",
        "A few jobs say little. Read the jobs themselves before relying on a record.",
        "`byOutcome` counts deliveries by the verdict the validators gave. `PENDING` are waiting to be judged. A delivery replaced before it was judged is only in `total`.",
        "An address that is not in the copy gets all zeros: it may be unused, or simply newer than `syncedAt`.",
      ],
    };
    store.set(address, { at: now, data });
    return data;
  } catch (e) {
    if (e instanceof CopyError) throw new ApiError(502, "UPSTREAM_UNAVAILABLE", "The database copy did not answer. Try again later.", { retryable: true });
    throw e;
  }
}
