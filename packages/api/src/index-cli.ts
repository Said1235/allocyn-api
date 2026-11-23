import { createAllocynClient } from "@allocyn/sdk";
import { ConfigError, loadConfig } from "./config.ts";
import { createSupabaseStore, IndexerError, runIndexer } from "./indexer.ts";
import type { IndexResult } from "./indexer.ts";

/**
 * Copies the contract's jobs and receipts into the Supabase tables. Run it from a schedule (see .github/workflows/index.yml)
 * or by hand: `SUPABASE_URL=... SUPABASE_SECRET_KEY=... npm run index`.
 *
 * It reads the contract with a read-only client and `final` reads only. It never signs anything and never prints the key.
 * The secret key is read here and nowhere else: the public API function does not load it.
 */
async function main(): Promise<number> {
  // The API reads the copy with a public key; the indexer writes with the secret one. Keep the two apart:
  // the SUPABASE_* variables are the indexer's own and are not part of the API configuration.
  const config = loadConfig(Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SUPABASE_"))));
  const url = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !secretKey) throw new ConfigError("Set SUPABASE_URL and SUPABASE_SECRET_KEY.");

  const client = await createAllocynClient({
    network: config.network, ...(config.contractAddress ? { contractAddress: config.contractAddress } : {}), readConsistency: "final",
  });
  const store = createSupabaseStore({ url, secretKey });

  // Catch up in several rounds when the database is far behind. Re-reading changeable jobs happens once, in the first round.
  const startedAt = new Date();
  const total = { rounds: 0, newJobs: 0, refreshedJobs: 0, receipts: 0, latest: 0, position: 0, missing: [] as string[], failed: [] as IndexResult["failed"] };
  // One row per run in indexer_runs, so a stopped or failing indexer shows up in /v1/health. Never allowed to hide the real result.
  const record = async (ok: boolean, error: string | null) => {
    try { await store.recordRun?.({ startedAt, finishedAt: new Date(), ok, newJobs: total.newJobs, refreshedJobs: total.refreshedJobs, receipts: total.receipts, failedRows: total.failed.length, rounds: total.rounds, lastJobNumber: total.position || null, error }); }
    catch (e) { console.error(JSON.stringify({ level: "warn", message: "could not record the run", detail: e instanceof Error ? e.message : String(e) })); }
  };
  try {
    for (let round = 0; round < 50; round++) {
      const r = await runIndexer({ client, store, network: config.network, maxRefresh: round === 0 ? 20 : 0 });
      total.rounds++; total.newJobs += r.newJobs; total.refreshedJobs += r.refreshedJobs; total.receipts += r.receipts;
      total.latest = r.latest; total.position = r.position; total.missing.push(...r.missing); total.failed.push(...r.failed);
      if (r.position >= r.latest) break;
    }
  } catch (e) { await record(false, e instanceof Error ? e.message : String(e)); throw e; }
  await record(total.failed.length === 0, total.failed.length ? total.failed.slice(0, 5).map((f) => f.id).join("; ") : null);
  console.log(JSON.stringify({ level: "info", message: "indexed", contract: client.contractAddress, network: config.network, ...total }));
  if (total.failed.length) { console.error(JSON.stringify({ level: "warn", message: "some rows were refused by the database", failed: total.failed })); return 1; }
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e) => {
  const message = e instanceof ConfigError || e instanceof IndexerError ? e.message : e instanceof Error ? e.message : String(e);
  console.error(JSON.stringify({ level: "error", message }));
  process.exitCode = 1;
});
