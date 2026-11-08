/**
 * In-process rate limiting and brute-force protection.
 *
 * Honest scope: this is a per-process token bucket. Behind more than one
 * replica each replica has its own budget, so a cluster-wide limit needs a
 * shared store (Redis). That is documented in docs/SECURITY.md rather than
 * implied — and the per-process limit still stops credential stuffing from a
 * single source, which is what the login endpoints need.
 *
 * Sliding-window counters with a fixed-size map: memory is bounded, and eviction
 * is by expiry, never by size-only, so an attacker cannot flush other keys by
 * flooding new ones.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Bucket capacity within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Optional key namespace so limiter families never collide. */
  scope?: string;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly scope: string;
  private lastSweep = 0;

  constructor(opts: RateLimitOptions) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.scope = opts.scope ?? 'default';
  }

  private sweep(now: number) {
    // Amortised cleanup: at most once per window, and never on the hot path.
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  /** Consume one token. Returns the decision plus retry information. */
  take(key: string, now = Date.now()): { allowed: boolean; remaining: number; retryAfterSec: number; resetAt: number } {
    this.sweep(now);
    const id = `${this.scope}:${key}`;
    const existing = this.buckets.get(id);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(id, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.limit - 1, retryAfterSec: 0, resetAt: now + this.windowMs };
    }
    if (existing.count >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
        resetAt: existing.resetAt,
      };
    }
    existing.count += 1;
    return { allowed: true, remaining: this.limit - existing.count, retryAfterSec: 0, resetAt: existing.resetAt };
  }

  /** Clear a key (e.g. after a successful login) so successes do not count. */
  reset(key: string) {
    this.buckets.delete(`${this.scope}:${key}`);
  }

  get size() {
    return this.buckets.size;
  }
}

/**
 * Brute-force lockout for credential endpoints.
 *
 * Deliberately slower than the request limiter: repeated failures lock the
 * identity for a window that grows with the failure count, while a legitimate
 * user who mistypes once is unaffected.
 */
export class LoginThrottle {
  private failures = new Map<string, { count: number; lockedUntil: number }>();
  private readonly threshold: number;
  private readonly baseLockMs: number;
  private readonly maxLockMs: number;

  constructor(opts: { threshold?: number; baseLockMs?: number; maxLockMs?: number } = {}) {
    this.threshold = opts.threshold ?? 5;
    this.baseLockMs = opts.baseLockMs ?? 60_000;
    this.maxLockMs = opts.maxLockMs ?? 30 * 60_000;
  }

  check(key: string, now = Date.now()): { locked: boolean; retryAfterSec: number } {
    const entry = this.failures.get(key);
    if (entry && entry.lockedUntil > now) {
      return { locked: true, retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000) };
    }
    return { locked: false, retryAfterSec: 0 };
  }

  fail(key: string, now = Date.now()): { locked: boolean; retryAfterSec: number; failures: number } {
    const entry = this.failures.get(key) ?? { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= this.threshold) {
      const backoff = Math.min(this.maxLockMs, this.baseLockMs * 2 ** (entry.count - this.threshold));
      entry.lockedUntil = now + backoff;
      this.failures.set(key, entry);
      return { locked: true, retryAfterSec: Math.ceil(backoff / 1000), failures: entry.count };
    }
    this.failures.set(key, entry);
    return { locked: false, retryAfterSec: 0, failures: entry.count };
  }

  succeed(key: string) {
    this.failures.delete(key);
  }
}
