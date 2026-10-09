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
const PUBLIC_PATHS = ['/login', '/change-password', '/api/auth/login', '/api/health']

/**
 * Methods that cannot change state. `SameSite=Lax` already blocks cross-site
 * requests for the rest, but the CSRF check is enforced independently so the
 * protection does not rest on one browser default.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const isPublic = (pathname: string): boolean =>
  PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))

/** API routes answer with JSON status codes, never a redirect. */
const wantsJson = (request: NextRequest): boolean =>
  request.nextUrl.pathname.startsWith('/api/')

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (isPublic(pathname)) return NextResponse.next()

  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value)

  if (hasSessionCookie) return withCsrfRequirement(request)

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
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
}