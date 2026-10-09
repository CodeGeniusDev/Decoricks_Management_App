'use client'

import React, { useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isActiveRoute, navItems } from './nav-config'
import { useShellLayout } from './ShellLayoutContext'
import { useAuth } from '@/components/auth/AuthProvider'
import { canAccessRoute } from '@/lib/permissions-client'
import { BrandMark } from './BrandMark'
import { IconClose } from '@/components/ui/icons'

const FOCUSABLE =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * MobileDrawer — navigation overlay for viewports below `lg`.
 *
 * Replaces the previous bottom tab bar plus a right-hand full-screen menu, which
 * meant two competing navigation surfaces, a permanent chunk of screen height
 * (`pb-20` on <main>), and duplicated route lists.
 *
 * Behaviour required of a real drawer:
 *  - overlays the content instead of displacing it
 *  - Escape closes
 *  - clicking the scrim closes
 *  - choosing a route closes
 *  - focus moves into the drawer on open and returns to the trigger on close
 *  - Tab is trapped inside while open
 *  - background scroll is locked without leaving the page unscrollable if the
 *    drawer is dismissed by any other means
 */
export const MobileDrawer = () => {
  const pathname = usePathname()
  const { isDrawerOpen, closeDrawer } = useShellLayout()
  const { user } = useAuth()
  const panelRef = useRef<HTMLDivElement>(null)

  // Same Founder-only filtering as the desktop rail, so the two never disagree.
  const visibleItems = user
    ? navItems.filter((item) => canAccessRoute({ role: user.role }, item.href))
    : navItems

  const triggerRef = useRef<HTMLElement | null>(null)

  // Escape to close, plus Tab focus containment.
  useEffect(() => {
    if (!isDrawerOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeDrawer()
        return
      }

      if (event.key !== 'Tab') return

      const panel = panelRef.current
      if (!panel) return

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement

      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isDrawerOpen, closeDrawer])

  // Move focus into the drawer; restore it to the trigger on close.
  useEffect(() => {
    if (isDrawerOpen) {
      triggerRef.current = document.activeElement as HTMLElement | null
      const panel = panelRef.current
      const target = panel?.querySelector<HTMLElement>(FOCUSABLE)
      target?.focus()
      return
    }

    const trigger = triggerRef.current
    if (trigger && document.body.contains(trigger)) {
      trigger.focus()
    }
    triggerRef.current = null
  }, [isDrawerOpen])

  // Lock background scroll while open, restoring whatever value was there.
  useEffect(() => {
    if (!isDrawerOpen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [isDrawerOpen])

  /*
   * Rendered at every width and hidden with `lg:hidden` rather than being skipped
   * in JS. Conditionally returning null meant the panel did not exist in the
   * first paint on a phone, so opening the drawer depended on hydration having
   * already run.
   */
  return (
    <div className="lg:hidden">
      {/* Scrim */}
      <div
        onClick={closeDrawer}
        className={`fixed inset-0 z-40 bg-decoricks-black/40 transition-opacity duration-240 ease-standard ${
          isDrawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        id="mobile-nav-drawer"
        ref={panelRef}
        role="dialog"
        aria-modal={isDrawerOpen ? true : undefined}
        aria-label="Navigation"
        className={`fixed inset-y-0 left-0 z-50 flex w-drawer flex-col border-r border-line-subtle bg-surface-overlay shadow-lg transition-transform duration-240 ease-standard ${
          isDrawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        // Keep the drawer out of the tab order and off screen when closed so
        // keyboard users never land inside a hidden panel.
        {...(!isDrawerOpen ? { inert: true, 'aria-hidden': true } : {})}
      >
        <div className="flex h-header shrink-0 items-center justify-between border-b border-line-subtle px-4">
          <div className="flex items-center gap-2.5">
            <BrandMark size={26} />
            <span className="text-md font-semibold tracking-tight text-decoricks-dark">Decoricks</span>
          </div>
          <button
            type="button"
            onClick={closeDrawer}
            className="flex h-9 w-9 items-center justify-center rounded text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-decoricks-brown"
            aria-label="Close navigation"
          >
            <IconClose size={18} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-3">
          <ul className="flex flex-col gap-0.5">
            {visibleItems.map((item) => {
              const isActive = isActiveRoute(pathname, item.href)
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={closeDrawer}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-decoricks-brown ${
                      isActive
                        ? 'bg-decoricks-brown text-white'
                        : 'text-ink-secondary hover:bg-surface-sunken hover:text-ink'
                    }`}
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                      {item.icon}
                    </span>
                    <span className="truncate">{item.name}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>
      </div>
    </div>
  )
}