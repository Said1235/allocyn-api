import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AllocynClient } from "@allocyn/sdk";
import type { ApiConfig } from "./config.ts";
import { ApiError, errorBody, toApiError } from "./http.ts";
import { RateLimiter } from "./ratelimit.ts";
import { matchRoute } from "./routes.ts";
import type { Ctx } from "./routes.ts";
import { buildOpenApi } from "./openapi.ts";

export interface ServerDeps {
  config: ApiConfig;
  clients: { latest: AllocynClient; final: AllocynClient };
  /** Static docs site: returns {status, type, body} for a path, or null. */
  docs?: (pathname: string) => { status: number; type: string; body: string | Buffer } | null;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

const SECURITY: Record<string, string> = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "cross-origin",
};

/** Builds the request listener alone, so it can run under `http.createServer` or inside a serverless function. */
export function createApiHandler(deps: ServerDeps): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const limiter = new RateLimiter(config.rateLimit.max, config.rateLimit.windowMs, now);
  const openapi = JSON.stringify(buildOpenApi(config));
  const log = deps.log ?? (() => {});

  const corsHeaders = (origin: string | undefined): Record<string, string> => {
    const h: Record<string, string> = { Vary: "Origin" };
    if (!origin) return h;
    if (config.corsOrigins.includes("*")) h["Access-Control-Allow-Origin"] = "*";
    else if (config.corsOrigins.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
    if (h["Access-Control-Allow-Origin"]) h["Access-Control-Expose-Headers"] = "X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After";
    return h;
  };

  const clientKey = (req: http.IncomingMessage): string => {
    if (config.trustProxy) {
      const xf = req.headers["x-forwarded-for"];
      const first = (Array.isArray(xf) ? xf[0] : xf)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  const ctxFor = (params: Record<string, string>, query: URLSearchParams): Ctx => ({
    params, query,
    client: (c) => (c === "final" ? deps.clients.final : deps.clients.latest),
    defaultConsistency: config.readConsistency,
    probe: async () => {
      try { await deps.clients.latest.getJob("job-1"); }
      catch (e) { if ((e as { code?: string }).code !== "JOB_NOT_FOUND") throw e; }
    },
    now: () => new Date(now()),
  });

  return async (req, res) => {
    const id = randomUUID();
    const started = now();
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    let status = 500;
    const send = (code: number, body: string | Buffer, headers: Record<string, string>) => {
      status = code;
      res.writeHead(code, { ...SECURITY, ...corsHeaders(origin), "X-Request-Id": id, ...headers });
      res.end(body);
    };
    const sendJson = (code: number, body: unknown, headers: Record<string, string> = {}) =>
      send(code, JSON.stringify(body), { "Content-Type": "application/json; charset=utf-8", ...headers });
    let rl: ReturnType<RateLimiter["check"]> | null = null;
    const rlHeaders = (): Record<string, string> => rl ? { "X-RateLimit-Limit": String(rl.limit), "X-RateLimit-Remaining": String(rl.remaining) } : {};

    try {
      const url = new URL(req.url ?? "/", "http://x");
      const method = req.method ?? "GET";
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new ApiError(400, "INVALID_ARGUMENT", "The URL is not valid."); }
      if (pathname.includes("\0")) throw new ApiError(400, "INVALID_ARGUMENT", "The URL is not valid.");

      if (method === "OPTIONS") {
        return send(204, "", { "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" });
      }

      // Public, non-API pages (not rate limited like API reads would be, but still GET/HEAD only).
      if (pathname === "/openapi.json" && (method === "GET" || method === "HEAD")) {
        return send(200, method === "HEAD" ? "" : openapi, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" });
      }
      if (!pathname.startsWith("/v1/") && pathname !== "/v1" && (method === "GET" || method === "HEAD")) {
        if (pathname === "/" || pathname === "/docs") return send(302, "", { Location: "/docs/" });
        const page = deps.docs?.(pathname);
        if (page) return send(page.status, method === "HEAD" ? "" : page.body, { "Content-Type": page.type, "Cache-Control": "public, max-age=300" });
        throw new ApiError(404, "NOT_FOUND", "No such page. The API lives under /v1, the docs under /docs/.");
      }

      rl = limiter.check(clientKey(req));
      if (!rl.allowed) {
        throw new ApiError(429, "RATE_LIMITED", "Too many requests. Wait and try again.", { retryable: true, headers: { "Retry-After": String(rl.retryAfterSec) } });
      }

      const m = matchRoute(method === "HEAD" ? "GET" : method, pathname);
      if (m === null) throw new ApiError(404, "NOT_FOUND", "No such endpoint. See /openapi.json.");
      if (m === "method") {
        throw new ApiError(405, "METHOD_NOT_ALLOWED", "This API is read-only: only GET is supported. Writes are signed by your own wallet with @allocyn/sdk, not sent here.", { headers: { Allow: "GET, HEAD, OPTIONS" } });
      }

      const { route, params } = m;
      const allowed = new Set<string>([...(route.chainRead ? ["consistency"] : []), ...(route.deep ? ["deep"] : [])]);
      for (const k of url.searchParams.keys()) {
        if (!allowed.has(k)) throw new ApiError(400, "INVALID_ARGUMENT", `Unknown query parameter "${k}".`, { field: k });
      }
      let consistency = config.readConsistency;
      if (route.chainRead && url.searchParams.has("consistency")) {
        const c = url.searchParams.get("consistency");
        if (c !== "latest" && c !== "final") throw new ApiError(400, "INVALID_ARGUMENT", 'consistency must be "latest" or "final".', { field: "consistency" });
        consistency = c;
      }
      if (route.deep && url.searchParams.has("deep") && !["true", "false"].includes(url.searchParams.get("deep")!)) {
        throw new ApiError(400, "INVALID_ARGUMENT", 'deep must be "true" or "false".', { field: "deep" });
      }

      let timer: NodeJS.Timeout | undefined;
      const data = await Promise.race([
        route.handler(ctxFor(params, url.searchParams), consistency),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new ApiError(504, "UPSTREAM_TIMEOUT", "The network took too long to answer. Try again.", { retryable: true })), config.requestTimeoutMs); }),
      ]).finally(() => clearTimeout(timer));

      return send(200, method === "HEAD" ? "" : JSON.stringify({ success: true, data }), {
        "Content-Type": "application/json; charset=utf-8",
        ...rlHeaders(),
        "Cache-Control": route.cache === "short" ? "public, max-age=60" : "no-store",
        ...(route.chainRead ? { "X-Allocyn-Consistency": consistency } : {}),
      });
    } catch (err) {
      const e = toApiError(err);
      if (e.status === 500) log({ level: "error", id, message: err instanceof Error ? err.message : String(err) });
      sendJson(e.status, errorBody(e), { ...rlHeaders(), "Cache-Control": "no-store", ...(e.extra.headers ?? {}) });
    } finally {
      log({ level: "info", id, method: req.method, path: (req.url ?? "").split("?")[0], status, ms: now() - started });
    }
  };
}

export function createApiServer(deps: ServerDeps): http.Server {
  return http.createServer(createApiHandler(deps));
}
