import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { cookies, headers } from 'next/headers'
import { ObjectId } from 'mongodb'
import type { Db } from 'mongodb'
import { getEnv } from '@/lib/env'
import { getDatabase, withMongoRetry } from '@/lib/mongodb'
import {
  getSessionCollection,
  getUserCollection,
  type Session,
  type User,
} from '@/lib/models/User'

/**
 * Re-runs a read against a freshly acquired handle. A transient driver failure
 * can reset the connection pool, which invalidates the `db` a route already
 * holds — so the retry must resolve the database again rather than reuse it.
 */
const withDbRetry = <T>(operation: (db: Db) => Promise<T>): Promise<T> =>
  withMongoRetry(async () => operation(await getDatabase()))

export const SESSION_COOKIE = 'decoricks_session'
export const CSRF_COOKIE = 'decoricks_csrf'
export const CSRF_HEADER = 'x-csrf-token'
/** Set by middleware on state-changing requests; see `assertCsrf`. */
export const CSRF_REQUIRED_HEADER = 'x-csrf-required'

/**
 * Sent by background / auto-polling requests (see the dashboard poll). Such a
 * request is still authenticated, but it is not user activity, so it must not
 * extend the inactivity window — otherwise leaving a tab open would keep the
 * session alive indefinitely. Kept as a plain string literal on the client.
 */
export const SESSION_BACKGROUND_HEADER = 'x-session-background'

const SESSION_TTL_MS = () => getEnv().SESSION_TTL_MINUTES * 60 * 1000

/** Session tokens are stored hashed so a database leak cannot be replayed. */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

export const generateToken = (): string => randomBytes(32).toString('base64url')

/**
 * SPEC §10.1.1 Threat 2: the session identifier must be unguessable and must
 * not carry its own trust. A plaintext token in the cookie is fine *because*
 * only its SHA-256 digest is persisted, and every read re-hashes the cookie.
 */
export const createSession = async (
  db: Db,
  user: User,
  meta: { ipAddress?: string; userAgent?: string } = {}
): Promise<Session> => {
  const token = generateToken()
  const csrfToken = generateToken()
  const now = new Date()

  const session: Session = {
    tokenHash: hashToken(token),
    userId: user._id as ObjectId,
    sessionVersion: user.sessionVersion,
    role: user.role,
    csrfToken,
    createdAt: now,
    lastActivityAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS()),
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  }

  await getSessionCollection(db).insertOne(session)
  return { ...session, tokenHash: token } as Session & { tokenHash: string }
}

export interface SessionCookieOptions {
  secure: boolean
  maxAgeSeconds: number
}

export const sessionCookieOptions = (): SessionCookieOptions => ({
  // SPEC §10.1.1 Threat 2 requires Secure in production; plain http on localhost
  // would make the browser drop the cookie entirely during development.
  secure: getEnv().NODE_ENV === 'production',
  maxAgeSeconds: Math.floor(SESSION_TTL_MS() / 1000),
})

/** Shared cookie attributes: HttpOnly, SameSite=Lax (SPEC Threat 2). */
const baseCookie = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
} as const

export const writeSessionCookies = async (token: string, csrfToken: string) => {
  const opts = sessionCookieOptions()
  const store = await cookies()

  store.set(SESSION_COOKIE, token, { ...baseCookie, secure: opts.secure, maxAge: opts.maxAgeSeconds })
  // Readable by JS on purpose: the client echoes this exact value back in the
  // CSRF header. Stored signed so an attacker-injected cookie fails validation.
  store.set(CSRF_COOKIE, buildCsrfCookieValue(csrfToken), {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    secure: opts.secure,
    maxAge: opts.maxAgeSeconds,
  })
}

/**
 * The CSRF cookie is deliberately not HttpOnly, so double-submit needs a way to
 * prove the value came from our own origin rather than an attacker's page.
 * Signing it with SESSION_SECRET means an injected value will not validate.
 */
export const signCsrfToken = (csrfToken: string): string =>
  createHash('sha256')
    .update(`${csrfToken}:${getEnv().SESSION_SECRET}`)
    .digest('hex')

/**
 * Cookie payload: `<csrfToken>.<hmac>`. Keeping the token alongside the
 * signature lets `assertCsrf` bind the header to the server-side session, which
 * a plain signature check alone would not do.
 */
export const buildCsrfCookieValue = (csrfToken: string): string =>
  `${csrfToken}.${signCsrfToken(csrfToken)}`

export const isValidCsrfSignature = (csrfToken: string, signature: string): boolean => {
  const expected = signCsrfToken(csrfToken)
  const a = Buffer.from(expected)
  const b = Buffer.from(signature || '')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const constantTimeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a || '')
  const bufB = Buffer.from(b || '')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export class CsrfError extends Error {
  readonly status = 403
  constructor(message = 'Invalid or missing CSRF token') {
    super(message)
    this.name = 'CsrfError'
  }
}

/**
 * Double-submit CSRF check, SPEC §10.1.1 Threat 3.
 *
 * Runs from `getAuthenticatedUser`, which makes it the *only* gate every
 * authenticated route must pass — a handler cannot forget to call it, because
 * without a session it cannot resolve the caller in the first place.
 *
 * Three conditions, all required:
 *   1. the header value equals the cookie (defeats a foreign subdomain or a
 *      sibling app overwriting the cookie)
 *   2. the cookie's HMAC verifies under SESSION_SECRET (defeats an attacker who
 *      can set the cookie but not the secret)
 *   3. the embedded token equals the one in this session's server-side record
 *      (defeats replaying another user's CSRF token)
 *
 * `SameSite=Lax` already blocks cross-site form posts; this covers the cases
 * Lax does not, such as a same-site subdomain compromise.
 */
export const assertCsrf = async (
  db: Db,
  session: Session,
  requestHeaders: Headers | null
): Promise<void> => {
  if (!requestHeaders || requestHeaders.get(CSRF_REQUIRED_HEADER) !== '1') return

  const store = await cookies()
  const cookieValue = store.get(CSRF_COOKIE)?.value
  const headerValue = requestHeaders.get(CSRF_HEADER) ?? undefined

  if (!cookieValue || !headerValue) {
    throw new CsrfError('Missing CSRF token')
  }
  if (!constantTimeEqual(cookieValue, headerValue)) {
    throw new CsrfError('CSRF token mismatch')
  }

  const [csrfToken, signature] = cookieValue.split('.')
  if (!csrfToken || !signature || !isValidCsrfSignature(csrfToken, signature)) {
    throw new CsrfError('Invalid CSRF token signature')
  }
  if (!constantTimeEqual(csrfToken, session.csrfToken)) {
    throw new CsrfError('CSRF token does not belong to this session')
  }
}

export const clearSessionCookies = async () => {
  const store = await cookies()
  store.set(SESSION_COOKIE, '', { ...baseCookie, maxAge: 0 })
  store.set(CSRF_COOKIE, '', { httpOnly: false, sameSite: 'lax', path: '/', maxAge: 0 })
}

export interface AuthenticatedUser {
  user: User
  session: Session
}

/**
 * Resolves the caller from the session cookie.
 *
 * Returns `null` for every authentication failure mode — no cookie, unknown
 * session, expired session, deactivated user, or a session issued before the
 * user's `sessionVersion` was bumped (deactivation / password reset / role
 * change). Callers must not distinguish between them.
 *
 * A CSRF failure is different: the caller *is* authenticated, so it throws
 * `CsrfError` rather than returning null, and the route answers 403.
 *
 * Also slides the session forward, turning the fixed 7-day expiry into a 7-day
 * *inactivity* timeout: each qualifying request restarts the clock for both the
 * server-side record and the browser cookie. The touch is throttled so a burst
 * of requests does not turn into a burst of writes, and background polling is
 * ignored so an idle tab cannot keep itself alive.
 */
export const getAuthenticatedUser = async (
  db: Db,
  token?: string | null
): Promise<AuthenticatedUser | null> => {
  const store = await cookies()
  const resolved = token ?? store.get(SESSION_COOKIE)?.value
  if (!resolved) return null

  const session = await withDbRetry((database) =>
    getSessionCollection(database).findOne({ tokenHash: hashToken(resolved) })
  )
  if (!session) return null

  if (session.expiresAt.getTime() <= Date.now()) {
    await withDbRetry((database) => getSessionCollection(database).deleteOne({ _id: session._id }))
    return null
  }

  const user = await withDbRetry((database) =>
    getUserCollection(database).findOne({ _id: session.userId })
  )
  if (!user || !user.isActive) return null
  if (user.sessionVersion !== session.sessionVersion) return null

  let requestHeaders: Headers | null = null
  try {
    requestHeaders = await headers()
  } catch {
    // Outside a request scope (e.g. a seed script); CSRF is not applicable.
  }

  await assertCsrf(db, session, requestHeaders)

  const isBackground = requestHeaders?.get(SESSION_BACKGROUND_HEADER) === '1'
  if (!isBackground) {
    await maybeSlideSession(db, session, resolved)
  }

  return { user, session }
}

/** How often a request may push the session deadline before it actually does. */
const slideIntervalMs = () => getEnv().SESSION_SLIDE_INTERVAL_SECONDS * 1000

const maybeSlideSession = async (db: Db, session: Session, token: string): Promise<void> => {
  const now = Date.now()
  const sinceLastActivity = now - session.lastActivityAt.getTime()
  if (sinceLastActivity < slideIntervalMs()) return

  const expiresAt = new Date(now + SESSION_TTL_MS())

  await withDbRetry((database) =>
    getSessionCollection(database).updateOne(
      { _id: session._id },
      { $set: { lastActivityAt: new Date(now), expiresAt } }
    )
  )

  session.lastActivityAt = new Date(now)
  session.expiresAt = expiresAt

  // Re-issue the cookie with a fresh Max-Age so the browser-side expiry stays in
  // lockstep with the server-side one; otherwise the cookie would lapse while
  // the DB record is still valid. `cookies()` is only mutable inside a Route
  // Handler / Server Action — in a read-only render there is nothing to update,
  // and the next handler request will re-issue it, so a failure is harmless.
  try {
    await writeSessionCookies(token, session.csrfToken)
  } catch {
    // Not in a mutable cookie context; server-side expiry is already extended.
  }
}

export const revokeSession = async (db: Db, token: string): Promise<void> => {
  await getSessionCollection(db).deleteOne({ tokenHash: hashToken(token) })
}

/** Used when a Founder deactivates a user or resets their password. */
export const revokeAllSessionsForUser = async (db: Db, userId: ObjectId): Promise<void> => {
  await getSessionCollection(db).deleteMany({ userId })
}