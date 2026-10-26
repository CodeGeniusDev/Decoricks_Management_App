import { NotFoundPanel } from '@/components/layout/NotFoundPanel'

/**
 * In-shell 404 — reached when a page inside `(app)` calls `notFound()`: a record
 * that no longer exists, a board the user may not see.
 *
 * Measured against the production build, not assumed:
 * - `notFound()` from a page under `(app)` renders THIS file, wrapped by
 *   `(app)/layout.tsx` — the sidebar, the header and `main > div.page-max
 *   page-pad py-5 md:py-6` are all present.
 * - A URL that matches no route at all (`/financ`, `/finance/nope`) does NOT come
 *   here. Next looks up the tree from the root, so it renders `app/not-found.tsx`
 *   with the root layout only. A nested `not-found` can only be reached by an
 *   explicit `notFound()`.
 * - This answer carries HTTP 200, not 404: the shell is a client-component tree,
 *   so the page segment is streamed after the headers are already sent and the
 *   status cannot be changed. The root boundary is the one that returns a real
 *   404 (`/design` for a non-Founder measured at 404 because `(gallery)` has no
 *   client auth gate). Nothing here can fix that without un-gating the shell, and
 *   a signed-in user who follows a dead link cares about the message, not the
 *   status line.
 *
 * So: `AppShell` owns the frame. All this file may add is vertical breathing room
 * and the alignment — a background, its own padding scale or a second card would
 * sit inside an existing gutter and double it.
 *
 * The message itself is `NotFoundPanel`, shared with the root boundary so the two
 * 404s read as one product. Server-rendered, no `'use client'`: a 404 is exactly
 * the case where the client bundle may not be there to hydrate. Asserted by
 * `not-found-page.test.ts`.
 */
export default function NotFound() {
  return (
    <div className="flex justify-center py-6 sm:py-10">
      <NotFoundPanel />
    </div>
  )
}
