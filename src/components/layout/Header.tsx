'use client'

import React, { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useShellLayout } from './ShellLayoutContext'
import { useAuth } from '@/components/auth/AuthProvider'
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
  const router = useRouter()
  const { toggleDrawer, isDrawerOpen } = useShellLayout()
  const { user, signOut } = useAuth()
  const [isOnline, setIsOnline] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  const menuRef = useRef<HTMLDivElement>(null)
  const logoutRef = useRef<HTMLButtonElement>(null)
  usePressScale(logoutRef)

  useEffect(() => {
    setIsOnline(navigator.onLine)
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOffline()

    function setIsOffline() {
      setIsOnline(false)
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

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
    setSigningOut(true)
    setMenuOpen(false)
    try {
      await signOut()
      router.replace('/login')
      router.refresh()
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

        <h1 className="min-w-0 flex-1 truncate text-md font-semibold tracking-tight text-decoricks-dark">
          {titleForPath(pathname)}
        </h1>

        <div className="flex items-center gap-3">
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

          {/* Account menu: profile, permissions (Founder), sign out. */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="flex h-11 items-center gap-1.5 rounded-md pl-1.5 pr-1 transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-decoricks-dark text-xs font-semibold text-white">
                {(user?.name ?? '?').charAt(0).toUpperCase()}
              </span>
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
                  <p className="truncate text-sm font-medium text-ink">{user?.name}</p>
                  <p className="truncate text-xs text-ink-muted">{user?.email}</p>
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
    </header>
  )
}