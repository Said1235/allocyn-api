import type http from "node:http";
import { createAllocynClient } from "@allocyn/sdk";
import { ConfigError, loadConfig } from "./config.ts";
import { createApiHandler } from "./server.ts";

/**
 * Vercel entry point (Node.js runtime). Same handler as the standalone server, built once per
 * warm instance. The docs are static files served by Vercel itself, so none are passed here.
 * The in-memory rate limiter is per instance: use Vercel's firewall rate limiting for a real limit.
 */
/**
 * Vercel adds the named parts of a rewrite to the query string: `/v1/health` reaches the function as `/v1/health?path=health`,
 * and `/verify/job-1` as `?jobId=job-1`. Our routes reject parameters they do not know, so those two are dropped here.
 * `_vercel_share` is how a protected deployment is shared by link; it is not meant for the API either.
 */
export function stripPlatformParams(rawUrl: string): string {
  const q = rawUrl.indexOf("?");
  if (q < 0) return rawUrl;
  const pathname = rawUrl.slice(0, q);
  const params = new URLSearchParams(rawUrl.slice(q + 1));
  params.delete("_vercel_share");
  if (pathname === "/v1" || pathname.startsWith("/v1/")) params.delete("path");
  else if (pathname.startsWith("/verify/")) params.delete("jobId");
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}

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
    if (req.url) req.url = stripPlatformParams(req.url);
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
