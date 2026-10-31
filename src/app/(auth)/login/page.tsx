'use client'

import React, { Suspense, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/components/auth/AuthProvider'
import { useHydrated } from '@/hooks/useHydrated'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { BrandMark } from '@/components/layout/BrandMark'
import { IconAlert, IconEye, IconEyeOff, IconLock } from '@/components/ui/icons'
import { useRevealOnMount } from '@/lib/gsap'
import { safeRedirectPath } from '@/lib/safe-redirect'

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { signIn } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const cardRef = useRef<HTMLDivElement>(null)
  useRevealOnMount(cardRef)

  // `?next=` is attacker-suppliable on a public page, so it is validated by
  // `safeRedirectPath` rather than by a "one leading slash" test here.
  const safeNext = safeRedirectPath(searchParams.get('next'))

  // See `useHydrated`: the submit stays inert until `handleSubmit` is attached, so
  // no click or Enter can ever reach the browser's native submit path. On this page
  // that is a guarantee rather than a reproduction — the form is not in the server
  // HTML at all (see the comment on the form below) — and it is the guarantee the
  // `/change-password` screen needs, where the markup genuinely is.
  const hydrated = useHydrated()

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting) return

    setError(null)
    setSubmitting(true)

    try {
      const user = await signIn(email, password)
      if (user?.mustChangePassword) {
        router.replace('/change-password')
      } else {
        router.replace(safeNext)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid email or password')
      setPassword('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      ref={cardRef}
      className="w-full max-w-sm rounded-xl border border-line bg-surface-raised p-6 shadow-sm sm:p-8"
    >
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <BrandMark size={40} />
        <div>
          <h1 className="text-xl font-semibold text-ink">Sign in</h1>
          <p className="mt-1 text-sm text-ink-secondary">Decoricks management</p>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-5 flex items-start gap-2 rounded-md border border-status-danger/30 bg-status-danger-bg px-3 py-2.5 text-sm text-status-danger"
        >
          <IconAlert className="mt-0.5 shrink-0" size={16} />
          <span>{error}</span>
        </div>
      )}

      {/*
        `method="post"` is not decorative. A form with no method is a GET form, and a
        GET submit puts every named field — here `email` and `password` — into the URL,
        the history entry and any Referer header.

        What the shipped bundle actually does was measured, not assumed: `/login` is
        prerendered, so the HTML a browser parses contains this component's Suspense
        FALLBACK and nothing else — the form exists only after React has rendered it,
        which is also when `handleSubmit` becomes reachable. So the pre-hydration
        native submit does not have a target here, and a visitor with scripting off
        gets a skeleton rather than a credential-leaking form (the notice for them is
        in `(auth)/layout.tsx`, where it is genuinely server-rendered).

        The method and the `hydrated` gate below are therefore the belt and the braces
        rather than the fix: if this page is ever made server-rendered again — a
        dynamic render of it already returns the full form, because a POST to a page
        route is not served from the prerender cache — nothing has to be re-remembered.
        The part that closes a leak that already happened is the edge guard on the URL
        itself; see `src/lib/credential-query.ts`.
      */}
      <form
        method="post"
        action="/login"
        onSubmit={handleSubmit}
        noValidate
        className="flex flex-col gap-4"
      >
        <Input
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@decoricks.pk"
        />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="login-password" className="text-xs font-medium text-ink-secondary">
            Password
          </label>
          <div className="relative">
            <input
              id="login-password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="h-11 w-full rounded-md border border-line bg-surface-raised px-3 pr-11 text-sm text-ink-secondary transition-colors placeholder:text-ink-muted focus-visible:border-decoricks-brown focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-md text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown"
            >
              {showPassword ? <IconEyeOff size={18} /> : <IconEye size={18} />}
            </button>
          </div>
        </div>

        <p className="text-right text-xs text-ink-muted">
          Forgot your password? Ask a Founder to reset it for you.
        </p>

        <Button
          type="submit"
          size="lg"
          loading={submitting}
          disabled={!hydrated}
          className="mt-1 w-full"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-ink-muted">
        <IconLock className="mt-0.5 shrink-0" size={14} />
        <span>
          After 5 failed attempts the account is locked for 15 minutes. There is no self-service
          signup — a Founder creates each account.
        </span>
      </p>

      {process.env.NODE_ENV === 'development' && (
        <p className="mt-4 text-center text-xs text-ink-muted">
          <Link href="/api/health" className="underline">
            Health check
          </Link>
        </p>
      )}
    </div>
  )
}

export default function LoginPage() {
  return (
    <main className="w-full">
      <Suspense
        fallback={
          <div className="w-full max-w-sm rounded-xl border border-line bg-surface-raised p-6 shadow-sm sm:p-8">
            <div className="h-6 w-32 animate-pulse rounded bg-surface-sunken" />
          </div>
        }
      >
        <LoginForm />
      </Suspense>
    </main>
  )
}
