import Link from 'next/link'
import { Button } from '@/components/ui/Button'

/**
 * NotFoundPanel — the 404 message itself.
 *
 * This app has TWO 404 boundaries and they cannot be merged into one file.
 * `app/not-found.tsx` answers a URL that matched no route at all, plus the
 * `notFound()` calls made outside the shell (the `/design` gallery), and gets the
 * ROOT layout only — no sidebar, no header, no page gutter. `app/(app)/not-found.tsx`
 * answers the `notFound()` calls made by a page inside the shell, and is already
 * surrounded by the sidebar, the header and the page gutter. Two frames, then. The
 * message is deliberately not duplicated, because two copies of the same sentence
 * is how the two ends up looking like two different products.
 *
 * Server-rendered on purpose. A missing route is exactly the situation where the
 * client bundle may not be there to hydrate, so both exits are ordinary anchors —
 * `Button href=` renders a `next/link`, and the section list renders `Link`
 * directly — that navigate with no JavaScript at all. There is no
 * `history.back()` button: a control that is inert without JS is worse than no
 * control, and it is also the one action a user can already take with the browser.
 *
 * The card language is the login screen's — `rounded-xl border border-line
 * bg-surface-raised shadow-sm` with `p-6 sm:p-8` — but wider, because this one
 * carries a sentence and a list of links instead of a form. An unfamiliar URL
 * should still read as Decoricks.
 *
 * The `<h1>` is the message's own heading. On the shell surface the Header already
 * shows the route title as a first `<h1>` (measured: every signed-in page in this
 * app carries two `<h1>` — Header's `titleForPath` plus PageHeader's title), so
 * this is the second one, the same as any other page's title. Making it an `<h2>`
 * would be more correct in isolation and would match no other page in the app.
 */

/**
 * A short set of real top-level sections, enough to get unstuck without turning
 * the page into a second sidebar. These are checked against `navItems` by
 * `not-found-page.test.ts` rather than derived from it at runtime: a 404 page must
 * never be able to throw.
 */
const QUICK_LINKS: { name: string; href: string }[] = [
  { name: 'Finance', href: '/finance' },
  { name: 'Inventory', href: '/inventory' },
  { name: 'Sales', href: '/sales' },
  { name: 'Tasks', href: '/tasks' },
  { name: 'Suppliers', href: '/suppliers' },
  { name: 'Settings', href: '/settings' },
]

export const NotFoundPanel = () => (
  <section className="w-full max-w-lg rounded-xl border border-line bg-surface-raised p-6 shadow-sm sm:p-8">
    <p className="text-xs font-semibold uppercase tracking-wide text-decoricks-brown">404</p>
    <h1 className="mt-2 text-xl font-semibold tracking-tight text-ink">Page not found</h1>
    <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">
      That address does not match any page in Decoricks. It may have been renamed, or the link that
      brought you here may be out of date.
    </p>

    <div className="mt-6">
      <Button variant="primary" href="/" className="w-full justify-center sm:w-auto">
        Go to dashboard
      </Button>
    </div>

    <nav aria-label="App sections" className="mt-6 border-t border-line-subtle pt-4">
      <p className="text-xs text-ink-muted">Or open a section directly:</p>
      {/*
        44px minimum height on every link, the same rule the rest of the app
        follows below the `md` breakpoint, so this is tappable with a thumb and not
        a row of fine text. `flex-wrap` plus the card's own `max-w-lg` is what keeps
        it inside a 320px screen: nothing here can set a minimum width for the page.
      */}
      <ul className="mt-1 flex flex-wrap gap-x-1">
        {QUICK_LINKS.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium text-decoricks-brown transition-colors hover:bg-decoricks-brown/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown"
            >
              {link.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  </section>
)
