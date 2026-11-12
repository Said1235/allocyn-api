import { createAllocynClient } from "@allocyn/sdk";
import { ConfigError, loadConfig } from "./config.ts";
import { makeCtx } from "./context.ts";
import { createMcpHandler } from "./mcp.ts";
import { serveStdio } from "./stdio.ts";

/**
 * Runs the Allocyn MCP server over stdio (one JSON-RPC message per line), for desktop agents such as
 * Claude Desktop. Read-only: no signer is ever passed. Nothing but protocol messages goes to stdout.
 */
async function main() {
  let config;
  try { config = loadConfig(); }
  catch (e) {
    if (e instanceof ConfigError) { console.error(`Configuration error: ${e.message}`); process.exit(1); }
    throw e;
  }
  const base = { network: config.network, ...(config.contractAddress ? { contractAddress: config.contractAddress } : {}) };
  const [latest, final] = await Promise.all([
    createAllocynClient({ ...base, readConsistency: "latest" }),
    createAllocynClient({ ...base, readConsistency: "final" }),
  ]);
  const mcp = createMcpHandler({
    makeCtx: (params, query) => makeCtx({ clients: { latest, final }, defaultConsistency: config.readConsistency, now: Date.now }, params, query),
    defaultConsistency: config.readConsistency, timeoutMs: config.requestTimeoutMs,
  });
  console.error(JSON.stringify({ level: "info", msg: "allocyn-mcp ready (stdio)", network: config.network, contract: latest.contractAddress }));
  await serveStdio(mcp, process.stdin, process.stdout);
}
main().then(() => process.exit(0), (e) => { console.error("Fatal:", e instanceof Error ? e.message : e); process.exit(1); });
