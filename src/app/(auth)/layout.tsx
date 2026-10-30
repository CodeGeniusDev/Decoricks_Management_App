'use client'

import { useRouter, usePathname } from 'next/navigation'
import { useEffect } from 'react'
import { useAuth } from '@/components/auth/AuthProvider'
import { BrandMark } from '@/components/layout/BrandMark'
import { safeRedirectPath } from '@/lib/safe-redirect'

/**
 * Auth screens render bare — no sidebar, no header, no page gutter.
 *
 * Redirect logic:
 * - /login: authenticated users go to the page they were headed for, or the
 *   dashboard, or change-password
 * - /change-password: no automatic redirect (page handles its own logic)
 *
 * Middleware preserves the interrupted destination as `/login?next=…` and the
 * login form follows it, so this effect has to agree with it. It used to send
 * every signed-in visitor to `/` unconditionally, which won the race against
 * the form's own navigation and made the `next` parameter dead: an interrupted
 * partner was always dropped on the dashboard. The destination is read here
 * rather than through `useSearchParams` because this layout wraps pages that
 * have no Suspense boundary of their own, and `window.location.search` is only
 * ever consulted on the client, inside the effect.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, mustChangePassword } = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    // Only redirect from /login, not from /change-password
    if (pathname === '/login' && !loading && user) {
      const destination = mustChangePassword
        ? '/change-password'
        : safeRedirectPath(new URLSearchParams(window.location.search).get('next'))
      router.replace(destination)
    }
  }, [loading, user, mustChangePassword, router, pathname])

  return (
    <div className="flex min-h-dvh flex-col bg-surface-app justify-center">
      <header className="flex items-center gap-2 px-5 py-4">
        <BrandMark size={26} />
        <span className="text-sm font-semibold tracking-tight text-ink">Decoricks</span>
      </header>
      <div className="flex flex-1 items-center justify-center px-4 pb-16">{children}</div>
    </div>
  )
}
