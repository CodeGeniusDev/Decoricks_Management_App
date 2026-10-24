import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import {
  AFNAN_EMAIL,
  AFNAN_STATE,
  BASE_URL,
  CSRF_COOKIE,
  CSRF_HEADER,
  E2E_PASSWORD,
  FOUNDER_EMAIL,
  FOUNDER_STATE,
  clientIpHeaders,
  csrfFromState,
} from './helpers'

/**
 * Phase 5 §2/§6 — live security and API-verification suite.
 *
 * Everything here goes over real HTTP to the production server that
 * `playwright.config.ts` boots (`next start`, middleware included), because the
 * unit suites in `src/lib/__tests__` call the handlers directly and therefore
 * cannot see two layers that only exist at runtime:
 *
 *   • the edge gate in `src/middleware.ts`, which is what stamps
 *     `x-csrf-required` on state-changing requests — the CSRF check in
 *     `assertCsrf` is inert without it, so the pair has to be tested together;
 *   • the cookie/session plumbing (Set-Cookie on login, rotation, revocation).
 *
 * Deliberately NOT duplicated here: API-level grant/revoke with a real effect is
 * already proven in `phase2-auth.spec.ts`, Partner-vs-Founder navigation in
 * `phase8-reports.spec.ts`, IDOR on notifications in
 * `phase9-notifications-api.test.ts`, and lockout/session-sliding/policy
 * mechanics in `lockout.test.ts`, `session-rolling.test.ts` and
 * `password.test.ts`. What was missing before this file — and what §2 asks for
 * explicitly — is a negative CSRF test: no suite asserted that a mutating
 * request WITHOUT a valid token is actually refused.
 *
 * Serial + chromium-only: these specs create, lock and deactivate accounts and
 * flip session state in the shared `decoricks_test` database.
 */
test.describe.configure({ mode: 'serial' })

test.describe('Phase 5 — security and API verification', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Global server state; run once')
  })

  /**
   * A bare API context with an EMPTY cookie jar.
   *
   * `newContext` must be given `storageState` explicitly. Without it it inherits
   * the project's `use` options — and the projects set `storageState: founderState`
   * — so a context built "to be anonymous" silently authenticates as the Founder.
   * That is exactly what happened on the first run of this file: an unauthenticated
   * `GET /api/auth/me` came back `success:true` with the Founder's record, because
   * the request was never anonymous. The empty state below is what makes the 401
   * assertions mean what they say.
   *
   * `playwright.request.newContext` is used instead of the `request` fixture for
   * the same reason: the fixture carries the project's storage state too.
   */
  type Playwright = typeof import('playwright-core')
  const ANON_STATE = { cookies: [], origins: [] }
  /*
   * `clientIpHeaders()` gives each context its own source address. Without it
   * every login in this file — and every login in every other file running in
   * parallel — arrives as 127.0.0.1 and spends the same 10-per-minute budget,
   * so the lockout test below was refused with 429 `RATE_LIMITED` before the
   * server ever reached the email-keyed check it is written to prove.
   * See the note on `nextClientIp` in helpers.ts.
   */
  const open = (playwright: Playwright): Promise<APIRequestContext> =>
    playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: ANON_STATE,
      extraHTTPHeaders: clientIpHeaders(),
    })

  /**
   * Signs in and returns the context plus the two cookies it was issued.
   *
   * `APIRequestContext` exposes no cookie jar, so the values are read back out of
   * the response headers — via `headersArray()`, because login sends two
   * `Set-Cookie` lines and the flat `headers()` view joins them into one string,
   * where a cookie's own `Expires=` attribute looks indistinguishable from a
   * second cookie's start.
   */
  const cookieValue = (res: APIResponse, name: string): string => {
    for (const header of res.headersArray()) {
      if (header.name.toLowerCase() !== 'set-cookie') continue
      const pair = header.value.split(';')[0]
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim()
    }
    return ''
  }

  const signIn = async (playwright: Playwright, email: string, password = E2E_PASSWORD) => {
    const ctx = await open(playwright)
    const res = await ctx.post('/api/auth/login', { data: { email, password } })
    expect(res.status(), `login failed for ${email}`).toBe(200)
    const csrf = cookieValue(res, CSRF_COOKIE)
    const session = cookieValue(res, 'decoricks_session')
    expect(csrf, 'login issued a CSRF cookie').not.toBe('')
    expect(session, 'login issued a session cookie').not.toBe('')
    return { ctx, csrf, session }
  }

  /** The body of a refusal must never carry internals. Checked on every 4xx. */
  const expectNoInternals = (body: string, context: string) => {
    for (const needle of [
      'MONGODB_URI',
      'mongodb://',
      'mongodb+srv://',
      'MongoServerError',
      'at async ',
      'at Object.',
      'SESSION_SECRET',
      'passwordHash',
      '"stack"',
    ]) {
      expect(body, `${context}: response leaked ${JSON.stringify(needle)}`).not.toContain(needle)
    }
  }

  test('anonymous requests are refused on every module API, and nothing is written', async ({
    playwright,
  }) => {
    const ctx = await open(playwright)

    // One representative read per module family — the point is coverage of the
    // *families*, since 128 handlers are all guarded at source (scripts/route-audit.mjs).
    const protectedGets = [
      '/api/auth/me',
      '/api/tasks',
      '/api/boards',
      '/api/task-labels',
      '/api/chat/channels',
      '/api/notifications',
      '/api/notifications/preferences',
      '/api/push/vapid-public-key',
      '/api/finance/transactions',
      '/api/finance/categories',
      '/api/finance/accounts',
      '/api/finance/settings',
      '/api/finance/distributions',
      '/api/budgets',
      '/api/products',
      '/api/stock',
      '/api/orders',
      '/api/suppliers',
      '/api/purchases',
      '/api/returns',
      '/api/users',
      '/api/roles',
      '/api/audit-log',
      '/api/dashboard',
      '/api/dashboard/reconciliation',
      '/api/reports/period',
      '/api/events',
    ]

    const failures: string[] = []
    for (const path of protectedGets) {
      const res = await ctx.get(path)
      const status = res.status()
      const body = await res.text()
      if (status !== 401) failures.push(`${path} → ${status}`)
      // A refusal that lists rows is worse than a 500: it is a data leak.
      expectNoInternals(body, `GET ${path}`)
      expect(body, `GET ${path} returned a body that mentions stored credentials`).not.toContain(
        '@decoricks'
      )
      // The edge gate answers these; the handler's own 401 has the same envelope.
      expect(status, `GET ${path} body=${body.slice(0, 120)}`).toBe(401)
    }
    expect(failures, `endpoints that did not answer 401: ${failures.join(', ')}`).toEqual([])

    // A rejected write must not have reached the database either. The title is
    // unique enough that any other spec cannot produce it.
    const marker = `SEC-ANON-${Date.now().toString(36)}`
    const post = await ctx.post('/api/tasks', {
      data: {
        boardId: '000000000000000000000000',
        columnId: '000000000000000000000001',
        title: marker,
      },
      headers: { 'content-type': 'application/json' },
    })
    expect(post.status(), 'an anonymous task create must not be accepted').toBe(401)

    const founder = await signIn(playwright, FOUNDER_EMAIL)
    const list = await founder.ctx.get('/api/tasks?limit=100')
    expect(list.ok()).toBeTruthy()
    const { tasks } = (await list.json()).data as { tasks: Array<{ title: string }> }
    expect(
      tasks.filter((t) => t.title === marker),
      'the refused create still wrote a row'
    ).toHaveLength(0)

    await founder.ctx.dispose()
    await ctx.dispose()
  })

  test('a Partner is refused Founder-only APIs, and the refusal carries no data', async ({
    playwright,
  }) => {
    const partner = await playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: AFNAN_STATE,
    })

    // Users, roles, the audit log and reconciliation are role-gated
    // (`requireFounder`), not permission-gated: no grant can open them.
    for (const path of [
      '/api/users',
      '/api/roles',
      '/api/audit-log',
      '/api/dashboard/reconciliation?period=month',
    ]) {
      const res = await partner.get(path)
      const body = await res.text()
      expect(res.status(), `GET ${path} → ${body.slice(0, 160)}`).toBe(403)
      expectNoInternals(body, `GET ${path}`)
      // A 403 that includes the roster is not a refusal.
      expect(body, `GET ${path} leaked account data`).not.toContain(AFNAN_EMAIL)
      expect(body, `GET ${path} leaked account data`).not.toContain(FOUNDER_EMAIL)
    }

    // And the write side of the same boundary.
    const write = await partner.post('/api/users', {
      data: {
        email: 'sec-probe@decoricks.test',
        name: 'Sec Probe',
        role: 'partner_ali',
        password: 'ProbePass2026x',
      },
      headers: { [CSRF_HEADER]: csrfFromState(AFNAN_STATE) },
    })
    expect(write.status(), 'a Partner must not be able to create accounts').toBe(403)
    const writeBody = await write.text()
    expectNoInternals(writeBody, 'POST /api/users as Partner')

    await partner.dispose()
  })

  test('a state-changing request without a CSRF token is refused before it can write', async ({
    playwright,
  }) => {
    const founder = await signIn(playwright, FOUNDER_EMAIL)

    // Logout is a POST, so it is CSRF-gated like any other mutation — and it has
    // no business side effect, which makes it the safest real mutation to probe.
    const noToken = await founder.ctx.post('/api/auth/logout')
    expect(noToken.status(), 'missing CSRF token must be refused').toBe(403)
    const body = await noToken.text()
    expect(body).toContain('INVALID_CSRF')
    expectNoInternals(body, 'POST /api/auth/logout without token')

    // A forged token is refused too — the double-submit check compares the
    // header against the cookie, so a value the attacker picked cannot pass.
    const forged = await founder.ctx.post('/api/auth/logout', {
      headers: { [CSRF_HEADER]: 'attacker-chosen-value' },
    })
    expect(forged.status(), 'a forged CSRF token must be refused').toBe(403)
    expect(await forged.text()).toContain('INVALID_CSRF')

    // The session survived both refusals: without a token, a safe GET still
    // authenticates, and the logout with the correct token then succeeds.
    const stillAlive = await founder.ctx.get('/api/auth/me')
    expect([200, 403], `GET /api/auth/me after refusals → ${stillAlive.status()}`).toContain(
      stillAlive.status()
    )
    expect(stillAlive.status(), 'refused logouts must not terminate the session').toBe(200)

    const good = await founder.ctx.post('/api/auth/logout', {
      headers: { [CSRF_HEADER]: founder.csrf },
    })
    expect(good.status(), 'the same request with the session token must succeed').toBe(200)

    // And the issued cookie is now dead server-side, replayed through a fresh
    // context so nothing but the stale token is presented.
    const replay = await open(playwright)
    const stale = { cookie: `decoricks_session=${founder.session}` }

    // Positive control first. A hand-written `Cookie` header can be ignored by
    // the request context, and if it were, the 401 below would prove nothing
    // about logout — it would just mean "no session was sent". So the same
    // header must still authenticate a live session. (The session under test is
    // already logged out here, hence the equivalent check on a fresh login.)
    const live = await signIn(playwright, AFNAN_EMAIL)
    const control = await replay.get('/api/auth/me', { headers: stale })
    // Founder's cookie is dead; Afnan's is not — prove the header is honoured at
    // all by replaying the one that is still alive.
    const aliveReplay = await replay.get('/api/auth/me', {
      headers: { cookie: `decoricks_session=${live.session}` },
    })
    expect(
      aliveReplay.status(),
      'the harness must honour a replayed Cookie header, or the revocation checks below are vacuous'
    ).toBe(200)

    const after = await replay.get('/api/auth/me', { headers: stale })
    expect(after.status(), 'a logged-out session cookie must not still authenticate').toBe(401)
    expect(control.status(), 'the logged-out cookie must not authenticate').toBe(401)

    await live.ctx.dispose()
    await founder.ctx.dispose()
    await replay.dispose()
  })

  test("another session's CSRF token is refused — replay across accounts fails", async ({
    playwright,
  }) => {
    const founder = await signIn(playwright, FOUNDER_EMAIL)
    const partner = await signIn(playwright, AFNAN_EMAIL)

    // Partner's own session cookie + Founder's CSRF token. Condition 3 of
    // `assertCsrf` binds the token to the session record, so this must 403 even
    // though both values are genuinely ours.
    const crossed = await partner.ctx.post('/api/auth/logout', {
      headers: { [CSRF_HEADER]: founder.csrf },
    })
    expect(crossed.status(), "a foreign session's token must not authorize a mutation").toBe(403)
    expect(await crossed.text()).toContain('INVALID_CSRF')

    // Partner's own token still works, proving the refusal above was the token,
    // not the session.
    const own = await partner.ctx.post('/api/auth/logout', {
      headers: { [CSRF_HEADER]: partner.csrf },
    })
    expect(own.status()).toBe(200)

    await founder.ctx.dispose()
    await partner.ctx.dispose()
  })

  test('malformed input, unknown ids and invalid params fail with the right status and leak nothing', async ({
    playwright,
  }) => {
    const founder = await signIn(playwright, FOUNDER_EMAIL)
    const csrf = { [CSRF_HEADER]: founder.csrf }

    const cases: Array<{
      label: string
      run: () => Promise<APIResponse>
      expect: number[]
    }> = [
      {
        label: 'POST /api/tasks with an empty body',
        run: () => founder.ctx.post('/api/tasks', { data: {}, headers: csrf }),
        expect: [400],
      },
      {
        label: 'POST /api/tasks with type-confusing fields',
        run: () =>
          founder.ctx.post('/api/tasks', {
            data: {
              boardId: 'not-an-id',
              columnId: 42,
              title: { toString: 'x' },
              priority: 'urgent!',
            },
            headers: csrf,
          }),
        expect: [400],
      },
      {
        label: 'POST /api/finance/transactions with a negative amount',
        run: () =>
          founder.ctx.post('/api/finance/transactions', {
            data: { type: 'expense', amount: -100, category: 'nope', date: '2026-13-45' },
            headers: csrf,
          }),
        expect: [400],
      },
      {
        label: 'GET /api/tasks/[id] with a non-ObjectId',
        run: () => founder.ctx.get('/api/tasks/not-a-valid-id'),
        expect: [400, 404],
      },
      {
        label: 'GET /api/tasks/[id] with a well-formed unknown id',
        run: () => founder.ctx.get('/api/tasks/000000000000000000000000'),
        expect: [404],
      },
      {
        // The traversal is percent-encoded on purpose. Sent as literal `../` it is
        // resolved by the router before any handler runs, and the answer is the
        // app's HTML 404 page — which proves nothing about the API. Encoded, it
        // arrives as the `[id]` parameter, and the handler must reject it as JSON.
        label: 'DELETE /api/tasks/[id] with an encoded traversal id',
        run: () => founder.ctx.delete('/api/tasks/..%2F..%2Fetc%2Fpasswd', { headers: csrf }),
        expect: [400, 404],
      },
      {
        label: 'PUT /api/finance/transactions/[id] (records are immutable)',
        run: () =>
          founder.ctx.put('/api/finance/transactions/000000000000000000000000', {
            data: {},
            headers: csrf,
          }),
        expect: [405],
      },
      {
        label: 'PATCH /api/audit-log (the log is append-only)',
        run: () => founder.ctx.patch('/api/audit-log', { data: {}, headers: csrf }),
        expect: [405],
      },
    ]

    for (const c of cases) {
      const res = await c.run()
      const body = await res.text()
      expect(c.expect, `${c.label} → ${res.status()}: ${body.slice(0, 200)}`).toContain(
        res.status()
      )
      expectNoInternals(body, c.label)
      // A 400/404/405 must be a well-formed envelope, not a stack page or empty body.
      const parsed = JSON.parse(body)
      expect(parsed.success, `${c.label}: refusal must be an explicit failure`).toBe(false)
      expect(typeof parsed.error?.code, `${c.label}: refusal must carry a code`).toBe('string')
    }

    await founder.ctx.dispose()
  })

  test('five failed logins lock the account, and the lock refuses even the correct password', async ({
    playwright,
  }) => {
    // A dedicated, uniquely-emailed account: the lockout is keyed by email, so
    // this cannot disturb any other spec's credentials.
    const founder = await signIn(playwright, FOUNDER_EMAIL)
    const email = `sec-lockout-${Date.now().toString(36)}@decoricks.test`

    const created = await founder.ctx.post('/api/users', {
      data: { email, name: 'SEC Lockout Probe', role: 'partner_ali', password: 'ProbePass2026' },
      headers: { [CSRF_HEADER]: founder.csrf },
    })
    expect(created.status(), await created.text().then((t) => t.slice(0, 200))).toBe(201)
    const createdUser = ((await created.json()).data ?? {}) as { user?: { _id?: string } }
    expect(createdUser.user?._id, 'user create must return the new id').toBeTruthy()

    const attacker = await open(playwright)
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await attacker.post('/api/auth/login', {
        data: { email, password: `wrong-password-${attempt}` },
      })
      expect(res.status(), `attempt ${attempt}`).toBe(401)
      // The refusal must not say whether the email exists.
      expect(await res.text()).not.toContain(email)
    }

    // Threshold reached: the next attempt — even with the right password — is
    // refused as a lockout, not authenticated.
    const locked = await attacker.post('/api/auth/login', {
      data: { email, password: 'ProbePass2026' },
    })
    expect(locked.status(), 'the correct password must not bypass a lockout').toBe(429)
    const lockBody = (await locked.json()) as { error?: { code?: string; message?: string } }
    expect(lockBody.error?.code).toBe('ACCOUNT_LOCKED')
    expectNoInternals(JSON.stringify(lockBody), 'login lockout')

    // The lock is recorded in the audit log, which is the only way an operator
    // learns about a brute-force attempt.
    const audit = await founder.ctx.get('/api/audit-log?limit=100')
    expect(audit.ok()).toBeTruthy()
    const entries = ((await audit.json()).data ?? {}) as {
      entries?: Array<{ action: string; userEmail?: string }>
    }
    const seen = (entries.entries ?? []).filter((e) => e.userEmail === email)
    expect(
      seen.some((e) => e.action === 'login_failed'),
      `no login_failed audit entries for ${email} in ${seen.map((e) => e.action).join(',')}`
    ).toBe(true)
    expect(
      seen.some((e) => e.action === 'login_locked'),
      'the lockout itself must be audited'
    ).toBe(true)

    // Cleanup: deactivate the probe account. There is no hard delete by design —
    // the row and its audit trail stay, but the account can no longer sign in.
    const off = await founder.ctx.patch(`/api/users/${createdUser.user?._id}`, {
      data: { isActive: false },
      headers: { [CSRF_HEADER]: founder.csrf },
    })
    expect(off.status(), await off.text().then((t) => t.slice(0, 200))).toBe(200)

    // A deactivated account cannot authenticate even with the correct password,
    // and the refusal is indistinguishable from a wrong one.
    const dead = await attacker.post('/api/auth/login', {
      data: { email, password: 'ProbePass2026' },
    })
    expect([401, 429]).toContain(dead.status())

    await attacker.dispose()
    await founder.ctx.dispose()
  })

  test('deactivating a user kills the session they already hold', async ({ playwright }) => {
    const founder = await signIn(playwright, FOUNDER_EMAIL)
    const email = `sec-revoke-${Date.now().toString(36)}@decoricks.test`

    const created = await founder.ctx.post('/api/users', {
      data: { email, name: 'SEC Revoke Probe', role: 'partner_ali', password: 'ProbePass2026' },
      headers: { [CSRF_HEADER]: founder.csrf },
    })
    expect(created.status()).toBe(201)
    const id = ((await created.json()).data as { user: { _id: string } }).user._id

    // The new account signs in and holds a live session. Its very creation sets
    // `mustChangePassword`, so the strongest claim available here is that the
    // request is authenticated at all — anything other than 401 proves it.
    const member = await signIn(playwright, email, 'ProbePass2026')
    const before = await member.ctx.get('/api/tasks')
    expect(
      [200, 403],
      `live session → ${before.status()}: ${(await before.text()).slice(0, 160)}`
    ).toContain(before.status())

    const off = await founder.ctx.patch(`/api/users/${id}`, {
      data: { isActive: false },
      headers: { [CSRF_HEADER]: founder.csrf },
    })
    expect(off.status()).toBe(200)

    // The already-issued cookie must stop working on the next request, not
    // after its 7-day window: `sessionVersion` is bumped and sessions deleted.
    const after = await member.ctx.get('/api/tasks')
    expect(after.status(), 'a deactivated user kept a working session').toBe(401)

    await member.ctx.dispose()
    await founder.ctx.dispose()
  })
})
