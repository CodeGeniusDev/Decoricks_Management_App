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
 * before a single byte of `DesignGallery` renders, and a caller who is not the
 * Founder gets 404 — the same response as a route that does not exist, so the
 * page does not disclose that anything is hidden behind it.
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
