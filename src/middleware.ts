import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

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

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

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
