import type { Metadata } from 'next'
import { BrandMark } from '@/components/layout/BrandMark'
import { NotFoundPanel } from '@/components/layout/NotFoundPanel'

/**
 * Root 404 — the page for a URL that matched no route at all (`/financ`, an old
 * bookmark, a typo).
 *
 * This boundary gets the ROOT layout only. The application chrome lives in
 * `(app)/layout.tsx` and the auth chrome in `(auth)/layout.tsx`, and neither is an
 * ancestor of an unmatched route, so there is no sidebar, no header, no page
 * gutter and no background colour here unless this file supplies them. That is why
 * it draws the same bare frame the login screen uses (`min-h-dvh` + `bg-surface-app`
 * + a brand row): an anonymous visitor who mistypes an address sees the app's
 * identity and one way back in, not a white void.
 *
 * `min-h-dvh`, not `min-h-screen`: `100vh` is the layout viewport, which on a phone
 * is taller than what is actually visible while the URL bar is on screen — the
 * bottom of the card would sit under it. `dvh` tracks the visible box, and it is
 * the same unit `(auth)/layout.tsx` already uses.
 *
 * No `'use client'`: it must render from the server with no session, no bundle and
 * no JavaScript. The `Button`/`Link` it renders are anchors in the HTML either way.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col bg-surface-app">
      <header className="flex items-center gap-2 px-5 py-4">
        <BrandMark size={26} />
        <span className="text-sm font-semibold tracking-tight text-ink">Decoricks</span>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <NotFoundPanel />
      </main>
    </div>
  )
}

export const metadata: Metadata = {
  title: 'Page not found · Decoricks',
}
