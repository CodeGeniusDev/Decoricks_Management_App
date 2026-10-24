import { notFound } from 'next/navigation'
import { requireAuth } from '@/lib/authorization'
import { isFounderRole } from '@/lib/roles'
import DesignGallery from './DesignGallery'

/**
 * `/design` — the component gallery, gated to the Founder.
 *
 * The page renders invented sample data (button variants, a table of imaginary
 * customers). It was already absent from `nav-config.tsx`, so no menu pointed at
 * it — but the route still answered any signed-in browser that typed the URL,
 * which is the difference between "not advertised" and "not reachable".
 *
 * The gate is a **server component** on purpose. `permissions-client.ts` says it
 * in its own header: a client check decides what to *show*, never what to
 * *allow*, and hiding a link is not a security control. A `'use client'` guard
 * here would still send the gallery to the browser. So the decision is made
 * before a single byte of `DesignGallery` renders: a caller who is not the
 * Founder reaches `notFound()`, and what that caller gets back contains no
 * gallery heading, no sample rows and no reference to the `/design` route's own
 * JS chunk — measured against the production build, the Founder's document names
 * `static/chunks/app/(gallery)/design/page-<hash>.js` and a Partner's does not.
 *
 * A non-Founder gets a genuine **404 status**, not a 200 that merely shows the
 * not-found UI. That is exactly why this page lives in the `(gallery)` route
 * group instead of `(app)`: `notFound()` throws a `NEXT_HTTP_ERROR_FALLBACK;404`
 * digest, and `(app)`'s layout wraps its children in the client `RequireAuth`
 * component, which flushes the shell before the digest can bubble to the
 * top-level render catch in `next/dist/server/app-render/app-render.js` — the
 * caller then received a 200. `(gallery)/layout.tsx` supplies the same chrome
 * without that client wrapper, so the digest reaches the catch and the status is
 * 404. `layout.spec.ts` asserts the status, the absence of the gallery's markup
 * and code, and the anonymous redirect.
 *
 * `force-dynamic` because the answer depends on the session cookie; it must
 * never be cached or prerendered.
 */
export const dynamic = 'force-dynamic'

export default async function DesignPage() {
  // Any failure to resolve a caller is treated the same as "not the Founder":
  // an unauthenticated or mid-password-change session has no business seeing it,
  // and the gallery is not a place to surface an authentication error page.
  const role = await requireAuth()
    .then((auth) => auth.user.role)
    .catch(() => null)

  if (!role || !isFounderRole(role)) notFound()

  return <DesignGallery />
}
