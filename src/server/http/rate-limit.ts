/**
 * Rate limiting.
 *
 * A sliding-window counter held in process memory. Two honest caveats, both
 * documented rather than hidden:
 *
 *  1. **It is per-instance.** Three replicas allow three times the configured
 *     rate. For a single-instance or modest deployment that is fine; past that,
 *     swap the store for Redis — `RateLimitStore` exists to make that a drop-in
 *     change rather than a rewrite.
 *  2. **It is a fairness and accident guard, not DDoS protection.** A real
 *     volumetric attack is stopped at the edge, before it reaches Node. What this
 *     prevents is one integration's retry loop starving every other tenant.
 *
 * The window is sliding rather than fixed because a fixed window lets a client
 * send a full quota at 11:59:59 and another at 12:00:00 — twice the intended rate
 * across the boundary.
 */

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Seconds until the caller may retry. Zero when allowed. */
  readonly retryAfterSeconds: number;
  /** Epoch milliseconds at which the current window fully clears. */
  readonly resetAt: number;
}

export interface RateLimitStore {
  hit(key: string, windowMs: number, limit: number, now: number): RateLimitResult;
}

/**
 * In-memory sliding window.
 *
 * Keeps the timestamp of each hit and discards those outside the window. Bounded
 * by `limit` entries per key, so memory is proportional to active keys × limit
 * rather than to traffic.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  hit(key: string, windowMs: number, limit: number, now: number): RateLimitResult {
    this.sweep(now, windowMs);

    const cutoff = now - windowMs;
    const timestamps = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= limit) {
      const oldest = timestamps[0] ?? now;
      const resetAt = oldest + windowMs;
      this.hits.set(key, timestamps);
      return {
        allowed: false,
        limit,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
        resetAt,
      };
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);

    return {
      allowed: true,
      limit,
      remaining: limit - timestamps.length,
      retryAfterSeconds: 0,
      resetAt: now + windowMs,
    };
  }

  /** Drop keys with no recent activity, at most once a minute. */
  private sweep(now: number, windowMs: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;

    const cutoff = now - windowMs;
    for (const [key, timestamps] of this.hits) {
      const live = timestamps.filter((t) => t > cutoff);
      if (live.length === 0) this.hits.delete(key);
      else this.hits.set(key, live);
    }
  }

  /** Test helper. */
  clear(): void {
    this.hits.clear();
    this.lastSweep = 0;
  }
}

const defaultStore = new MemoryRateLimitStore();

export interface RateLimitOptions {
  readonly limit: number;
  readonly windowMs?: number;
  readonly store?: RateLimitStore;
  readonly now?: number;
}

export function checkRateLimit(key: string, options: RateLimitOptions): RateLimitResult {
  const { limit, windowMs = 60_000, store = defaultStore, now = Date.now() } = options;
  return store.hit(key, windowMs, limit, now);
}

/** Standard rate-limit headers, so clients can back off before being refused. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'ratelimit-limit': String(result.limit),
    'ratelimit-remaining': String(result.remaining),
    'ratelimit-reset': String(Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000))),
  };
}

/**
 * Build the bucket key for a request.
 *
 * Keyed by API key or session where possible, so one tenant's traffic cannot
 * exhaust another's budget. IP is the fallback for unauthenticated requests, and
 * it is a poor one — a whole office behind one NAT shares a bucket — which is why
 * the login limiter below keys on the account instead.
 */
export function rateLimitKey(identity: { apiKeyId?: string; userId?: string; ip?: string }): string {
  if (identity.apiKeyId !== undefined) return `key:${identity.apiKeyId}`;
  if (identity.userId !== undefined) return `user:${identity.userId}`;
  return `ip:${identity.ip ?? 'unknown'}`;
}

/**
 * A much tighter limit for authentication attempts.
 *
 * Keyed on the account being targeted rather than the source address, so an
 * attacker rotating through a proxy pool still cannot brute-force one account.
 */
export function checkLoginRateLimit(emailHash: string, now = Date.now()): RateLimitResult {
  return checkRateLimit(`login:${emailHash}`, { limit: 10, windowMs: 15 * 60_000, now });
}
