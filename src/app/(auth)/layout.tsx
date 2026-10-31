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
      <div className="flex flex-1 items-center justify-center px-4 pb-16">
        {children}
        {/*
          Both auth screens need JavaScript to do anything: the sign-in form is
          client-rendered, and the change-password submit stays disabled until its
          handler is attached. That state is what keeps a field value out of a URL
          (`src/app/(auth)/login/page.tsx`), so it has to be explained rather than
          left as a screen that never finishes loading.

          This layout, not the pages, is where the notice belongs: it is the auth
          markup that is actually in the server HTML. And it is a bare text child on
          purpose — with scripting on, the browser keeps `<noscript>` content as one
          text node, so element children inside it would not match on hydration.
        */}
        <noscript className="absolute inset-x-4 bottom-4 rounded-md border border-line bg-surface-raised px-3 py-2 text-center text-xs text-ink-secondary">
          These screens need JavaScript. Please enable it for this site.
        </noscript>
      </div>
    </div>
  )
}
