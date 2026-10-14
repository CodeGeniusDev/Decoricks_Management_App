/**
 * Sliding-window rate limiter, process-local.
 *
 * The deployment is a single persistent Node host (Checkpoint 1), so an
 * in-memory limiter is both correct and the cheapest option — no Redis, no
 * paid service. It exists to stop a runaway client (a stuck auto-retry loop, a
 * tab left hammering Enter) from flooding the channel, not to defend against a
 * distributed attack; a multi-instance deployment would need a shared store,
 * which is noted as a limit in docs/REALTIME.md.
 *
 * Buckets are pruned on every `consume` so a burst of one-off keys cannot grow
 * the map without bound; the sweep interval also caps the worst-case cost.
 */

export interface RateResult {
  allowed: boolean
  /** Milliseconds until the oldest hit leaves the window; only meaningful when blocked. */
  retryAfterMs: number
  remaining: number
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>()
  private lastSweep = 0

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  consume(key: string, now = Date.now()): RateResult {
    this.sweep(now)
    const cutoff = now - this.windowMs
    const bucket = (this.hits.get(key) ?? []).filter((t) => t > cutoff)

    if (bucket.length >= this.limit) {
      // Oldest hit must age out before a new one fits.
      this.hits.set(key, bucket)
      const retryAfterMs = Math.max(0, bucket[0] + this.windowMs - now)
      return { allowed: false, retryAfterMs, remaining: 0 }
    }

    bucket.push(now)
    this.hits.set(key, bucket)
    return { allowed: true, retryAfterMs: 0, remaining: this.limit - bucket.length }
  }

  /** Forget a key entirely — used when a send turns out to be an idempotent retry. */
  release(key: string): void {
    this.hits.delete(key)
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return
    this.lastSweep = now
    const cutoff = now - this.windowMs
    for (const [key, bucket] of this.hits) {
      const live = bucket.filter((t) => t > cutoff)
      if (live.length === 0) this.hits.delete(key)
      else this.hits.set(key, live)
    }
  }
}

/**
 * Message-send budget: 20 messages per 10s per (user, channel). Comfortably
 * above real human typing for a 4-person team, low enough to blunt an auto-loop.
 */
export const messageSendLimiter = new SlidingWindowRateLimiter(20, 10_000)
