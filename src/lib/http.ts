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
  const ipAddress =
    forwarded?.split(',')[0]?.trim() || h.get('x-real-ip') || undefined
  return { ipAddress, userAgent: h.get('user-agent') ?? undefined }
}

/**
 * Server-side diagnostics without leaking internals to the client.
 *
 * The stack/message stay in the server log where an operator can see them; the
 * client only ever sees a generic message plus a trace id it can quote. Nothing
 * here reads request bodies or headers, so no credential can reach the log by
 * way of an error.
 */
const logServerError = (error: unknown, traceId: string): void => {
  const name = error instanceof Error ? error.name : typeof error
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  console.error(`[api-error ${traceId}] ${name}: ${message}`)
  if (stack && process.env.NODE_ENV !== 'production') {
    console.error(stack)
  }
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

  if (isTransientMongoError(error) || (error instanceof Error && error.message === 'Database connection failed')) {
    return errorResponse(
      'The database is temporarily unavailable. Please try again.',
      503,
      'SERVICE_UNAVAILABLE',
      { traceId }
    )
  }

  return errorResponse(
    'Something went wrong. Please try again.',
    500,
    'INTERNAL_ERROR',
    { traceId }
  )
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
 */
export const withAuth =
  <T extends unknown[]>(handler: (...args: T) => Promise<Response>) =>
  async (...args: T): Promise<Response> => {
    try {
      return await handler(...args)
    } catch (error) {
      return handleRouteError(error)
    }
  }
