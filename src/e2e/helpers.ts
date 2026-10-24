import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.env.E2E_PORT ?? 3111)

export const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`
export const AUTH_DIR = path.join(__dirname, '.auth')
export const FOUNDER_STATE = path.join(AUTH_DIR, 'founder.json')
export const AFNAN_STATE = path.join(AUTH_DIR, 'afnan.json')

export const FOUNDER_EMAIL = process.env.E2E_FOUNDER_EMAIL ?? process.env.E2E_EMAIL ?? ''
export const AFNAN_EMAIL = process.env.E2E_AFNAN_EMAIL ?? 'afnan@decoricks.com'
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? ''

export const CSRF_COOKIE = 'decoricks_csrf'
export const CSRF_HEADER = 'x-csrf-token'

/** Reads the JS-readable CSRF cookie out of a saved storage state. */
export const csrfFromState = (file: string): string => {
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    cookies?: Array<{ name: string; value: string }>
  }
  return state.cookies?.find((entry) => entry.name === CSRF_COOKIE)?.value ?? ''
}

/**
 * A different source address for every e2e client, as a real deployment has one
 * per visitor.
 *
 * `loginRateLimiter` allows 10 attempts a minute **per IP**
 * (`src/lib/rate-limit.ts:93`, read from `x-forwarded-for` by `getRequestMeta`,
 * `src/lib/http.ts:51-56`). Everything Playwright sends arrives from
 * 127.0.0.1, so two workers and every file in this suite share one bucket and
 * drain it. The observed damage: the lockout test in `phase10-security.spec.ts`
 * was answering 429 `RATE_LIMITED` on its fourth wrong password while asserting
 * 401, so it had stopped testing the email-keyed lockout it exists to test — and
 * `phase2-auth.spec.ts` was shown "Too many login attempts" instead of the
 * credential error it asserts. Both were failures of the harness, not of the app.
 *
 * The limiter is a brute-force control, so nothing about it is weakened or
 * disabled for tests: each client simply gets its own budget, exactly as it
 * would in production, and a single client hammering the endpoint is still
 * throttled. Addresses come from 10.10.0.0/16 — private (RFC 1918), and never a
 * real peer of a localhost test server.
 */
let clientIpSequence = 0
export const nextClientIp = (): string => {
  clientIpSequence += 1
  // Mix in the pid so parallel Playwright workers (separate processes) cannot
  // hand out the same address to each other.
  const n = ((process.pid & 0x3f) << 9) + clientIpSequence
  return `10.10.${(n >> 8) & 0xff}.${n & 0xff}`
}

export const clientIpHeaders = (): Record<string, string> => ({
  'x-forwarded-for': nextClientIp(),
})
