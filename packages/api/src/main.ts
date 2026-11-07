import { createAllocynClient } from "@allocyn/sdk";
import { loadConfig, ConfigError } from "./config.ts";
import { createApiServer } from "./server.ts";
import { loadDocs } from "./docs-static.ts";

async function main() {
  let config;
  try { config = loadConfig(); }
  catch (e) {
    if (e instanceof ConfigError) { console.error(`Configuration error: ${e.message}`); process.exit(1); }
    throw e;
  }
  // Read-only clients: no signer is ever passed, so this process cannot sign or send anything.
  const base = { network: config.network, ...(config.contractAddress ? { contractAddress: config.contractAddress } : {}) };
  const [latest, final] = await Promise.all([
    createAllocynClient({ ...base, readConsistency: "latest" }),
    createAllocynClient({ ...base, readConsistency: "final" }),
  ]);
  const server = createApiServer({
    config, clients: { latest, final }, docs: loadDocs(),
    log: (l) => console.log(JSON.stringify({ t: new Date().toISOString(), ...l })),
  });
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ level: "info", msg: "allocyn-api listening", port: config.port, network: config.network, contract: latest.contractAddress, env: config.nodeEnv }));
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
main().catch((e) => { console.error("Fatal:", e instanceof Error ? e.message : e); process.exit(1); });
