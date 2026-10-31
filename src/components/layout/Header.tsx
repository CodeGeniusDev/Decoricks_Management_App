'use client'

import React, { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useShellLayout } from './ShellLayoutContext'
import { useAuth } from '@/components/auth/AuthProvider'
import { NotificationBell } from '@/components/notifications/NotificationBell'
import { SignOutModal } from '@/components/offline/SignOutModal'
import { useOfflineQueueStats } from '@/hooks/useOfflineQueue'
import { useBrowserOnline } from '@/hooks/useBrowserOnline'
import { Avatar } from '@/components/ui/Avatar'
import {
  IconChevronDown,
  IconLogout,
  IconMenu,
  IconOffline,
  IconPermissions,
  IconProfile,
  IconShieldCheck,
} from '@/components/ui/icons'
import { usePressScale } from '@/lib/gsap'

/** Route → header title. Keeps the top bar useful without every page repeating it. */
function titleForPath(pathname: string): string {
  if (pathname === '/') return 'Overview'
  const segment = pathname.split('/').filter(Boolean)[0]
  if (!segment) return 'Overview'
  return segment.charAt(0).toUpperCase() + segment.slice(1)
}

export const Header = () => {
  const pathname = usePathname()
  const { toggleDrawer, isDrawerOpen } = useShellLayout()
  const { user, signOut } = useAuth()
  /*
   * The browser's own connectivity, from the app's single reader. This used to be
   * a hand-copied `useState(navigator.onLine)` plus its own `online`/`offline`
   * listeners here, which is half of the reported mismatch: the pill measured one
   * thing (the device), the dashboard chip measured another (the sync transport),
   * and a reader comparing the two saw a lie in one of them. The pill keeps
   * reporting exactly what it knows — whether THIS device has a connection — and
   * `lib/sync/connection-view` now guarantees the chip answers "Offline" from the
   * same fact, so the two can no longer disagree about being offline.
   */
  const isOnline = useBrowserOnline()
  const [menuOpen, setMenuOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutModalOpen, setSignOutModalOpen] = useState(false)
  // Offline queue badge + the §8 logout warning trigger. Live, cross-tab aware.
  const { stats } = useOfflineQueueStats(user?._id)
  const unresolved = stats.pending + stats.needsAction

  const menuRef = useRef<HTMLDivElement>(null)
  const logoutRef = useRef<HTMLButtonElement>(null)
  usePressScale(logoutRef)

  // Dismiss the account menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return

    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  const isFounder = user?.role === 'founder'

  const handleSignOut = async () => {
    if (signingOut) return
    setMenuOpen(false)
    // Unsynced entries? Never silently destroy or silently keep (§8) — ask.
    if (unresolved > 0) {
      setSignOutModalOpen(true)
      return
    }
    setSigningOut(true)
    try {
      await signOut()
      /*
       * Sign-out is the one transition that deliberately costs a document
       * request, and it replaces the previous `router.replace('/login')` +
       * `router.refresh()` pair — which issued two server renders for the same
       * hand-off and could re-mount the login form twice.
       *
       * A fresh document is the correct end state here: it destroys every piece
       * of client state that belonged to this user (permission display cache,
       * optimistic rows, the offline queue view, sync subscriptions and cursors)
       * rather than leaving them live for the next person who signs in in this
       * tab. `replace` so Back cannot return to an authenticated screen. This is
       * not a navigation-speed path — it happens once per session. (§10)
       */
      window.location.replace('/login')
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <header
      className="fixed inset-x-0 top-0 z-30 h-header border-b border-line-subtle bg-surface-raised"
      style={{ paddingLeft: 'var(--shell-sidebar-offset)' }}
    >
      <div className="flex h-full items-center gap-3 px-4 md:px-6">
        {/*
          The button that used to exist with no handler at all. Visibility comes
          from `lg:hidden` so it is present in the server-rendered markup on a
          phone; gating it in JS meant it appeared only after hydration.
        */}
        <button
          type="button"
          onClick={toggleDrawer}
          className="-ml-1 flex h-11 w-11 items-center justify-center rounded text-ink-secondary transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown lg:hidden"
          aria-label={isDrawerOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={isDrawerOpen}
          aria-controls="mobile-nav-drawer"
        >
          <IconMenu size={20} />
        </button>

        {/*
         * The page name keeps its ellipsis (a header that changes height as routes
         * rename themselves is worse than a clipped word) and carries `title` so the
         * full label is reachable. Same reasoning for the account menu below.
         */}
        <h1
          className="min-w-0 flex-1 truncate text-md font-semibold tracking-tight text-decoricks-dark"
          title={titleForPath(pathname)}
        >
          {titleForPath(pathname)}
        </h1>

        <div className="flex items-center gap-3">
          {/* Offline queue badge: only when there is something to look at. */}
          {unresolved > 0 && (
            <Link
              href="/sync"
              className="flex items-center gap-1.5 rounded-full border border-status-warning bg-status-warning-bg px-2.5 py-1 text-2xs font-medium text-status-warning transition-colors hover:bg-surface-sunken"
              aria-label={`${unresolved} offline entries pending sync`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  stats.needsAction > 0 ? 'bg-status-danger' : 'bg-status-warning'
                }`}
                aria-hidden="true"
              />
              {unresolved} pending
            </Link>
          )}

          {/* Connectivity is genuinely useful for an app with financial entry. */}
          <span
            className="hidden items-center gap-1.5 text-xs text-ink-muted sm:flex"
            role="status"
            aria-live="polite"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isOnline ? 'bg-status-success' : 'bg-status-danger'
              }`}
              aria-hidden="true"
            />
            {isOnline ? 'Online' : 'Offline'}
          </span>

          {!isOnline && (
            <span className="flex items-center gap-1.5 rounded border border-line bg-surface-sunken px-2 py-1 text-2xs font-medium text-ink-secondary sm:hidden">
              <IconOffline size={14} />
              Offline
            </span>
          )}

          {/* In-app notification center (Phase 9). Only for a signed-in session. */}
          {user && <NotificationBell />}

          {/* Account menu: profile, permissions (Founder), sign out. */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="flex h-11 items-center gap-1.5 rounded-md pl-1.5 pr-1 transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown"
            >
              <Avatar name={user?.name ?? '?'} src={user?.avatarUrl} size="sm" />
              <span className="hidden text-sm font-medium text-ink-secondary sm:inline">
                {user?.name ?? 'Account'}
              </span>
              <IconChevronDown size={14} className="hidden text-ink-muted sm:inline" />
              <span className="sr-only">Open account menu</span>
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-60 rounded-lg border border-line bg-surface-overlay py-1 shadow-lg"
              >
                <div className="border-b border-line-subtle px-3 py-2.5">
                  <p className="truncate text-sm font-medium text-ink" title={user?.name}>
                    {user?.name}
                  </p>
                  <p className="truncate text-xs text-ink-muted" title={user?.email}>
                    {user?.email}
                  </p>
                  {isFounder && (
                    <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-status-info-bg px-2 py-0.5 text-2xs font-medium text-status-info">
                      <IconShieldCheck size={11} />
                      Founder
                    </span>
                  )}
                </div>

                <Link
                  href="/profile"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  className="flex min-h-11 items-center gap-2.5 px-3 text-sm text-ink-secondary transition-colors hover:bg-surface-sunken hover:text-ink"
                >
                  <IconProfile size={16} />
                  My profile
                </Link>

                <Link
                  href="/change-password"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  className="flex min-h-11 items-center gap-2.5 px-3 text-sm text-ink-secondary transition-colors hover:bg-surface-sunken hover:text-ink"
                >
                  <IconShieldCheck size={16} />
                  Change password
                </Link>

                {isFounder && (
                  <Link
                    href="/settings"
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                    className="flex min-h-11 items-center gap-2.5 px-3 text-sm text-ink-secondary transition-colors hover:bg-surface-sunken hover:text-ink"
                  >
                    <IconPermissions size={16} />
                    Permissions
                  </Link>
                )}

                <div className="my-1 border-t border-line-subtle" />

                <button
                  ref={logoutRef}
                  type="button"
                  role="menuitem"
                  onClick={handleSignOut}
                  disabled={signingOut}
                  className="flex min-h-11 w-full items-center gap-2.5 px-3 text-left text-sm text-status-danger transition-colors hover:bg-status-danger-bg disabled:opacity-60"
                >
                  <IconLogout size={16} />
                  {signingOut ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Queue-aware sign-out choices (Phase 9 §8), rendered outside the menu. */}
      <SignOutModal isOpen={signOutModalOpen} onClose={() => setSignOutModalOpen(false)} />
    </header>
  )
}
