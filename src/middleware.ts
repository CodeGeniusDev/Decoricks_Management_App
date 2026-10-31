import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { findCredentialKeys, stripCredentialParams } from '@/lib/credential-query'

/**
 * Edge-side gate. This is a *usability* redirect only — it keeps an anonymous
 * visitor from rendering the shell before the API rejects them.
 *
 * It is deliberately not the security boundary: middleware runs on the edge
 * where the app cannot reach MongoDB, so it only checks for the presence of the
 * session cookie. Real enforcement (role + module/action grants) lives in
 * `src/lib/authorization.ts` and runs on every API route and server action, per
 * SPEC §4.3.
 */

const SESSION_COOKIE = 'decoricks_session'
const CSRF_REQUIRED_HEADER = 'x-csrf-required'

/** Public paths — the login/change-password screens, login API, health probe. */
const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/health']
/** Change-password screen/API require a session but allow forced-change users. */
const SESSION_PROTECTED_PUBLIC = ['/change-password', '/api/auth/change-password']

/**
 * Machine-called routes that authenticate with a shared secret header instead of
 * a session (currently only `GET /api/cron/notifications`, which an external
 * cron service calls on a timer). They must reach the handler with no cookie —
 * a cron service has none — so the edge gate cannot be their protection and the
 * route enforces its own secret, rate limiting and 404-when-unconfigured
 * behaviour. Listed EXACTLY, never by prefix: adding one here is a deliberate
 * decision about one URL, because everything else on `/api/` keeps requiring a
 * session below.
 *
 * These paths also skip `withCsrfRequirement`, which is correct rather than a
 * gap: CSRF defence exists to stop another site riding a victim's session
 * cookie, and there is no cookie and no session code in this request path. A
 * double-submit token would be unobtainable for the very caller that is allowed
 * in, and the method it uses is a safe one anyway.
 */
const SECRET_AUTHENTICATED_PATHS = new Set(['/api/cron/notifications'])

/**
 * Methods that cannot change state. `SameSite=Lax` already blocks cross-site
 * requests for the rest, but the CSRF check is enforced independently so the
 * protection does not rest on one browser default.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const isPublic = (pathname: string): boolean =>
  PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))

const isSessionProtectedPublic = (pathname: string): boolean =>
  SESSION_PROTECTED_PUBLIC.some((path) => pathname === path || pathname.startsWith(`${path}/`))

/** API routes answer with JSON status codes, never a redirect. */
const wantsJson = (request: NextRequest): boolean => request.nextUrl.pathname.startsWith('/api/')

/**
 * Screens whose own URL is the correct place to land after a credential is
 * stripped from it. `/login?password=…&next=%2Ftasks` should come back to
 * `/login?next=%2Ftasks` — the query belongs to that page, and its `?next=` is
 * what preserves where the visitor was headed. Every other path goes to the
 * sign-in screen instead, carrying the clean pathname only.
 */
const CREDENTIAL_PAGES = new Set(['/login', '/change-password'])

/**
 * A credential arrived in the query string. Refuse it.
 *
 * The app should never generate such a URL — see `method="post"` on the login
 * form — but URLs survive: browser history, a pasted bookmark, a shared link, an
 * old tab reopened while the Render instance was asleep. Whichever way it comes
 * back, the answer is the same three properties:
 *
 *   - the value is never echoed, in a header, a body or a log line;
 *   - the value is never forwarded to another URL, so the redirect cannot
 *     reproduce the leak one hop later;
 *   - the request is not served as though the credential were usable. Nothing
 *     here logs in, changes a password, or reaches a handler that might.
 *
 * `303` rather than `302` for a state-changing method, because it instructs the
 * browser to follow with a GET: a POST that carried a tainted query string cannot
 * be replayed against the clean URL.
 */
function refuseCredentialsInUrl(request: NextRequest, keys: string[]): NextResponse {
  const { pathname, searchParams } = request.nextUrl

  // Key names only, never the URL. A guard that logs what it caught would be the
  // leak it exists to close.
  console.warn(`[credential-url] refused ${request.method} ${pathname} keys=${keys.join(',')}`)

  if (wantsJson(request)) {
    return NextResponse.json(
      {
        success: false,
        error: {
          message: 'Credentials cannot be sent in the URL. Sign in through the form.',
          code: 'CREDENTIALS_IN_QUERY',
        },
        timestamp: new Date().toISOString(),
      },
      { status: 400 }
    )
  }

  const status = SAFE_METHODS.has(request.method) ? 302 : 303

  if (CREDENTIAL_PAGES.has(pathname)) {
    const target = new URL(pathname, request.url)
    target.search = stripCredentialParams(searchParams).params.toString()
    return NextResponse.redirect(target, status)
  }

  const loginUrl = new URL('/login', request.url)
  // The pathname is safe to carry forward; the query string it arrived with is
  // exactly what must not be carried anywhere.
  if (pathname !== '/') loginUrl.searchParams.set('next', pathname)
  return NextResponse.redirect(loginUrl, status)
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  /*
   * First, before the public paths and before any session logic: a URL that names
   * a credential is answered here and never reaches a handler. It has to be above
   * `isPublic`, because `/login` is public — the leaked URL is the one this guard
   * exists to catch, and it is exactly the path the early return below would wave
   * straight through.
   */
  const credentialKeys = findCredentialKeys(request.nextUrl.searchParams)
  if (credentialKeys.length > 0) return refuseCredentialsInUrl(request, credentialKeys)

  if (isPublic(pathname)) return NextResponse.next()

  // Header-authenticated machine routes: no session exists to check, so the edge
  // gate steps aside and the route's own secret check answers. Exact match only
  // (see SECRET_AUTHENTICATED_PATHS), so nothing under /api/cron/ is public by
  // accident and every other path below still needs a session cookie.
  if (SECRET_AUTHENTICATED_PATHS.has(pathname)) return NextResponse.next()

  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value)

  if (hasSessionCookie) {
    if (isSessionProtectedPublic(pathname)) return NextResponse.next()
    return withCsrfRequirement(request)
  }

  if (isSessionProtectedPublic(pathname)) {
    if (wantsJson(request)) {
      return NextResponse.json(
        {
          success: false,
          error: { message: 'Authentication required', code: 'UNAUTHENTICATED' },
          timestamp: new Date().toISOString(),
        },
        { status: 401 }
      )
    }
    const loginUrl = new URL('/login', request.url)
    if (pathname !== '/') loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  if (wantsJson(request)) {
    return NextResponse.json(
      {
        success: false,
        error: { message: 'Authentication required', code: 'UNAUTHENTICATED' },
        timestamp: new Date().toISOString(),
      },
      { status: 401 }
    )
  }

  const loginUrl = new URL('/login', request.url)
  // Preserve the destination so login can bounce the user back to where they
  // were headed instead of always landing on the dashboard.
  if (pathname !== '/') loginUrl.searchParams.set('next', pathname)
  return NextResponse.redirect(loginUrl)
}

/**
 * Marks state-changing API requests so `getAuthenticatedUser` knows to run the
 * double-submit CSRF check.
 *
 * This is the only place in the request path where the HTTP method is visible —
 * `headers()` inside a route handler does not reliably expose it. Stamping a
 * header keeps the check tied to authentication itself, so a new route gets
 * CSRF protection by existing rather than by remembering to call something.
 */
function withCsrfRequirement(request: NextRequest): NextResponse {
  if (SAFE_METHODS.has(request.method) || !wantsJson(request)) {
    return NextResponse.next()
  }

  const headers = new Headers(request.headers)
  headers.set(CSRF_REQUIRED_HEADER, '1')
  return NextResponse.next({ request: { headers } })
}

export const config = {
  // Everything except Next internals and static assets.
  //
  // The PWA assets are served verbatim from `public/` and are fetched by the
  // browser (and the service-worker machinery) before any session exists. If
  // middleware gated them, an anonymous `GET /manifest.webmanifest` would be
  // redirected to the `/login` HTML and parsed as JSON — the browser's
  // "Manifest: Line 1, column 1, Syntax error". `sw.js` and `offline.html`
  // must likewise be reachable without a session. This is a usability gate, not
  // the security boundary (authorization stays in `src/lib/authorization.ts`),
  // so letting unauthenticated *static files* through is safe.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|offline.html|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|webmanifest)$).*)',
  ],
}
