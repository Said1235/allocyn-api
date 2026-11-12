import { createHash } from "node:crypto";

export interface LimitResult { allowed: boolean; limit: number; remaining: number; resetAt: number; retryAfterSec: number }
export interface Limiter { check(key: string): LimitResult | Promise<LimitResult> }

/** Fixed-window limiter per client key, in memory. One process only: behind several instances use the gateway's limiter too. */
export class RateLimiter implements Limiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  constructor(max: number, windowMs: number, now: () => number = Date.now, maxKeys = 10000) {
    this.max = max; this.windowMs = windowMs; this.now = now; this.maxKeys = maxKeys;
  }

  check(key: string): { allowed: boolean; limit: number; remaining: number; resetAt: number; retryAfterSec: number } {
    const t = this.now();
    if (this.hits.size >= this.maxKeys) {
      for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
      if (this.hits.size >= this.maxKeys) this.hits.clear(); // under attack: forget, rather than grow without bound
    }
    let e = this.hits.get(key);
    if (!e || e.resetAt <= t) { e = { count: 0, resetAt: t + this.windowMs }; this.hits.set(key, e); }
    e.count++;
    const allowed = e.count <= this.max;
    return { allowed, limit: this.max, remaining: Math.max(0, this.max - e.count), resetAt: e.resetAt, retryAfterSec: Math.max(1, Math.ceil((e.resetAt - t) / 1000)) };
  }
}

export interface SharedLimiterOptions {
  url: string; token: string; max: number; windowMs: number; now: () => number;
  /** Used when the shared store does not answer, so a store outage never takes the API down. */
  fallback: Limiter;
  fetch?: typeof fetch;
  onError?: (message: string) => void;
}

/**
 * Fixed-window limiter whose counters live in an Upstash Redis (REST) store, so every instance of the
 * API shares one count. It only increments counters: it cannot read jobs or touch the chain. The client
 * key is hashed before it is stored. If the store fails, the in-memory limiter takes over.
 */
export class SharedRateLimiter implements Limiter {
  private readonly o: SharedLimiterOptions;
  constructor(o: SharedLimiterOptions) { this.o = o; }
  async check(key: string): Promise<LimitResult> {
    const { max, windowMs } = this.o;
    const t = this.o.now();
    const bucket = Math.floor(t / windowMs);
    const resetAt = (bucket + 1) * windowMs;
    try {
      const k = `allocyn:rl:${bucket}:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
      const res = await (this.o.fetch ?? fetch)(`${this.o.url.replace(/\/+$/, "")}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.o.token}`, "Content-Type": "application/json" },
        body: JSON.stringify([["INCR", k], ["PEXPIRE", k, String(windowMs * 2)]]),
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) throw new Error(`store answered ${res.status}`);
      const out = (await res.json()) as Array<{ result?: unknown; error?: string }>;
      const count = Number(out?.[0]?.result);
      if (!Number.isInteger(count) || out?.[0]?.error) throw new Error("store gave no count");
      return { allowed: count <= max, limit: max, remaining: Math.max(0, max - count), resetAt, retryAfterSec: Math.max(1, Math.ceil((resetAt - t) / 1000)) };
    } catch (e) {
      this.o.onError?.(e instanceof Error ? e.message : String(e));
      return this.o.fallback.check(key);
    }
  }
}
