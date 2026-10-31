/**
 * The edge refuses credentials in a URL.
 *
 * `credential-query.test.ts` covers the matching rules; this covers the decision
 * middleware makes with them, because that is where the security properties live:
 *
 *   - the value never leaves the request. It is not echoed in a body, a header, a
 *     redirect target or a log line — so the assertions are written against a
 *     sentinel and check the whole response, not just the field under test;
 *   - the guard sits above `isPublic`. `/login` and `/api/auth/login` are the two
 *     paths a leaked credential URL actually uses, and both are public — a guard
 *     placed after that early return would never see the case it exists for;
 *   - a refusal must not become an outage. Every query key the app really uses is
 *     asserted to still pass through untouched.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'

const SESSION_COOKIE = 'decoricks_session'

/** If a value ever survives the guard, one of the assertions below will catch it. */
const SENTINEL = 'Sup3r-Secret-Pa55w0rd'

const request = (
  path: string,
  { method = 'GET', session = false }: { method?: string; session?: boolean } = {}
): NextRequest =>
  new NextRequest(`http://localhost${path}`, {
    method,
    headers: session ? { cookie: `${SESSION_COOKIE}=credential-url-test-token` } : {},
  })

/** Middleware's "let it through" answer, as opposed to its own refusal. */
const passedThrough = (response: Response): boolean =>
  response.status === 200 && response.headers.get('x-middleware-next') === '1'

const location = (response: Response): string => response.headers.get('location') ?? ''

/** Every byte the response puts on the wire, for the "value never echoes" checks. */
const wire = async (response: Response): Promise<string> => {
  const clone = new Response(await response.arrayBuffer(), { headers: response.headers })
  const body = await clone.text()
  return [...response.headers, body].join(' ')
}

const warned = () => {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  return { spy, lines: () => spy.mock.calls.map((call) => String(call[0])) }
}

let log: ReturnType<typeof warned>

afterEach(() => {
  log?.spy.mockRestore()
  vi.restoreAllMocks()
})

describe('credentials in the query string are refused', () => {
  it('redirects a leaked login URL to the same page without the secret', async () => {
    log = warned()
    const response = middleware(request(`/login?email=a@b.pk&password=${SENTINEL}`))

    expect(response.status).toBe(302)
    const target = new URL(location(response))
    expect(target.pathname).toBe('/login')
    expect(target.searchParams.get('email')).toBe('a@b.pk')
    expect(target.searchParams.get('password')).toBeNull()
    expect(await wire(response)).not.toContain(SENTINEL)
  })

  it('keeps `next` so the visitor still ends up where they were going', () => {
    const response = middleware(request(`/login?password=${SENTINEL}&next=%2Ftasks`))
    const target = new URL(location(response))
    expect(target.searchParams.get('next')).toBe('/tasks')
    expect(target.search).toBe('?next=%2Ftasks')
  })

  it('does not leave an empty question mark behind when nothing survives', () => {
    const response = middleware(
      request(`/change-password?currentPassword=${SENTINEL}&newPassword=${SENTINEL}`)
    )
    expect(location(response)).toBe('http://localhost/change-password')
    expect(location(response).endsWith('?')).toBe(false)
  })

  it('sends any other tainted page to sign-in with the clean pathname only', async () => {
    log = warned()
    const response = middleware(request(`/tasks?password=${SENTINEL}&search=sofa`))
    const target = new URL(location(response))
    expect(target.pathname).toBe('/login')
    expect(target.searchParams.get('next')).toBe('/tasks')
    // `search=sofa` is legitimate but belongs to /tasks, not to a login URL —
    // forwarding a whole query string is how the leak reproduces one hop later.
    expect(target.searchParams.get('search')).toBeNull()
    expect(await wire(response)).not.toContain(SENTINEL)
  })

  it('answers an API route with JSON, never with a redirect', async () => {
    log = warned()
    const response = middleware(request(`/api/auth/login?password=${SENTINEL}`, { method: 'POST' }))
    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
    expect((await response.json()).error.code).toBe('CREDENTIALS_IN_QUERY')
  })

  it('refuses a bearer token on an authenticated API call', async () => {
    log = warned()
    const response = middleware(request(`/api/tasks?page=1&token=${SENTINEL}`, { session: true }))
    expect(response.status).toBe(400)
    expect(await wire(response)).not.toContain(SENTINEL)
  })

  it('uses 303 for a state-changing method so the browser cannot replay the POST', () => {
    // 302 is ambiguous about method reuse; 303 says "follow this with a GET".
    expect(middleware(request(`/login?password=${SENTINEL}`, { method: 'POST' })).status).toBe(303)
    expect(middleware(request(`/login?password=${SENTINEL}`, { method: 'GET' })).status).toBe(302)
  })

  it('runs before the public-path rule, which is the only order that works', () => {
    // `/api/health` and `/login` are public. Without the guard above `isPublic`,
    // these two are exactly the URLs that would be served as if nothing was wrong.
    expect(passedThrough(middleware(request('/api/health?token=x')))).toBe(false)
    expect(passedThrough(middleware(request('/login?password=x')))).toBe(false)
    expect(
      passedThrough(middleware(request('/api/auth/login?password=x', { method: 'POST' })))
    ).toBe(false)
  })

  it('refuses a valueless key too — a name in a URL is already the leak', () => {
    expect(middleware(request('/login?password')).status).toBe(302)
    expect(middleware(request('/api/tasks?PASSWORD', { session: true })).status).toBe(400)
  })

  it('logs key names and never the URL', () => {
    log = warned()
    middleware(request(`/login?email=a@b.pk&currentPassword=${SENTINEL}`))
    const line = log.lines()[0]
    expect(line).toContain('[credential-url]')
    expect(line).toContain('GET /login')
    expect(line).toContain('currentPassword')
    expect(line).not.toContain(SENTINEL)
    expect(line).not.toContain('a@b.pk')
    expect(line).not.toContain('http://localhost')
  })

  it('says nothing in the user-facing message that could confirm a value', async () => {
    const response = middleware(request(`/api/auth/login?password=${SENTINEL}`, { method: 'POST' }))
    const body = await response.json()
    expect(body.error.message).toContain('URL')
    expect(body.success).toBe(false)
  })
})

describe('legitimate query strings are untouched', () => {
  it('lets the filters the app actually uses through', () => {
    for (const path of [
      '/api/audit-log?page=2&limit=25&outcome=failure',
      '/api/tasks?search=sofa&status=open',
      '/api/finance?from=2026-01-01&to=2026-01-31',
      '/api/products?includeArchived=true&q=table',
      '/settings?tab=audit',
      '/login?next=%2Ftasks',
    ]) {
      expect(
        passedThrough(middleware(request(path, { session: path !== '/login?next=%2Ftasks' }))),
        path
      ).toBe(true)
    }
  })

  it('still redirects an anonymous screen the way it always did', () => {
    const response = middleware(request('/tasks?search=sofa'))
    expect(response.status).toBe(307)
    expect(new URL(location(response)).searchParams.get('next')).toBe('/tasks')
  })

  it('does not log anything for a clean request', () => {
    log = warned()
    middleware(request('/api/audit-log?page=2&search=sofa', { session: true }))
    expect(log.lines()).toEqual([])
  })
})
