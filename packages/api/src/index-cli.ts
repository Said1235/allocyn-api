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
  const config = loadConfig();
  const url = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !secretKey) throw new ConfigError("Set SUPABASE_URL and SUPABASE_SECRET_KEY.");

  const client = await createAllocynClient({
    network: config.network, ...(config.contractAddress ? { contractAddress: config.contractAddress } : {}), readConsistency: "final",
  });
  const store = createSupabaseStore({ url, secretKey });

  // Catch up in several rounds when the database is far behind. Re-reading changeable jobs happens once, in the first round.
  const total = { rounds: 0, newJobs: 0, refreshedJobs: 0, receipts: 0, latest: 0, position: 0, missing: [] as string[], failed: [] as IndexResult["failed"] };
  for (let round = 0; round < 50; round++) {
    const r = await runIndexer({ client, store, network: config.network, maxRefresh: round === 0 ? 20 : 0 });
    total.rounds++; total.newJobs += r.newJobs; total.refreshedJobs += r.refreshedJobs; total.receipts += r.receipts;
    total.latest = r.latest; total.position = r.position; total.missing.push(...r.missing); total.failed.push(...r.failed);
    if (r.position >= r.latest) break;
  }
  console.log(JSON.stringify({ level: "info", message: "indexed", contract: client.contractAddress, network: config.network, ...total }));
  if (total.failed.length) { console.error(JSON.stringify({ level: "warn", message: "some rows were refused by the database", failed: total.failed })); return 1; }
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e) => {
  const message = e instanceof ConfigError || e instanceof IndexerError ? e.message : e instanceof Error ? e.message : String(e);
  console.error(JSON.stringify({ level: "error", message }));
  process.exitCode = 1;
});
