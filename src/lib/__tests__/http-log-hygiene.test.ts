/**
 * Phase 5 §6 — what the server log is allowed to say about a failed request.
 *
 * The brief asks for recurring 401/403/404/409/500 to be investigated from the
 * logs. That only works if the logs separate the three things that reach a route
 * `catch`:
 *
 *   - a refusal that is the CORRECT answer (expired session, missing grant,
 *     invalid form field) — one compact line, never a stack, because a stack for
 *     a 403 drowns out the 5xx an operator needs to see;
 *   - a server fault — the full record, with the trace id handed to the client;
 *   - a request the CLIENT abandoned — a normal event (tab closed, offline
 *     toggle, proxy timeout) that must not be counted as a server fault at all.
 *
 * The third is not hypothetical: a production-build Playwright run logged
 * `[api-error <id>] Error: aborted` while a chat spec took a tab offline
 * mid-flight, which would have shown up as a phantom 500 in Netlify's log
 * stream. And the first was the state of the codebase before `logRouteFailure`:
 * every route handler opened its catch with `console.error('<route> failed:',
 * error)`, stacks included.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AuthorizationError, AuthenticationError } from '@/lib/authorization'
import { HttpError, handleRouteError, logRouteFailure } from '@/lib/http'
import { labelFromArgs } from '@/lib/timing'

const messages = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls.map((call) => String(call[0]))

let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>

// `globalThis.console` is what the route code calls, so spying on it is what the
// assertions need — `vi.spyOn(console, …)` on the imported binding would not.
const spyOnConsole = (): void => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('route failure log hygiene', () => {
  it('records a refusal as one compact line with no stack', () => {
    spyOnConsole()
    logRouteFailure('POST /api/tasks', new AuthorizationError('tasks', 'create'))

    const warned = messages(warn)
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('[api-refusal] POST /api/tasks 403 FORBIDDEN')
    expect(error).not.toHaveBeenCalled()
  })

  it('logs an expired session the same way, because a 401 is also a correct answer', () => {
    spyOnConsole()
    logRouteFailure('GET /api/orders', new AuthenticationError())
    expect(messages(warn)).toEqual([
      expect.stringContaining('[api-refusal] GET /api/orders 401 UNAUTHENTICATED'),
    ])
    expect(error).not.toHaveBeenCalled()
  })

  it('stays silent for anything the route did not expect, leaving the record to handleRouteError', () => {
    spyOnConsole()
    logRouteFailure('GET /api/products', new Error('MongoServerSelectionError'))
    // A 4xx-styled `HttpError` that is really a 5xx is a server fault too.
    logRouteFailure('POST /api/finance', new HttpError('ledger write failed', 500, 'LEDGER_FAILED'))
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('answers an unexpected failure with a generic 500 and a trace id, and keeps the message server-side', async () => {
    spyOnConsole()
    const secret = 'E11000 duplicate key error collection: test.transactions'
    const res = handleRouteError(new Error(secret))
    expect(res.status).toBe(500)

    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error.message).not.toContain(secret)
    expect(JSON.stringify(body)).not.toContain('E11000')

    const traceId = body.error.details.traceId as string
    expect(traceId).toHaveLength(36)
    const logged = messages(error)
    expect(logged[0]).toContain(`[api-error ${traceId}]`)
    expect(logged.join('\n')).toContain(secret) // the operator sees it, the client does not
  })

  it('labels a client disconnect as a disconnect instead of an api-error', async () => {
    spyOnConsole()
    const aborted = new Error('aborted')
    const res = handleRouteError(aborted)

    expect(messages(warn)).toEqual([expect.stringContaining('[api-abort] Error: aborted')])
    // The whole point: nothing enters the 5xx log stream for a request nobody is
    // waiting for any more.
    expect(error).not.toHaveBeenCalled()
    // …and the response contract is untouched — no fake success is invented.
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('INTERNAL_ERROR')
  })

  it('treats an AbortError the same way, whatever names the aborting layer gives it', () => {
    spyOnConsole()
    handleRouteError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    handleRouteError(
      Object.assign(new Error('socket hang up'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })
    )
    expect(messages(warn)).toEqual([
      expect.stringContaining('[api-abort] AbortError:'),
      expect.stringContaining('[api-abort] Error:'),
    ])
    expect(error).not.toHaveBeenCalled()
  })

  it('keeps an expected 4xx refusal out of the abort branch', () => {
    spyOnConsole()
    // A 4xx `HttpError` is a refusal; it must never reach the abort branch.
    logRouteFailure(
      'PATCH /api/tasks/1',
      new HttpError('Task was updated elsewhere', 409, 'CONFLICT')
    )
    expect(messages(warn)).toEqual([
      expect.stringContaining('[api-refusal] PATCH /api/tasks/1 409'),
    ])
    expect(messages(warn)[0]).not.toContain('api-abort')
  })
})

/*
 * Everything above is about how MUCH a log line says. This is about what it is
 * allowed to contain.
 *
 * The app writes no request URL into a log itself — `labelFromArgs` keeps a route
 * label to `METHOD pathname`, and the audit trail stores no URL at all. The risk is
 * the text that arrives from somewhere else: a driver echoing the query it failed
 * on, a `fetch` rejection quoting the URL it was given, a stack frame carrying the
 * request line. None of those were written to know which part of their string is a
 * secret, so the loggers scrub rather than trust, and the assertions below are
 * written against the whole captured output rather than the field under test.
 */
describe('credentials cannot reach a log line', () => {
  const SECRET = 'Sup3r-Secret-Pa55w0rd'

  it('redacts a leaked URL inside an error message on the refusal line', () => {
    spyOnConsole()
    logRouteFailure(
      'POST /api/auth/login',
      new HttpError(`upstream rejected /api/auth/login?password=${SECRET}`, 400, 'BAD_GATEWAY')
    )
    const line = messages(warn).join('\n')
    expect(line).not.toContain(SECRET)
    expect(line).toContain('password=[redacted]')
    // Still a useful line: the label, status and code survive the redaction.
    expect(line).toContain('[api-refusal] POST /api/auth/login 400')
  })

  it('redacts a context string that interpolated a query string', () => {
    spyOnConsole()
    // The one call shape that could turn the refusal line into a leak: a route
    // building its context out of `request.url` instead of the pathname.
    logRouteFailure(
      `GET /login?email=a@b.pk&password=${SECRET}`,
      new AuthorizationError('tasks', 'read')
    )
    const line = messages(warn).join('\n')
    expect(line).not.toContain(SECRET)
    expect(line).toContain('password=[redacted]')
  })

  it('redacts message and stack on the server-fault record too', async () => {
    spyOnConsole()
    const faulty = Object.assign(new Error(`GET http://localhost/login?password=${SECRET} 401`), {
      stack: `Error: fetch failed\n  at signIn (file:///app/login?password=${SECRET})`,
    })
    const res = handleRouteError(faulty)
    expect(res.status).toBe(500)

    const everything = [...messages(warn), ...messages(error)].join('\n')
    expect(everything).not.toContain(SECRET)
    expect(everything).toContain('password=[redacted]')
    // The client still gets only a generic message plus a trace id.
    expect(JSON.stringify(await res.json())).not.toContain(SECRET)
  })

  it('labels a route by its pathname and drops the query string entirely', () => {
    const label = labelFromArgs([
      { url: `http://localhost/login?email=a@b.pk&password=${SECRET}`, method: 'post' },
    ])
    expect(label).toBe('POST /login')
    expect(label).not.toContain(SECRET)
    expect(label).not.toContain('email')

    // A clean URL loses its parameters for the same reason: a route label never
    // needs one, and "drop the whole thing" cannot miss a key invented later.
    expect(
      labelFromArgs([{ url: 'http://localhost/api/audit-log?page=2&limit=25', method: 'GET' }])
    ).toBe('GET /api/audit-log')
  })

  it('leaves an ordinary message with no secret-shaped key alone', () => {
    spyOnConsole()
    // Over-redaction would destroy the very diagnostic value this file protects.
    const message = 'E11000 duplicate key error collection: test.transactions index: idx_user'
    logRouteFailure('POST /api/tasks/1', new HttpError(message, 409, 'CONFLICT'))
    expect(messages(warn)[0]).toContain(message)
  })
})
