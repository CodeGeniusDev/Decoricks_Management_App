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

/**
 * Cross-module record search budget: 40 lookups per 10s per user. The reference
 * picker debounces keystrokes, so this is far above interactive use; it exists
 * because one search fans out across every module the user can view and a stuck
 * client should not be able to hammer all of them at message-send volume.
 */
export const recordSearchLimiter = new SlidingWindowRateLimiter(40, 10_000)

/**
 * Auth endpoint rate limits (Phase 10).
 *
 * These protect against brute-force and credential-stuffing without relying on
 * a shared store. They are process-local; the single-persistent-Node deployment
 * is the intended host (see docs/REALTIME.md). For a multi-replica deployment
 * they would need to move to Redis — that tradeoff is tracked in
 * KNOWN_LIMITATIONS.md.
 *
 * Per-IP limits (keyed by `x-forwarded-for` / `x-real-ip`, see getRequestMeta):
 * - login:        10 attempts per minute per IP
 * - change-password: 5 attempts per minute per IP (authenticated endpoint)
 * - admin actions:   30 requests per minute per IP for admin/role/user routes
 * - cron secret:     10 FAILED attempts per minute per IP, 30 per minute process-wide
 */
export const loginRateLimiter = new SlidingWindowRateLimiter(10, 60_000)
export const changePasswordRateLimiter = new SlidingWindowRateLimiter(5, 60_000)
export const adminRateLimiter = new SlidingWindowRateLimiter(30, 60_000)

/**
 * Cron-trigger failures (Phase 10 push work).
 *
 * `/api/cron/notifications` authenticates with a shared header secret instead of
 * a session, so it has no account to lock out and no cookie to brute force — only
 * a 32+ character secret to guess. Ten wrong guesses per minute per IP is far
 * above any legitimate schedule (the monitor fires once every 15 minutes) and
 * turns a guessing loop into a 429 instead of free attempts.
 *
 * A DEDICATED bucket, not `loginRateLimiter`: sharing it would let somebody
 * hammering the cron route exhaust a colleague's login budget from the same IP,
 * and the cron service's own IPs must never be able to lock the app out.
 * Counted on FAILED attempts only, so a correctly configured monitor can never
 * rate-limit itself.
 *
 * The per-IP key comes from `x-forwarded-for`, which a client can invent. On the
 * single persistent Node host (Checkpoint 1) Render's proxy overwrites it, but a
 * rotated value would still give an attacker a fresh bucket per request on any
 * deployment that trusts the header — hence the process-wide backstop below. It
 * is the same honest limit every limiter here has: process-local, so a
 * multi-replica deployment would need the shared store (KNOWN_LIMITATIONS.md).
 */
export const cronAuthFailureLimiter = new SlidingWindowRateLimiter(10, 60_000)

/** Process-wide ceiling on failed cron attempts, immune to IP rotation. */
export const cronAuthFailureGlobalLimiter = new SlidingWindowRateLimiter(30, 60_000)
