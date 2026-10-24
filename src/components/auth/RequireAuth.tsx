'use client'

import React, { useEffect, useRef } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuth } from '@/components/auth/AuthProvider'
import { ErrorState } from '@/components/ui/ErrorState'

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading, error, mustChangePassword, refresh } = useAuth()
  const router = useRouter()
  const pathname = usePathname()
  const scope = useRef<HTMLDivElement>(null)
  const redirectedRef = useRef(false)

  useEffect(() => {
    if (loading) return
    if (!user) {
      // "Could not determine" is not "signed out". A 5xx or a dropped request to
      // /api/auth/me used to fall through to the redirect below, which kicked a
      // validly authenticated user to the login page on any slow dev compile or
      // database blip — the reason a first navigation sometimes had to be
      // retried. The error branch now renders a retry instead.
      if (error) return
      if (!redirectedRef.current) {
        redirectedRef.current = true
        router.replace('/login')
      }
      return
    }
    if (mustChangePassword && pathname !== '/change-password') {
      if (!redirectedRef.current) {
        redirectedRef.current = true
        router.replace('/change-password')
      }
      return
    }
    // allow normal flow
  }, [loading, user, error, mustChangePassword, router, pathname])

  // Unknown session and absent session are presented differently on purpose:
  // this one is recoverable in place, so it ends the loading state with an
  // explanation and a retry rather than an indefinite skeleton.
  if (!user && error) {
    return (
      <ErrorState
        title="Could not verify your session"
        description="The app could not reach the server to confirm your sign-in. Nothing was lost — try again."
        action={{ label: 'Retry', onClick: () => void refresh() }}
      />
    )
  }

  if (loading || !user || (mustChangePassword && pathname !== '/change-password')) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading…</span>
        <div className="h-8 w-48 animate-pulse rounded bg-surface-sunken" />
        <div className="h-64 w-full animate-pulse rounded-lg bg-surface-sunken" />
      </div>
    )
  }

  return <div ref={scope}>{children}</div>
}
