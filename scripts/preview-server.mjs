// Local preview: the real API server + docs, backed by the in-memory contract double (NOT the network).
// Usage: node scripts/preview-server.mjs [port]
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createAllocynClient } = await imp("packages/sdk/src/index.ts");
const { SimContract } = await imp("packages/sdk/src/core/contract/sim.ts");
const { createApiServer } = await imp("packages/api/src/server.ts");
const { loadConfig } = await imp("packages/api/src/config.ts");
const { loadDocs } = await imp("packages/api/src/docs-static.ts");
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20);
const sim = new SimContract();
await sim.directWrite(A, "create_job", ["Logo files", "The studio logo as vector files.", ["Delivered as SVG", "Includes a usage guide"]]);
await sim.directWrite(B, "accept_job", ["job-1"]);
await sim.directWrite(B, "submit_delivery", ["job-1", "https://example.org/logo-package"]);
await sim.directWrite(B, "evaluate_delivery", ["rcpt-1"]);
const port = Number(process.argv[2] ?? 8799);
const config = loadConfig({ NODE_ENV: "development", PORT: String(port), API_BASE_URL: `http://127.0.0.1:${port}` });
const mk = (c) => createAllocynClient({ gateway: sim, actor: null, readConsistency: c });
createApiServer({ config, clients: { latest: await mk("latest"), final: await mk("final") }, docs: loadDocs() })
  .listen(port, "127.0.0.1", () => console.log(`preview on http://127.0.0.1:${port} (SIMULATED contract)`));
