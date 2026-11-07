/** Fixed-window limiter per client key, in memory. One process only: behind several instances use the gateway's limiter too. */
export class RateLimiter {
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
