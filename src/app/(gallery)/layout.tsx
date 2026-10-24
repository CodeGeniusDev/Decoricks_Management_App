import { AppShell } from '@/components/layout/AppShell'
import { OfflineProvider } from '@/components/offline/OfflineProvider'

/**
 * Route group for the Founder-only component gallery at `/design`.
 *
 * It is deliberately kept *out* of the `(app)` group. `(app)`'s layout wraps
 * every signed-in screen in `RequireAuth`, a client component that renders its
 * own children. That wrapper forces the shell to flush before the page's
 * `notFound()` digest can surface, so a non-Founder navigating to `/design` got a
 * successful HTTP 200 whose body happened to be the not-found UI — a 200 where a
 * 404 was required. This layout supplies the same chrome the gallery needs
 * (`AppShell` for the sidebar/header context, `OfflineProvider` for the queue)
 * but no client auth gate, so the server `notFound()` in `design/page.tsx`
 * reaches the top-level render catch and answers a real 404.
 *
 * Security is unchanged: the page still calls the server `requireAuth()`, which
 * throws for an unauthenticated or mid-password-change session (caught →
 * `notFound()`), and `middleware.ts` still 307s an anonymous request to `/login`.
 * Dropping `RequireAuth` here removes a redirect convenience, never an
 * authorization check.
 */
export default function GalleryLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <OfflineProvider>{children}</OfflineProvider>
    </AppShell>
  )
}
