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
 *  - The brand row is a fixed three-column grid: mark / wordmark / toggle. The
 *    mark and toggle keep their size when collapsed, and only the wordmark
 *    fades, so nothing shifts or distorts.
 *  - Icons live in a fixed 20px slot and are never unmounted. Labels fade out
 *    while the rail narrows, and the rail clips them, so there is no reflow.
 *  - The active state is a filled pill that stays legible at 64px.
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
    ? navItems.filter((item) => canAccessRoute({ role: user.role }, item.href))
    : navItems

  return (
    <aside
      aria-label="Main navigation"
      className={`fixed inset-y-0 left-0 z-40 hidden shrink-0 border-r border-line-subtle bg-surface-raised lg:flex lg:flex-col ${
        isCollapsed ? 'w-sidebar-collapsed' : 'w-sidebar'
      } transition-[width] duration-240 ease-standard`}
    >
      {/* Brand row — mark and toggle are fixed size; only the wordmark fades. */}
      <div
        className={`grid h-header shrink-0 items-center border-b border-line-subtle ${
          isCollapsed ? 'grid-cols-[1fr_auto] px-3' : 'grid-cols-[auto_1fr_auto] gap-2.5 px-4'
        }`}
      >
        <Link
          href="/"
          className="flex min-w-0 items-center gap-2.5 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-decoricks-brown"
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

      {/* Nav. `overflow-hidden` on the rail is what clips labels mid-transition. */}
      <nav className="flex-1 overflow-hidden px-3 py-3">
        <ul className="flex flex-col gap-0.5">
          {visibleItems.map((item) => {
            const isActive = isActiveRoute(pathname, item.href)
            return (
              <li key={item.href}>
                <Tooltip content={isCollapsed ? item.name : ''} position="right" disabled={!isCollapsed}>
                  <Link
                    href={item.href}
                    aria-current={isActive ? 'page' : undefined}
                    /*
                     * When collapsed the visible label is clipped and hidden from
                     * assistive tech, and the tooltip is decorative — so without
                     * this the link would have no accessible name at all. Setting
                     * it unconditionally keeps one stable name in both states.
                     */
                    aria-label={item.name}
                    className={`group relative flex h-10 items-center rounded-lg transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-decoricks-brown ${
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
    </aside>
  )
}