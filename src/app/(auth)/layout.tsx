'use client'

import { useRouter, usePathname } from 'next/navigation'
import { useEffect } from 'react'
import { useAuth } from '@/components/auth/AuthProvider'
import { BrandMark } from '@/components/layout/BrandMark'

/**
 * Auth screens render bare — no sidebar, no header, no page gutter.
 * 
 * Redirect logic:
 * - /login: authenticated users go to dashboard or change-password
 * - /change-password: no automatic redirect (page handles its own logic)
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, mustChangePassword } = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    // Only redirect from /login, not from /change-password
    if (pathname === '/login' && !loading && user) {
      router.replace(mustChangePassword ? '/change-password' : '/')
    }
  }, [loading, user, mustChangePassword, router, pathname])

  return (
    <div className="flex min-h-dvh flex-col bg-surface-app">
      <header className="flex items-center gap-2 px-5 py-4">
        <BrandMark size={26} />
        <span className="text-sm font-semibold tracking-tight text-ink">Decoricks</span>
      </header>
      <div className="flex flex-1 items-center justify-center px-4 pb-16">{children}</div>
    </div>
  )
}