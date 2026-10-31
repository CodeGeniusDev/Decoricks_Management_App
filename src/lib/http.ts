import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { randomUUID } from 'node:crypto'
import { ZodError } from 'zod'
import {
  AuthenticationError,
  AuthorizationError,
  PasswordChangeRequiredError,
} from '@/lib/authorization'
import { CsrfError } from '@/lib/auth/session'
import { errorResponse } from '@/lib/api-response'
import { isTransientMongoError } from '@/lib/mongo-errors'
import { scrubCredentials } from '@/lib/credential-query'
import { labelFromArgs, withTrace } from '@/lib/timing'

/**
 * Shared route plumbing.
 *
 * Every mutating route funnels failures through `handleRouteError` so that a
 * missing session always becomes 401 and a missing grant always becomes 403 —
 * the statuses SPEC §10.2.2 Test 4/5/6 assert. Previously each route hand-rolled
 * this, which is how authorization gaps would have crept in.
 */

export interface RequestMeta {
  ipAddress: string | undefined
  userAgent: string | undefined
}

/**
 * A domain error carrying the HTTP status/code it should surface as.
 *
 * Routes that do not throw an `AuthenticationError`/`AuthorizationError`/
 * `ZodError` still need an exact status (for example a 409 when a withdrawal is
 * locked, or a 404 for an unknown account). `handleRouteError` maps this class
 * before falling through to a generic 500, so the response body matches the
 * app's standard error envelope instead of leaking an internal message.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly code: string = 'BAD_REQUEST',
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Client IP + user agent for audit entries (SPEC §3.1.19). */
export const getRequestMeta = async (): Promise<RequestMeta> => {
  const h = await headers()
  const forwarded = h.get('x-forwarded-for')
  const ipAddress = forwarded?.split(',')[0]?.trim() || h.get('x-real-ip') || undefined
  return { ipAddress, userAgent: h.get('user-agent') ?? undefined }
}

/**
 * Did the CLIENT give up on this request before the handler finished?
 *
 * Observed in the Phase 5 production-build Playwright run as
 * `[api-error <id>] Error: aborted`, thrown while a tab was being taken offline
 * mid-flight (`phase7-chat.spec.ts › going offline …`). In production the same
 * shape appears whenever a user closes a tab or a proxy drops a slow connection.
 * That is a normal event, not a server fault, and logging it in the same
 * `[api-error]` format makes the 5xx signal an operator watches lie — the exact
 * misleading-status problem Phase 5 §6 asks to remove.
 *
 * The response is unchanged (the client is gone; whatever we answer is
 * discarded), and the event is still logged with its name and message, so a real
 * abort-like failure is never swallowed — it is only labelled as what it is.
 */
const isClientDisconnect = (error: unknown): boolean => {
  const candidate = error as { name?: string; message?: string; code?: string } | null
  if (!candidate) return false
  return (
    candidate.name === 'AbortError' ||
    candidate.message === 'aborted' ||
    candidate.code === 'ERR_ABORTED' ||
    candidate.code === 'ERR_STREAM_PREMATURE_CLOSE'
  )
}

/**
 * Server-side diagnostics without leaking internals to the client.
 *
 * The stack/message stay in the server log where an operator can see them; the
 * client only ever sees a generic message plus a trace id it can quote.
 *
 * Both lines are passed through `scrubCredentials` before printing. This function
 * reads no request body and no header, so it cannot pick up a credential itself —
 * but an error MESSAGE can: a driver echoing the query it failed on, or a
 * `fetch` rejection quoting the URL, lands here verbatim, and the code that
 * produced that string was never written to know which part of it is a secret.
 */
const logServerError = (error: unknown, traceId: string): void => {
  const name = error instanceof Error ? error.name : typeof error
  const message = scrubCredentials(error instanceof Error ? error.message : String(error))
  const stack = error instanceof Error ? error.stack : undefined
  if (isClientDisconnect(error)) {
    console.warn(`[api-abort] ${name}: ${message}`)
    return
  }
  console.error(`[api-error ${traceId}] ${name}: ${message}`)
  if (stack && process.env.NODE_ENV !== 'production') {
    console.error(scrubCredentials(stack))
  }
}

/**
 * The status a thrown error will be answered with, or `undefined` when the
 * error is unexpected and `handleRouteError` will mint a 500/503 for it.
 *
 * Kept next to `handleRouteError` rather than beside the route handlers so the
 * two can never disagree about what a given error means.
 */
const expectedRejection = (error: unknown): { status: number; code: string } | undefined => {
  if (error instanceof AuthenticationError) return { status: 401, code: 'UNAUTHENTICATED' }
  if (error instanceof PasswordChangeRequiredError) {
    return { status: 403, code: 'PASSWORD_CHANGE_REQUIRED' }
  }
  if (error instanceof AuthorizationError) return { status: 403, code: 'FORBIDDEN' }
  if (error instanceof CsrfError) return { status: 403, code: 'INVALID_CSRF' }
  if (error instanceof ZodError) return { status: 400, code: 'VALIDATION_ERROR' }
  if (error instanceof HttpError) return { status: error.status, code: error.code }
  // A duplicate key on the idempotency/concurrency guards is an expected race,
  // answered 409 by the handler that caught it — not a server fault.
  if ((error as { code?: number } | null)?.code === 11000) return { status: 409, code: 'CONFLICT' }
  return undefined
}

/**
 * Records a refused request in the server log: one line, no stack.
 *
 * Route handlers used to open every catch with `console.error('<route> failed:',
 * error)`, which logged a full stack for refusals that are the correct answer —
 * an expired session (401), a Partner poking a Founder-only route (403), a form
 * submitted with an invalid field (400). On a production server that drowns out
 * the 5xx entries an operator actually needs, and Phase 5 §6 asks for the
 * recurring-401/403/404/409 signal specifically.
 *
 * So: expected rejections get a compact, greppable line. Anything unexpected
 * logs nothing here, because `handleRouteError` follows immediately and emits the
 * full record with the trace id the client was given — logging it twice would
 * just double the noise.
 */
export const logRouteFailure = (context: string, error: unknown): void => {
  const rejection = expectedRejection(error)
  // No expected rejection, or an `HttpError` that carries a 5xx: in both cases
  // this is a server fault and `handleRouteError` owns the record.
  if (!rejection || rejection.status >= 500) return
  const message = scrubCredentials(error instanceof Error ? error.message : String(error))
  // `context` is caller-built text (`POST /api/tasks`) and is scrubbed like any
  // other input: a route that ever interpolates `request.url` into it should not
  // turn the refusal line into the one log line that carries a query string.
  console.warn(
    `[api-refusal] ${scrubCredentials(context)} ${rejection.status} ${rejection.code}: ${message}`
  )
}

/**
 * Maps thrown errors to HTTP responses.
 *
 * `AuthenticationError` → 401, `AuthorizationError`/`CsrfError` → 403,
 * `ZodError` → 400, and a transient database outage → 503 (retryable) rather
 * than a misleading 500. Unexpected errors are logged in full but answered with
 * a generic message, so a raw MongoDB error / connection detail / stack can
 * never reach the client.
 */
export const handleRouteError = (error: unknown): NextResponse => {
  if (error instanceof AuthenticationError) {
    return errorResponse(error.message, 401, 'UNAUTHENTICATED')
  }
  if (error instanceof PasswordChangeRequiredError) {
    return errorResponse(error.message, 403, 'PASSWORD_CHANGE_REQUIRED')
  }
  if (error instanceof AuthorizationError) {
    return errorResponse(error.message, 403, 'FORBIDDEN', {
      module: error.module,
      action: error.action,
    })
  }
  if (error instanceof CsrfError) {
    return errorResponse(error.message, 403, 'INVALID_CSRF')
  }
  if (error instanceof ZodError) {
    return errorResponse('Validation failed', 400, 'VALIDATION_ERROR', {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
  }
  if (error instanceof HttpError) {
    return errorResponse(error.message, error.status, error.code, error.details)
  }

  const traceId = randomUUID()
  logServerError(error, traceId)

  if (
    isTransientMongoError(error) ||
    (error instanceof Error && error.message === 'Database connection failed')
  ) {
    return errorResponse(
      'The database is temporarily unavailable. Please try again.',
      503,
      'SERVICE_UNAVAILABLE',
      { traceId }
    )
  }

  return errorResponse('Something went wrong. Please try again.', 500, 'INTERNAL_ERROR', {
    traceId,
  })
}

/**
 * Wraps a route handler so authorization errors become the right status without
 * every handler repeating itself.
 *
 * Typed against `Response` rather than `NextResponse` because several Phase 1
 * handlers are inferred as returning the wider `Response` type.
 *
 * Note this is *not* where CSRF is enforced: that happens inside
 * `getAuthenticatedUser` so it cannot be forgotten by a route that does not use
 * this wrapper.
 *
 * It is also where a `API_TIMING=1` trace opens — one per request, labelled with
 * the method and pathname — because this is the only seam every protected handler
 * passes through. With the flag off `withTrace` is a bare call.
 */
export const withAuth =
  <T extends unknown[]>(handler: (...args: T) => Promise<Response>) =>
  async (...args: T): Promise<Response> => {
    try {
      return await withTrace(labelFromArgs(args), () => handler(...args))
    } catch (error) {
      return handleRouteError(error)
    }
  }
