'use client'

import React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isActiveRoute, navItems } from './nav-config'
import { useAuth } from '@/components/auth/AuthProvider'
import { canAccessRoute } from '@/lib/permissions-client'
import { useShellLayout } from './ShellLayoutContext'
import { Tooltip } from '@/components/ui/Tooltip'
import { IconChevronLeft, IconChevronRight } from '@/components/ui/icons'
import { BrandMark } from './BrandMark'

/**
 * Sidebar — persistent desktop navigation rail.
 *
 * Fixes the collapse bugs:
 *  - Nav items now actually carry icons. The item type had an optional `icon`
 *    that was never populated, so collapsing simply rendered nothing.
 *  - Width animates via a single CSS `width` transition driven by a class
 *    change. No GSAP width animation, so the label clipping and the icon
 *    positions can never fight each other.
 *  - The collapse toggle lives in its own row at the foot of the rail, in BOTH
 *    states. It used to sit at the right end of the brand row, which cannot
 *    work when collapsed: a 64px rail minus `px-3` and a 32px button leaves an
 *    8px column for a 24px brand mark — the mark either overlapped the toggle
 *    by 17px or (as an <img>) was squashed by Preflight's `max-width: 100%`.
 *    One fixed position also means the button never teleports mid-transition.
 *  - The brand row is therefore purely brand: mark + wordmark expanded, the
 *    mark centred alone when collapsed. Nothing shares the 64px with it.
 *  - Icons live in a fixed 20px slot and are never unmounted. Labels fade out
 *    while the rail narrows, and the rail clips them, so there is no reflow.
 *  - The active state is a filled pill that spans the rail's content box, so it
 *    stays legible at 64px. It is full width because `Tooltip` wraps the trigger
 *    in a shrink-wrapping `inline-flex` span; without `w-full` on both, the
 *    collapsed pill was 20px wide and sat 10px left of the rail's centre.
 */
export const Sidebar = () => {
  const pathname = usePathname()
  const { isCollapsed, toggleCollapsed } = useShellLayout()
  const { user } = useAuth()

  /*
   * SPEC §4.2 rows for Settings and Users are Founder-only. Hiding the entry is
   * display convenience only — the routes themselves are gated server-side, so a
   * Partner typing /settings still gets a 403.
   */
  const visibleItems = user
    ? navItems.filter((item) =>
        canAccessRoute({ role: user.role, permissions: user.permissions }, item.href)
      )
    : navItems

  return (
    <aside
      aria-label="Main navigation"
      className={`fixed inset-y-0 left-0 z-40 hidden shrink-0 border-r border-line-subtle bg-surface-raised lg:flex lg:flex-col ${
        isCollapsed ? 'w-sidebar-collapsed' : 'w-sidebar'
      } transition-[width] duration-240 ease-standard`}
    >
      {/* Brand row — brand only. Collapsed it is the mark, centred on the
          rail's own axis; the toggle is not here (see the file header). */}
      <div
        className={`flex h-header shrink-0 items-center border-b border-line-subtle ${
          isCollapsed ? 'justify-center px-2' : 'px-4'
        }`}
      >
        <Link
          href="/"
          className={`flex min-w-0 items-center rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-decoricks-brown ${
            isCollapsed ? 'shrink-0' : 'w-full gap-2.5'
          }`}
          aria-label="Decoricks Management — dashboard"
        >
          <BrandMark size={isCollapsed ? 24 : 26} />
          <span
            className={`truncate text-md font-semibold tracking-tight text-decoricks-dark transition-opacity duration-150 ${
              isCollapsed ? 'pointer-events-none w-0 opacity-0' : 'opacity-100'
            }`}
            aria-hidden={isCollapsed}
          >
            Decoricks
          </span>
        </Link>
      </div>

      {/*
       * Nav region.
       *
       * This was `flex-1 overflow-hidden`, which silently clipped the list: the
       * rail is `fixed inset-y-0`, so at 15 items × 40px plus the 60px brand row
       * and padding the contents need ~714px of height and everything below the
       * fold was unreachable on a 1366×768 laptop — no scrollbar, and keyboard
       * focus moved into invisible items. `overflow-y-auto` makes the navigation
       * area scroll inside the rail instead.
       *
       * `overflow-x-hidden` is deliberate: labels are faded to `w-0` when
       * collapsing, and during the width transition a long label can still push
       * past the rail edge — the vertical scroller must not grow a horizontal
       * scrollbar because of that. `overscroll-contain` (see globals.css
       * `.sidebar-nav`) stops the nav from hijacking the page once it hits its
       * own end. The tooltip is portalled out of the rail, so it is never
       * clipped by this scroller.
       */}
      <nav className="sidebar-nav min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3">
        <ul className="flex flex-col gap-0.5">
          {visibleItems.map((item) => {
            const isActive = isActiveRoute(pathname, item.href)
            return (
              <li key={item.href}>
                <Tooltip
                  content={isCollapsed ? item.name : ''}
                  position="right"
                  disabled={!isCollapsed}
                  triggerClassName="w-full"
                >
                  <Link
                    href={item.href}
                    /*
                     * Prefetching is deliberately left at Next's default ("auto"),
                     * and that is a measured decision, not an untouched one. Turning
                     * it off for the eleven sidebar links (`prefetch={false}`, then
                     * re-run `scripts/nav-probe.ts`) changed nothing that matters:
                     * 42 API requests and 16 navigations either way, median
                     * time-to-content 28ms with and 30ms without. The reason is in
                     * `.next/prerender-manifest.json` — every sidebar destination is
                     * a static route, so its `?_rsc` prefetch is a file read that
                     * never opens a MongoDB connection and can therefore not be what
                     * makes an `/api/` call slow. Keeping it on means the shell is
                     * already in the router cache when a click happens.
                     */
                    aria-current={isActive ? 'page' : undefined}
                    /*
                     * When collapsed the visible label is clipped and hidden from
                     * assistive tech, and the tooltip is decorative — so without
                     * this the link would have no accessible name at all. Setting
                     * it unconditionally keeps one stable name in both states.
                     */
                    aria-label={item.name}
                    className={`group relative flex h-10 w-full items-center rounded-lg transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-decoricks-brown ${
                      isCollapsed ? 'justify-center px-0' : 'gap-3 px-2.5'
                    } ${
                      isActive
                        ? 'bg-decoricks-brown text-white'
                        : 'text-ink-secondary hover:bg-surface-sunken hover:text-ink'
                    }`}
                  >
                    {/* Fixed icon slot: never unmounted, so the rail cannot
                        shift horizontally while collapsing. */}
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                      {item.icon}
                    </span>
                    <span
                      className={`truncate text-sm font-medium transition-opacity duration-150 ${
                        isCollapsed ? 'pointer-events-none w-0 opacity-0' : 'opacity-100'
                      }`}
                      aria-hidden={isCollapsed}
                    >
                      {item.name}
                    </span>
                  </Link>
                </Tooltip>
              </li>
            )
          })}
        </ul>
      </nav>

      {/*
       * Collapse toggle — its own row, so it never competes with the brand mark
       * for the rail's 64px. Same place in both states on purpose: a control
       * that moved between the header and the foot would teleport during the
       * 240ms width transition, which is the shifting-chrome behaviour this
       * component was rewritten to remove.
       */}
      <div className="flex h-12 shrink-0 items-center justify-center border-t border-line-subtle">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-decoricks-brown"
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? <IconChevronRight size={16} /> : <IconChevronLeft size={16} />}
        </button>
      </div>
    </aside>
  )
}
