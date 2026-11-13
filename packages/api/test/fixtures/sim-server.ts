// Test fixture: the real MCP/REST handlers over the in-memory contract double, so an EXTERNAL MCP client
// (the official Python SDK, see scripts/mcp-client-check.py) can be pointed at it. Not part of the product.
//   node sim-server.ts http   -> prints PORT=<n> and serves /mcp and /v1 until killed
//   node sim-server.ts stdio  -> speaks MCP over stdin/stdout
import type { AddressInfo } from "node:net";
import { createAllocynClient } from "@allocyn/sdk";
import { SimContract } from "../../../sdk/src/core/contract/sim.ts";
import { createApiServer } from "../../src/server.ts";
import { loadConfig } from "../../src/config.ts";
import { createMcpHandler } from "../../src/mcp.ts";
import { makeCtx } from "../../src/context.ts";
import { serveStdio } from "../../src/stdio.ts";

const ALICE = "0x" + "a1".repeat(20);
const BOB = "0x" + "b2".repeat(20);
const sim = new SimContract();
await sim.directWrite(ALICE, "create_job", ["Logo files", "The studio logo as vector files.", ["Delivered as SVG", "Includes a usage guide"]]);
await sim.directWrite(BOB, "accept_job", ["job-1"]);
await sim.directWrite(BOB, "submit_delivery", ["job-1", "https://example.com/logo-package"]);
await sim.directWrite(BOB, "evaluate_delivery", ["rcpt-1"]);
const cfg = loadConfig({ NODE_ENV: "test" });
const mk = (c: "latest" | "final") => createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
const clients = { latest: await mk("latest"), final: await mk("final") };

if (process.argv[2] === "stdio") {
  const mcp = createMcpHandler({
    makeCtx: (params, query) => makeCtx({ clients, defaultConsistency: cfg.readConsistency, now: Date.now, timeoutMs: cfg.requestTimeoutMs }, params, query),
    defaultConsistency: cfg.readConsistency, timeoutMs: cfg.requestTimeoutMs,
  });
  await serveStdio(mcp, process.stdin, process.stdout);
} else {
  const server = createApiServer({ config: cfg, clients });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  console.log(`PORT=${(server.address() as AddressInfo).port}`);
}
