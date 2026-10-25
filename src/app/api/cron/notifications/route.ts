import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getEnv } from '@/lib/env'
import { getDatabase } from '@/lib/mongodb'
import {
  errorResponse,
  notFoundError,
  successResponse,
  unauthorizedError,
} from '@/lib/api-response'
import { handleRouteError } from '@/lib/http'
import { maybeRunNotificationSweep } from '@/lib/notifications/sweep'
import { cronAuthFailureGlobalLimiter, cronAuthFailureLimiter } from '@/lib/rate-limit'

/**
 * GET /api/cron/notifications — the external timer for time-based alerts.
 *
 * WHY THIS EXISTS (docs/PUSH_SETUP.md §7): a Render Free instance has no cron
 * and sleeps when nobody is using it, so the overdue / due-soon / low-stock
 * sweep only ever ran when a partner opened the bell or the dashboard. This
 * route is the missing clock: any free external cron service can call it every
 * few minutes, and the request both wakes the instance and runs the sweep.
 *
 * IT ADDS NO RULES. The only thing it does is call the existing
 * `maybeRunNotificationSweep`, the same throttled, deduped entry point the bell
 * uses. No detection, no emitting and no permission logic lives here, so the
 * timer can never disagree with what opening the app would have produced — and
 * a monitor running faster than the 15-minute throttle simply gets
 * `executed: false` instead of a second sweep. The one thing the bell cannot
 * afford (a 5xx because a background alert broke) is what THIS caller does want,
 * so a sweep that throws is answered as 503 rather than a quiet 200.
 *
 * AUTH IS NOT A SESSION. The caller is a machine with no login, so it presents
 * a shared secret in `x-cron-secret` (`CRON_SECRET`). Middleware lets this one
 * path through without a cookie; everything that actually protects the route is
 * below. Three deliberate properties:
 *
 *   • UNCONFIGURED MEANS ABSENT. No `CRON_SECRET`, or one shorter than 32
 *     characters, answers 404 and runs nothing — a deployment that never
 *     wired a monitor exposes no surface at all. It is never answered with a
 *     "set the variable please" hint, which would advertise the route.
 *   • CONSTANT TIME, AND NO BOOT CRASH. The minimum length is enforced HERE,
 *     not in `env.ts`: a `.min(32)` in the schema would make one typo in an
 *     optional variable throw from `getEnv()` and take the whole app down.
 *     The comparison hashes both sides to a fixed 32 bytes first, because
 *     `timingSafeEqual` throws on unequal lengths and an early length check is
 *     exactly the leak it is meant to prevent.
 *   • COUNTS ONLY. The body never carries a title, a name, a message, a user id
 *     or a link — how many alerts were created and nothing else. A leaked or
 *     logged response is therefore harmless, and the submitted secret is never
 *     echoed into a log either.
 *
 * METHOD CHOICE — GET, on purpose:
 *   • The operation is idempotent and already throttled: the worst a repeated
 *     GET can do is run one sweep per 15 minutes. There is no state to double
 *     apply, so a safe method is the honest description of the semantics.
 *   • Free uptime monitors (the same services this route is meant to be pointed
 *     at) issue GET and nothing else. A POST-only route would be unreachable
 *     from the cheapest tools that exist for this job.
 *   • Being a safe method keeps it out of the CSRF stamping in middleware
 *     entirely, and this handler calls no session code, so there is no
 *     double-submit token for a header-authenticated caller to fail.
 *   `Cache-Control: no-store` on every answer stops an intermediary from
 *     replaying a cached 200 in place of a request that never reached the app.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CRON_SECRET_HEADER = 'x-cron-secret'

/** Shorter than this and the secret is guessable, so it is treated as unset. */
const MIN_CRON_SECRET_LENGTH = 32

/** Warn about a too-short secret once per process, not once per request. */
let warnedAboutShortSecret = false

/**
 * The runtime secret, or null when it is absent or too weak to use. Read
 * through `getEnv()` like every other server variable, so it is a genuine
 * runtime read and rotating it needs a restart, not a rebuild.
 */
const configuredSecret = (): string | null => {
  const secret = getEnv().CRON_SECRET
  if (!secret) return null
  if (secret.length < MIN_CRON_SECRET_LENGTH) {
    // The length and the value are both withheld on purpose; the message says
    // what to do about it.
    if (!warnedAboutShortSecret) {
      warnedAboutShortSecret = true
      console.error(
        '[cron] CRON_SECRET is set but is shorter than the required ' +
          `${MIN_CRON_SECRET_LENGTH} characters, so /api/cron/notifications stays disabled. ` +
          'Set a fresh value (openssl rand -base64 32) — the route will not say which is weak.'
      )
    }
    return null
  }
  return secret
}

/** Fixed-length digest, so the comparison below always runs over equal sizes. */
const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

const secretMatches = (provided: string, expected: string): boolean =>
  timingSafeEqual(digest(provided), digest(expected))

/**
 * Same source `getRequestMeta` uses, read off the request instead of Next's
 * header store: this handler has no session to resolve and the limiter key has
 * to be explicit for the tests to aim distinct clients at distinct buckets.
 */
const clientIp = (request: NextRequest): string => {
  const forwarded = request.headers.get('x-forwarded-for')
  return forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown'
}

const noStore = <T extends NextResponse>(response: T): T => {
  response.headers.set('Cache-Control', 'no-store')
  return response
}

/**
 * A bad or missing secret: 401 with a generic body, rate limited per IP with a
 * process-wide backstop, and logged without the submitted value.
 */
const reject = (request: NextRequest): NextResponse => {
  const ipKey = `ip:${clientIp(request)}`
  const perIp = cronAuthFailureLimiter.consume(ipKey)
  const overall = cronAuthFailureGlobalLimiter.consume('process')

  if (!perIp.allowed || !overall.allowed) {
    const retryAfterMs = Math.max(perIp.retryAfterMs, overall.retryAfterMs)
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
    const response = errorResponse('Too many requests', 429, 'RATE_LIMITED')
    response.headers.set('Retry-After', String(retryAfterSeconds))
    // Which bucket tripped matters to an operator, the submitted value never does.
    console.warn(
      `[cron] notification trigger rate limited (${perIp.allowed ? 'process-wide' : 'per-IP'} budget exhausted)`
    )
    return noStore(response)
  }

  // No trace of the attempted value, and no hint about which header is wanted:
  // both would be a free oracle for a guessing loop.
  console.warn('[cron] notification trigger rejected: secret header missing or incorrect')
  return noStore(unauthorizedError())
}

export async function GET(request: NextRequest) {
  const expected = configuredSecret()
  if (!expected) {
    // Indistinguishable from a route that was never built, and nothing ran.
    return noStore(notFoundError('Not found'))
  }

  const provided = request.headers.get(CRON_SECRET_HEADER)
  if (!provided || !secretMatches(provided, expected)) return reject(request)

  try {
    const db = await getDatabase()
    const outcome = await maybeRunNotificationSweep(db)

    // The sweep swallowed its own error (the bell must never fail because of a
    // background alert), so this is the one place that can tell the difference
    // between "already ran recently" and "tried and broke". The timer is the
    // system's only clock: answering 200 here would leave a permanently broken
    // sweep looking green forever. The detail stays in the `[sweep]` log line —
    // the body carries a code and nothing else.
    if (outcome.failed) {
      console.error('[cron] notification sweep failed; see the [sweep] error above')
      return noStore(errorResponse('Notification sweep failed', 503, 'SERVICE_UNAVAILABLE'))
    }

    console.log(
      `[cron] notification trigger accepted (sweep ${outcome.executed ? 'ran' : 'throttled'})`
    )
    return noStore(
      successResponse({
        executed: outcome.executed,
        overdue: outcome.overdue,
        dueSoon: outcome.dueSoon,
        lowStock: outcome.lowStock,
      })
    )
  } catch (error) {
    // A database outage is a real signal for the monitor: `handleRouteError`
    // answers 503/500 with a generic message plus a trace id, so cron-job.org's
    // failure email fires instead of a silent "OK".
    return noStore(handleRouteError(error))
  }
}
