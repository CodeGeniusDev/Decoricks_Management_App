/**
 * GET /api/cron/notifications — the contract of the external timer route.
 *
 * The route exists so a free cron service can run the EXISTING notification
 * sweep on a host with no clock of its own. Being the only route in the app that
 * authenticates with a shared secret instead of a session, everything a session
 * would normally give for free has to be proven here explicitly:
 *
 *   • UNCONFIGURED IS INVISIBLE — no `CRON_SECRET` (or one below the 32-character
 *     minimum) answers 404 and never touches the database or the sweep.
 *   • A WRONG SECRET BUYS NOTHING — generic 401, no counts, no hint of which
 *     header is wanted, the attempted value never reaches the log, and repeated
 *     guessing from one IP is capped by the rate limiter while a different IP is
 *     unaffected and a CORRECT secret is never limited at all.
 *   • THE COMPARISON IS CONSTANT-TIME — asserted by watching the actual
 *     `timingSafeEqual` call: it must run once per attempt, on two fixed 32-byte
 *     digests, even when the submitted value is a completely different length.
 *     That is the property a naive `a === b` or a length check would leak.
 *   • COUNTS ONLY — the success body is an exact allowlist of four numbers.
 *   `Cache-Control: no-store` on every answer.
 *
 * The sweep itself is mocked here so each case controls one variable; the real
 * throttle and dedupe are exercised against real logic in
 * `cron-notifications-sweep.test.ts`.
 *
 * `vi.resetModules()` per test matters more here than in most suites: the route,
 * `getEnv()` and the rate limiters all keep process-local state, and reloading
 * gives every case a fresh secret cache and fresh limiter buckets.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { NextRequest } from 'next/server'
import { __resetEnvForTests } from '@/lib/env'

const mocks = vi.hoisted(() => ({
  maybeRunNotificationSweep: vi.fn(),
  getDatabase: vi.fn(),
  timingSafeEqual: vi.fn(),
}))

vi.mock('@/lib/notifications/sweep', () => ({
  maybeRunNotificationSweep: mocks.maybeRunNotificationSweep,
  runNotificationSweep: vi.fn(),
  __resetSweepForTests: vi.fn(),
  SWEEP_INTERVAL_MS: 15 * 60 * 1000,
  DUE_SOON_WINDOW_MS: 48 * 60 * 60 * 1000,
}))

vi.mock('@/lib/mongodb', () => ({
  getDatabase: mocks.getDatabase,
}))

// Only `timingSafeEqual` is swapped, for a spy with the real behaviour. The
// route's own `createHash` comes from the untouched original module.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, default: actual, timingSafeEqual: mocks.timingSafeEqual }
})

/** A 40-character valid secret; anything this long clears the minimum. */
const SECRET = 'c'.repeat(40)
const DB = { __cronTestDb: true }

type RouteModule = typeof import('@/app/api/cron/notifications/route')

const loadRoute = async (): Promise<RouteModule> => {
  vi.resetModules()
  __resetEnvForTests()
  return await import('@/app/api/cron/notifications/route')
}

/** The route reads nothing but headers, so a plain Request is a faithful caller. */
const request = (headers: Record<string, string> = {}): NextRequest =>
  new Request('http://localhost/api/cron/notifications', {
    headers: { 'x-forwarded-for': '203.0.113.7', ...headers },
  }) as unknown as NextRequest

const withSecret = (secret = SECRET): Record<string, string> => ({ 'x-cron-secret': secret })

let warn: MockInstance
let error: MockInstance
let out: MockInstance

/** Everything the route wrote to the server log, so a test can prove a value is absent from it. */
const loggedLines = (): string =>
  [...warn.mock.calls, ...error.mock.calls, ...out.mock.calls]
    .map((call: unknown[]) => call.join(' '))
    .join('\n')

beforeEach(() => {
  mocks.maybeRunNotificationSweep.mockReset()
  mocks.maybeRunNotificationSweep.mockResolvedValue({
    executed: true,
    failed: false,
    overdue: 1,
    dueSoon: 2,
    lowStock: 3,
  })
  mocks.getDatabase.mockReset()
  mocks.getDatabase.mockResolvedValue(DB)
  mocks.timingSafeEqual.mockReset()
  mocks.timingSafeEqual.mockImplementation((a: Buffer, b: Buffer) => a.equals(b))

  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  out = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  process.env.CRON_SECRET = SECRET
})

afterEach(() => {
  warn.mockRestore()
  error.mockRestore()
  out.mockRestore()
  delete process.env.CRON_SECRET
})

describe('/api/cron/notifications when it is not configured', () => {
  it('answers 404 and runs nothing when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET
    const route = await loadRoute()

    const res = await route.GET(request(withSecret()))
    expect(res.status).toBe(404)
    expect(mocks.maybeRunNotificationSweep).not.toHaveBeenCalled()
    expect(mocks.getDatabase).not.toHaveBeenCalled()

    const body = await res.json()
    expect(body.success).toBe(false)
    // No "please set CRON_SECRET" hint: that would advertise the route.
    expect(JSON.stringify(body)).not.toMatch(/CRON|secret|cron/i)
  })

  it('treats a secret shorter than 32 characters as unset, without crashing', async () => {
    // 31 characters: one short of the minimum. A zod `.min(32)` in env.ts would
    // have thrown here and taken the whole app down instead.
    process.env.CRON_SECRET = 'a'.repeat(31)
    const route = await loadRoute()

    const res = await route.GET(request(withSecret('a'.repeat(31))))
    expect(res.status).toBe(404)
    expect(mocks.maybeRunNotificationSweep).not.toHaveBeenCalled()

    // The operator is told what to fix, and the value is not echoed anywhere.
    const message = error.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(message).toMatch(/CRON_SECRET/)
    expect(message).toMatch(/32/)
    expect(message).not.toContain('aaaa')
  })

  it('warns about a too-short secret once, not on every request', async () => {
    process.env.CRON_SECRET = 'a'.repeat(8)
    const route = await loadRoute()

    await route.GET(request(withSecret('a'.repeat(8))))
    await route.GET(request(withSecret('a'.repeat(8))))
    await route.GET(request(withSecret('a'.repeat(8))))

    expect(error.mock.calls.filter((c) => String(c[0]).includes('CRON_SECRET'))).toHaveLength(1)
  })
})

describe('/api/cron/notifications secret check', () => {
  it('rejects a missing header with a generic 401 and no counts', async () => {
    const route = await loadRoute()
    const res = await route.GET(request())
    expect(res.status).toBe(401)

    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.data).toBeUndefined()
    expect(JSON.stringify(body)).not.toMatch(/overdue|dueSoon|lowStock/)
    expect(mocks.maybeRunNotificationSweep).not.toHaveBeenCalled()
  })

  it('rejects a wrong secret with 401 and never logs the submitted value', async () => {
    const route = await loadRoute()
    const attempted = 'wrong-guess-should-not-appear-in-logs-000000'
    const res = await route.GET(request(withSecret(attempted)))
    expect(res.status).toBe(401)
    expect(mocks.maybeRunNotificationSweep).not.toHaveBeenCalled()

    expect(loggedLines()).not.toContain(attempted)
    expect(loggedLines()).not.toContain('wrong-guess')
    expect((await res.json()).error?.code).toBe('UNAUTHORIZED')
  })

  it('compares through timingSafeEqual on fixed-size digests, even for a different-length guess', async () => {
    const route = await loadRoute()
    // 3 characters vs the 40-character configured secret: a `===` or a length
    // guard would answer this one measurably faster and leak the length.
    await route.GET(request(withSecret('abc')))

    expect(mocks.timingSafeEqual).toHaveBeenCalledTimes(1)
    const [a, b] = mocks.timingSafeEqual.mock.calls[0] as [Buffer, Buffer]
    expect(a).toBeInstanceOf(Buffer)
    expect(b).toBeInstanceOf(Buffer)
    expect(a.length).toBe(32)
    expect(b.length).toBe(32)
    expect(a.equals(b)).toBe(false)
    // And the raw secret is not what was compared — only its digest.
    expect(Buffer.compare(a, Buffer.from(SECRET))).not.toBe(0)
  })

  it('accepts the right secret and reports the sweep counts', async () => {
    const route = await loadRoute()
    const res = await route.GET(request(withSecret()))
    expect(res.status).toBe(200)
    expect(mocks.timingSafeEqual).toHaveBeenCalledTimes(1)
    expect(mocks.maybeRunNotificationSweep).toHaveBeenCalledTimes(1)
    expect(mocks.maybeRunNotificationSweep).toHaveBeenCalledWith(DB)

    const body = await res.json()
    expect(body).toMatchObject({
      success: true,
      data: { executed: true, overdue: 1, dueSoon: 2, lowStock: 3 },
    })
  })

  it('answers a throttled sweep with executed false and zero counts', async () => {
    mocks.maybeRunNotificationSweep.mockResolvedValue({
      executed: false,
      failed: false,
      overdue: 0,
      dueSoon: 0,
      lowStock: 0,
    })
    const route = await loadRoute()

    const res = await route.GET(request(withSecret()))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      executed: false,
      overdue: 0,
      dueSoon: 0,
      lowStock: 0,
    })
  })
})

describe('/api/cron/notifications rate limiting', () => {
  it('caps repeated wrong guesses from one IP at 10 per minute, then 429', async () => {
    const route = await loadRoute()
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) {
      const res = await route.GET(request(withSecret(`guess-${i}-${'x'.repeat(35)}`)))
      statuses.push(res.status)
    }

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401))
    expect(statuses.slice(10)).toEqual([429, 429])
    expect(mocks.maybeRunNotificationSweep).not.toHaveBeenCalled()
  })

  it('gives the 429 a Retry-After and a body with no information in it', async () => {
    const route = await loadRoute()
    for (let i = 0; i < 11; i++) {
      await route.GET(request(withSecret(`nope-${i}-${'y'.repeat(36)}`)))
    }
    const res = await route.GET(request(withSecret('final-attempt-zzzzzzzzzzzzzzzzzzzzzzzzzzzz')))

    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    const body = await res.json()
    expect(body.error.code).toBe('RATE_LIMITED')
    expect(JSON.stringify(body)).not.toMatch(/overdue|dueSoon|lowStock|CRON|secret/i)
  })

  it('limits per IP: one IP being blocked does not block another', async () => {
    const route = await loadRoute()
    for (let i = 0; i < 11; i++) {
      await route.GET(
        request({ 'x-forwarded-for': '198.51.100.1', ...withSecret('bad'.repeat(15)) })
      )
    }
    const blocked = await route.GET(
      request({ 'x-forwarded-for': '198.51.100.1', ...withSecret('bad'.repeat(15)) })
    )
    expect(blocked.status).toBe(429)

    const otherIp = await route.GET(
      request({ 'x-forwarded-for': '198.51.100.2', ...withSecret('bad'.repeat(15)) })
    )
    expect(otherIp.status).toBe(401)
  })

  it('counts only failures, so a correctly configured monitor is never limited', async () => {
    const route = await loadRoute()
    // Far more successes than the 10-per-minute failure ceiling allows.
    for (let i = 0; i < 25; i++) {
      const res = await route.GET(request(withSecret()))
      expect(res.status).toBe(200)
    }
    expect(mocks.maybeRunNotificationSweep).toHaveBeenCalledTimes(25)
  })

  it('has a process-wide backstop so rotating the client IP does not buy free attempts', async () => {
    const route = await loadRoute()
    const statuses: number[] = []
    // A fresh source IP per request: the per-IP bucket never fills, but the
    // shared one does at 30.
    for (let i = 0; i < 35; i++) {
      const res = await route.GET(
        request({
          'x-forwarded-for': `192.0.2.${i % 250}`,
          ...withSecret(`rotating-ip-guess-${i}-${'w'.repeat(30)}`),
        })
      )
      statuses.push(res.status)
    }
    expect(statuses.filter((s) => s === 401)).toHaveLength(30)
    expect(statuses.slice(30)).toEqual(Array(5).fill(429))
  })
})

describe('/api/cron/notifications response hygiene', () => {
  it('never caches, on success or on refusal', async () => {
    const route = await loadRoute()

    const ok = await route.GET(request(withSecret()))
    expect(ok.headers.get('cache-control')).toBe('no-store')

    const denied = await route.GET(request(withSecret('n'.repeat(40))))
    expect(denied.headers.get('cache-control')).toBe('no-store')

    delete process.env.CRON_SECRET
    const absent = await (await loadRoute()).GET(request(withSecret()))
    expect(absent.headers.get('cache-control')).toBe('no-store')
  })

  it('answers with an exact allowlist of four numbers, nothing else', async () => {
    const route = await loadRoute()
    const res = await route.GET(request(withSecret()))
    const body = await res.json()

    expect(Object.keys(body).sort()).toEqual(['data', 'success', 'timestamp'])
    expect(Object.keys(body.data).sort()).toEqual(['dueSoon', 'executed', 'lowStock', 'overdue'])
  })

  it('lets a database outage surface as a real failure instead of a fake OK', async () => {
    // The monitor's whole value is the failure email, so an unreachable database
    // must not be answered with a 200. Named like the driver's own error, which is
    // one of the shapes `isTransientMongoError` recognises.
    const unreachable = new Error('Server selection timed out after 5000 ms')
    unreachable.name = 'MongoServerSelectionError'
    mocks.getDatabase.mockRejectedValue(unreachable)
    const route = await loadRoute()

    const res = await route.GET(request(withSecret()))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE')
    expect(JSON.stringify(body)).not.toContain('Server selection')
    expect(mocks.maybeRunNotificationSweep).not.toHaveBeenCalled()
  })

  it('answers a sweep that failed internally as a failure, not a quiet 200', async () => {
    // `maybeRunNotificationSweep` never rejects — it swallows the error so the
    // bell can render — and reports it as `failed: true`. On a normal read that
    // silence is right; on the only clock the system has, a permanent 200 would
    // make a broken sweep look healthy forever.
    mocks.maybeRunNotificationSweep.mockResolvedValue({
      executed: false,
      failed: true,
      overdue: 0,
      dueSoon: 0,
      lowStock: 0,
    })
    const route = await loadRoute()

    const res = await route.GET(request(withSecret()))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE')
    // No counts and no internals in the body; the detail lives in the log.
    expect(body.data).toBeUndefined()
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(loggedLines()).toMatch(/sweep failed/)
  })

  it('answers a generic 500 with a trace id for an unexpected failure', async () => {
    mocks.getDatabase.mockRejectedValue(new Error('boom: internal driver detail'))
    const route = await loadRoute()

    const res = await route.GET(request(withSecret()))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(body.error.details.traceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(body)).not.toContain('boom: internal driver detail')
  })
})
