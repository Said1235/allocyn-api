import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AllocynClient } from "@allocyn/sdk";
import type { ApiConfig } from "./config.ts";
import { ApiError, errorBody, toApiError } from "./http.ts";
import { RateLimiter, SharedRateLimiter } from "./ratelimit.ts";
import type { Limiter } from "./ratelimit.ts";
import { createHash } from "node:crypto";
import { matchRoute } from "./routes.ts";
import type { Ctx } from "./routes.ts";
import { buildOpenApi } from "./openapi.ts";
import { makeCtx } from "./context.ts";
import { parseQuery } from "./params.ts";
import { createMcpHandler } from "./mcp.ts";
import { errorBadge } from "./badge.ts";

export interface ServerDeps {
  config: ApiConfig;
  clients: { latest: AllocynClient; final: AllocynClient };
  /** Static docs site: returns {status, type, body} for a path, or null. */
  docs?: (pathname: string) => { status: number; type: string; body: string | Buffer } | null;
  now?: () => number;
  /** Test seam: how often a long poll re-reads the contract (ms). */
  waitPollMs?: number;
  /** Test seam for the shared rate-limit store. */
  fetch?: typeof fetch;
  log?: (line: Record<string, unknown>) => void;
}

const SECURITY: Record<string, string> = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "cross-origin",
};

/** Reads a JSON body of at most `max` bytes. Vercel may already have parsed it into req.body. */
async function readJsonBody(req: http.IncomingMessage, max: number): Promise<unknown> {
  const pre = (req as { body?: unknown }).body;
  if (pre !== undefined && pre !== null) {
    if (Buffer.isBuffer(pre)) return JSON.parse(pre.toString("utf8"));
    if (typeof pre === "string") return JSON.parse(pre);
    return pre;
  }
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new ApiError(413, "INVALID_ARGUMENT", "The request body is too large.");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Builds the request listener alone, so it can run under `http.createServer` or inside a serverless function. */
export function createApiHandler(deps: ServerDeps): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const memory = new RateLimiter(config.rateLimit.max, config.rateLimit.windowMs, now);
  const limiter: Limiter = config.rateLimitStore
    ? new SharedRateLimiter({ ...config.rateLimitStore, max: config.rateLimit.max, windowMs: config.rateLimit.windowMs, now, fallback: memory, ...(deps.fetch ? { fetch: deps.fetch } : {}), onError: (m) => (deps.log ?? (() => {}))({ level: "warn", message: `rate-limit store unavailable, using the in-memory limiter: ${m}` }) })
    : memory;
  // Answers that can never change again (read with consistency=final) are kept for an hour: no chain read needed.
  const finalCache = new Map<string, { body: string; at: number }>();
  const FINAL_TTL_MS = 3_600_000, FINAL_MAX = 500;
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

  const ctxFor = (params: Record<string, string>, query: URLSearchParams): Ctx =>
    makeCtx({ clients: deps.clients, defaultConsistency: config.readConsistency, now, timeoutMs: config.requestTimeoutMs, ...(deps.waitPollMs ? { pollMs: deps.waitPollMs } : {}) }, params, query);
  const mcp = createMcpHandler({ makeCtx: ctxFor, defaultConsistency: config.readConsistency, timeoutMs: config.requestTimeoutMs });

  return async (req, res) => {
    const id = randomUUID();
    const started = now();
    const method_ = req.method ?? "GET";
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    let status = 500;
    let svgType: string | null = null; // set when the request targets a route that answers with an image
    const send = (code: number, body: string | Buffer, headers: Record<string, string>) => {
      status = code;
      res.writeHead(code, { ...SECURITY, ...corsHeaders(origin), "X-Request-Id": id, ...headers });
      res.end(body);
    };
    const sendJson = (code: number, body: unknown, headers: Record<string, string> = {}) =>
      send(code, JSON.stringify(body), { "Content-Type": "application/json; charset=utf-8", ...headers });
    let rl: Awaited<ReturnType<Limiter["check"]>> | null = null;
    const rlHeaders = (): Record<string, string> => rl ? { "X-RateLimit-Limit": String(rl.limit), "X-RateLimit-Remaining": String(rl.remaining) } : {};

    try {
      const url = new URL(req.url ?? "/", "http://x");
      const method = req.method ?? "GET";
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new ApiError(400, "INVALID_ARGUMENT", "The URL is not valid."); }
      if (pathname.includes("\0")) throw new ApiError(400, "INVALID_ARGUMENT", "The URL is not valid.");
      { const early = matchRoute(method === "HEAD" ? "GET" : method, pathname); if (early && early !== "method" && early.route.contentType) svgType = early.route.contentType; }

      if (method === "OPTIONS") {
        const isMcp = pathname === "/mcp";
        return send(204, "", { "Access-Control-Allow-Methods": isMcp ? "POST, OPTIONS" : "GET, OPTIONS", "Access-Control-Allow-Headers": isMcp ? "Content-Type, Accept, Mcp-Protocol-Version" : "Content-Type", "Access-Control-Max-Age": "600" });
      }

      // MCP over HTTP (stateless, JSON responses). Read-only tools only: see mcp.ts.
      if (pathname === "/mcp") {
        if (method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "The MCP endpoint only accepts POST with a JSON-RPC message.", { headers: { Allow: "POST, OPTIONS" } });
        // A browser page from another origin must be allowed explicitly: this also blocks DNS-rebinding style calls.
        if (origin && !config.corsOrigins.includes("*") && !config.corsOrigins.includes(origin)) throw new ApiError(403, "FORBIDDEN", "This origin is not allowed to call the MCP endpoint.");
        rl = await limiter.check(clientKey(req));
        if (!rl.allowed) throw new ApiError(429, "RATE_LIMITED", "Too many requests. Wait and try again.", { retryable: true, headers: { "Retry-After": String(rl.retryAfterSec) } });
        let payload: unknown;
        try { payload = await readJsonBody(req, 64 * 1024); }
        catch (e) {
          if (e instanceof ApiError) throw e;
          return sendJson(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: the body is not valid JSON." } }, rlHeaders());
        }
        if (Array.isArray(payload)) {
          if (payload.length === 0 || payload.length > 20) return sendJson(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "A batch holds 1 to 20 messages." } }, rlHeaders());
          const out = (await Promise.all(payload.map((m) => mcp.handle(m)))).filter((x) => x !== null);
          return out.length ? sendJson(200, out, rlHeaders()) : send(202, "", rlHeaders());
        }
        const reply = await mcp.handle(payload);
        return reply ? sendJson(200, reply, rlHeaders()) : send(202, "", rlHeaders());
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

      rl = await limiter.check(clientKey(req));
      if (!rl.allowed) {
        throw new ApiError(429, "RATE_LIMITED", "Too many requests. Wait and try again.", { retryable: true, headers: { "Retry-After": String(rl.retryAfterSec) } });
      }

      const m = matchRoute(method === "HEAD" ? "GET" : method, pathname);
      if (m === null) throw new ApiError(404, "NOT_FOUND", "No such endpoint. See /openapi.json.");
      if (m === "method") {
        throw new ApiError(405, "METHOD_NOT_ALLOWED", "This API is read-only: only GET is supported. Writes are signed by your own wallet with @allocyn/sdk, not sent here.", { headers: { Allow: "GET, HEAD, OPTIONS" } });
      }

      const { route, params } = m;
      const allowed = new Set<string>([...(route.chainRead ? ["consistency"] : []), ...(route.deep ? ["deep"] : []), ...(route.query ?? []).map((q) => q.name)]);
      for (const k of url.searchParams.keys()) {
        if (!allowed.has(k)) throw new ApiError(400, "INVALID_ARGUMENT", `Unknown query parameter "${k}".`, { field: k });
      }
      parseQuery(route, url.searchParams);
      let consistency = config.readConsistency;
      if (route.chainRead && url.searchParams.has("consistency")) {
        const c = url.searchParams.get("consistency");
        if (c !== "latest" && c !== "final") throw new ApiError(400, "INVALID_ARGUMENT", 'consistency must be "latest" or "final".', { field: "consistency" });
        consistency = c;
      }
      if (route.deep && url.searchParams.has("deep") && !["true", "false"].includes(url.searchParams.get("deep")!)) {
        throw new ApiError(400, "INVALID_ARGUMENT", 'deep must be "true" or "false".', { field: "deep" });
      }

      const cacheKey = route.finalWhen && consistency === "final" ? `${route.path}|${JSON.stringify(params)}` : null;
      let body: string; let finalNow = false; let hit = false;
      const cached = cacheKey ? finalCache.get(cacheKey) : undefined;
      if (cached && now() - cached.at < FINAL_TTL_MS) { body = cached.body; finalNow = true; hit = true; }
      else {
        let timer: NodeJS.Timeout | undefined;
        const data = await Promise.race([
          route.handler(ctxFor(params, url.searchParams), consistency),
          new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new ApiError(504, "UPSTREAM_TIMEOUT", "The network took too long to answer. Try again.", { retryable: true })), config.requestTimeoutMs); }),
        ]).finally(() => clearTimeout(timer));
        body = route.contentType ? String(data) : JSON.stringify({ success: true, data });
        if (cacheKey && route.finalWhen!(data)) {
          finalNow = true;
          if (finalCache.size >= FINAL_MAX) finalCache.delete(finalCache.keys().next().value!);
          finalCache.set(cacheKey, { body, at: now() });
        }
      }

      const cacheControl = route.cache === "short" ? "public, max-age=60" : finalNow ? "public, max-age=300" : route.chainRead ? "no-cache" : "no-store";
      const etag = `W/"${createHash("sha1").update(body).digest("hex").slice(0, 24)}"`;
      const headers: Record<string, string> = {
        "Content-Type": route.contentType ?? "application/json; charset=utf-8",
        ...(route.contentType ? { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } : {}),
        ...rlHeaders(), "Cache-Control": cacheControl, ETag: etag,
        ...(route.chainRead ? { "X-Allocyn-Consistency": consistency } : {}),
        ...(cacheKey ? { "X-Allocyn-Cache": hit ? "hit" : "miss" } : {}),
      };
      const inm = req.headers["if-none-match"];
      if (typeof inm === "string" && (inm.trim() === "*" || inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag.replace(/^W\//, "")))) {
        const { "Content-Type": _ct, ...h304 } = headers;
        return send(304, "", h304);
      }
      return send(200, method === "HEAD" ? "" : body, headers);
    } catch (err) {
      const e = toApiError(err);
      if (e.status === 500) log({ level: "error", id, message: err instanceof Error ? err.message : String(err) });
      if (svgType) send(e.status, method_ === "HEAD" ? "" : errorBadge(e.status), { "Content-Type": svgType, "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", ...rlHeaders(), "Cache-Control": "no-store", ...(e.extra.headers ?? {}) });
      else sendJson(e.status, errorBody(e), { ...rlHeaders(), "Cache-Control": "no-store", ...(e.extra.headers ?? {}) });
    } finally {
      log({ level: "info", id, method: req.method, path: (req.url ?? "").split("?")[0], status, ms: now() - started });
    }
  };
}

export function createApiServer(deps: ServerDeps): http.Server {
  return http.createServer(createApiHandler(deps));
}
