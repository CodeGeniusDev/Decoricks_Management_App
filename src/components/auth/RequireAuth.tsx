'use client'

import React, { useEffect, useRef } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuth } from '@/components/auth/AuthProvider'

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading, mustChangePassword } = useAuth()
  const router = useRouter()
  const pathname = usePathname()
  const scope = useRef<HTMLDivElement>(null)
  const redirectedRef = useRef(false)

  useEffect(() => {
    if (loading) return
    if (!user) {
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
  }, [loading, user, mustChangePassword, router, pathname])

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