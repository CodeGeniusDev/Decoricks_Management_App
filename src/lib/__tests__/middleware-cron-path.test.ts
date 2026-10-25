/**
 * Middleware behaviour for the one header-authenticated path.
 *
 * `GET /api/cron/notifications` is called by a machine that has no session
 * cookie, so the edge gate has to step aside for it — while continuing to refuse
 * everything else, and without switching any CSRF behaviour off. The whole risk
 * of an exception like this is that it is wider than it looks, so the tests are
 * written as containment checks: the exception admits exactly one URL and
 * nothing that merely resembles it.
 *
 * The route's own secret handling (404 when unconfigured, rate-limited 401,
 * counts-only body) is covered in `cron-notifications-route.test.ts`. Here the
 * only question is: does the request reach that handler at all, and is anything
 * else changed by the answer?
 */
import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { config, middleware } from '@/middleware'

const SESSION_COOKIE = 'decoricks_session'

const request = (
  path: string,
  {
    method = 'GET',
    session = false,
    headers = {},
  }: { method?: string; session?: boolean; headers?: Record<string, string> } = {}
): NextRequest =>
  new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      ...(session ? { cookie: `${SESSION_COOKIE}=scheduled-cron-test-token` } : {}),
      ...headers,
    },
  })

/** Middleware's "let it through" answer, as opposed to its own 401 or redirect. */
const passedThrough = (response: Response): boolean =>
  response.status === 200 && response.headers.get('x-middleware-next') === '1'

/**
 * The CSRF mark is written onto the FORWARD request, so it surfaces as Next's
 * `x-middleware-request-*` header rather than as a response header.
 */
const csrfStamp = (response: Response): string | null =>
  response.headers.get('x-middleware-request-x-csrf-required')

/**
 * Apply middleware's own `config.matcher` to a pathname the way Next does, so a
 * test can prove the cron URL is actually routed through middleware instead of
 * quietly falling outside it.
 */
const matchedByMiddleware = (pathname: string): boolean => {
  const pattern = config.matcher![0]
  expect(pattern.startsWith('/')).toBe(true)
  return new RegExp(`^(?:${pattern.slice(1)})$`).test(pathname.replace(/^\//, ''))
}

describe('/api/cron/notifications at the edge', () => {
  it('passes with no session cookie at all', () => {
    const response = middleware(request('/api/cron/notifications'))
    expect(passedThrough(response)).toBe(true)
    expect(response.headers.get('location')).toBeNull()
    expect(csrfStamp(response)).toBeNull()
  })

  it('passes unchanged whether or not a session cookie happens to be present', () => {
    // The route ignores cookies entirely; middleware must not behave differently
    // for a browser that happens to be logged in, or the secret check would not
    // be the single authority.
    expect(passedThrough(middleware(request('/api/cron/notifications')))).toBe(true)
    expect(passedThrough(middleware(request('/api/cron/notifications', { session: true })))).toBe(
      true
    )
  })

  it('is matched by the middleware at all (the exception is real, not a no-op)', () => {
    // If the cron URL ever landed in the matcher's exclusion list, middleware
    // would stop running for it and the route would still work — hiding the fact
    // that the edge gate no longer sees the path at all.
    expect(matchedByMiddleware('/api/cron/notifications')).toBe(true)
    expect(matchedByMiddleware('/api/notifications')).toBe(true)
    // Sanity for the helper itself: static PWA assets stay outside middleware.
    expect(matchedByMiddleware('/manifest.webmanifest')).toBe(false)
    expect(matchedByMiddleware('/icon-192.png')).toBe(false)
  })
})

describe('the exception does not spread', () => {
  it('refuses a sibling under the same prefix', () => {
    // `/api/cron/anything-else` is NOT in the exception set: listing URLs
    // individually is what keeps this from becoming "the whole /api/cron tree".
    const nested = middleware(request('/api/cron/notifications/extra'))
    expect(nested.status).toBe(401)
    expect(passedThrough(nested)).toBe(false)

    const parent = middleware(request('/api/cron'))
    expect(parent.status).toBe(401)
  })

  it('refuses a near-miss path', () => {
    expect(middleware(request('/api/cron/notifications-')).status).toBe(401)
    expect(middleware(request('/api/Cron/notifications')).status).toBe(401)
  })

  it('still refuses every other API route anonymously', async () => {
    const response = middleware(request('/api/notifications'))
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('UNAUTHENTICATED')
    expect(middleware(request('/api/tasks')).status).toBe(401)
    expect(middleware(request('/api/users')).status).toBe(401)
    expect(middleware(request('/api/finance')).status).toBe(401)
  })

  it('still redirects an anonymous app screen to login', () => {
    const response = middleware(request('/tasks'))
    expect(response.status).toBe(307)
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login')
  })

  it('still stamps CSRF on state-changing API calls that do have a session', () => {
    // A GET is a safe method, so the cron route would never have been stamped
    // even without the exception — the exception must not have relaxed the rule
    // for the writes that DO need it.
    expect(csrfStamp(middleware(request('/api/cron/notifications', { method: 'POST' })))).toBeNull()

    expect(csrfStamp(middleware(request('/api/tasks', { method: 'POST', session: true })))).toBe(
      '1'
    )
    expect(
      csrfStamp(middleware(request('/api/finance/expense/1', { method: 'DELETE', session: true })))
    ).toBe('1')

    // Safe methods with a session are never stamped, and remain allowed through.
    expect(csrfStamp(middleware(request('/api/tasks', { session: true })))).toBeNull()
    expect(passedThrough(middleware(request('/api/tasks', { session: true })))).toBe(true)
  })

  it('keeps the genuinely public paths public', () => {
    for (const path of ['/login', '/api/auth/login', '/api/health']) {
      expect(passedThrough(middleware(request(path)))).toBe(true)
    }
    // change-password needs a session and still says so.
    expect(middleware(request('/api/auth/change-password')).status).toBe(401)
  })

  it('cannot be reached as a state-changing call, because the route exports none', async () => {
    // Middleware waves this path through, so the last piece of containment is
    // that the handler exists for GET only: a POST/PUT/DELETE to the session-free
    // path is answered by Next with a 405 before any handler runs.
    const route = await import('@/app/api/cron/notifications/route')
    const handlers = Object.keys(route).filter((key) => /^[A-Z]+$/.test(key))
    expect(handlers).toEqual(['GET'])
  })
})
