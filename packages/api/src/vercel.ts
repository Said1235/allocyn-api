import type http from "node:http";
import { createAllocynClient } from "@allocyn/sdk";
import { ConfigError, loadConfig } from "./config.ts";
import { createApiHandler } from "./server.ts";

/**
 * Vercel entry point (Node.js runtime). Same handler as the standalone server, built once per
 * warm instance. The docs are static files served by Vercel itself, so none are passed here.
 * The in-memory rate limiter is per instance: use Vercel's firewall rate limiting for a real limit.
 */
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
let ready: Promise<Handler> | null = null;

function init(): Promise<Handler> {
  return (async () => {
    const config = loadConfig();
    const base = { network: config.network, ...(config.contractAddress ? { contractAddress: config.contractAddress } : {}) };
    // Read-only clients: no signer is ever passed.
    const [latest, final] = await Promise.all([
      createAllocynClient({ ...base, readConsistency: "latest" }),
      createAllocynClient({ ...base, readConsistency: "final" }),
    ]);
    return createApiHandler({ config, clients: { latest, final }, log: (l) => console.log(JSON.stringify(l)) });
  })();
}

export default async function handler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    ready ??= init();
    const h = await ready;
    // If the platform hands us the function's own path, drop that prefix so /api/v1/x == /v1/x.
    if (req.url?.startsWith("/api/")) req.url = req.url.slice(4);
    await h(req, res);
  } catch (e) {
    ready = null; // let the next request retry the initialisation
    console.error(JSON.stringify({ level: "error", message: e instanceof ConfigError ? e.message : e instanceof Error ? e.message : String(e) }));
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ success: false, error: { code: "INTERNAL", message: "The API is not configured correctly. Check the server logs.", retryable: false } }));
    }
  }
}
