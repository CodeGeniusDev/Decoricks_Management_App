'use client'

import React, { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth/AuthProvider'
import { Button } from '@/components/ui/Button'
import { IconAlert, IconCheck, IconEye, IconEyeOff, IconKey, IconLock } from '@/components/ui/icons'
import { useRevealOnMount } from '@/lib/gsap'
import { apiFetch } from '@/lib/api-client'

interface Rule {
  id: string
  label: string
  test: (value: string) => boolean
}

const RULES: Rule[] = [
  { id: 'length', label: 'At least 12 characters', test: (v) => v.length >= 12 },
  { id: 'lower', label: 'A lowercase letter', test: (v) => /[a-z]/.test(v) },
  { id: 'upper', label: 'An uppercase letter', test: (v) => /[A-Z]/.test(v) },
  { id: 'digit', label: 'A number', test: (v) => /[0-9]/.test(v) },
]

export default function ChangePasswordPage() {
  const router = useRouter()
  const { user, loading, mustChangePassword, refresh } = useAuth()

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const cardRef = useRef<HTMLDivElement>(null)
  useRevealOnMount(cardRef)

  // Only redirect if not authenticated - AuthLayout handles the mustChangePassword redirect
  useEffect(() => {
    if (loading) return
    if (!user) {
      router.replace('/login')
    }
  }, [loading, user, router])

  const passed = RULES.filter((rule) => rule.test(newPassword)).length
  const allRulesPassed = passed === RULES.length
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword
  const canSubmit =
    !submitting &&
    allRulesPassed &&
    !mismatch &&
    newPassword.length > 0 &&
    confirmPassword.length > 0 &&
    (mustChangePassword || currentPassword.length > 0)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return

    setError(null)
    setSubmitting(true)

    try {
      const res = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      })
      const body = await res.json().catch(() => null)

      if (!res.ok) {
        throw new Error(body?.error?.message ?? 'Could not change your password')
      }

      // Refresh auth state to get updated mustChangePassword flag
      await refresh()
      // Navigate to dashboard - AuthLayout will handle the redirect
      router.replace('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change your password')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="w-full">
      <div
        ref={cardRef}
        className="w-full max-w-md rounded-xl border border-line bg-surface-raised p-6 shadow-sm sm:p-8"
      >
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-status-warning-bg text-status-warning">
            <IconKey size={22} />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-ink">Set a new password</h1>
            <p className="mt-1 text-sm text-ink-secondary">
              {mustChangePassword
                ? 'You must change your password before continuing.'
                : 'Choose a new password for your account.'}
            </p>
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

        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          {!mustChangePassword && (
            <PasswordField
              id="current-password"
              label="Current password"
              value={currentPassword}
              onChange={setCurrentPassword}
              autoComplete="current-password"
              show={show}
            />
          )}

          <div>
            <PasswordField
              id="new-password"
              label="New password"
              value={newPassword}
              onChange={setNewPassword}
              autoComplete="new-password"
              show={show}
            />
            <ul className="mt-3 grid gap-1.5" aria-live="polite">
              {RULES.map((rule) => {
                const ok = rule.test(newPassword)
                return (
                  <li
                    key={rule.id}
                    className={`flex items-center gap-2 text-xs ${
                      ok ? 'text-status-success' : 'text-ink-muted'
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 items-center justify-center rounded-full ${
                        ok ? 'bg-status-success-bg' : 'bg-surface-sunken'
                      }`}
                    >
                      {ok && <IconCheck size={11} />}
                    </span>
                    {rule.label}
                  </li>
                )
              })}
            </ul>
          </div>

          <PasswordField
            id="confirm-password"
            label="Confirm new password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
            show={show}
            error={mismatch ? 'Passwords do not match' : undefined}
          />

          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className="flex h-11 items-center gap-2 self-start rounded-md px-1 text-xs font-medium text-ink-secondary transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown"
          >
            {show ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            {show ? 'Hide passwords' : 'Show passwords'}
          </button>

          <Button type="submit" size="lg" loading={submitting} disabled={!canSubmit} className="w-full">
            {submitting ? 'Saving…' : 'Save new password'}
          </Button>
        </form>

        <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-ink-muted">
          <IconLock className="mt-0.5 shrink-0" size={14} />
          <span>
            Changing your password signs out every other device. This session stays
            active.
          </span>
        </p>
      </div>
    </main>
  )
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  show,
  error,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  autoComplete: string
  show: boolean
  error?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-ink-secondary">
        {label}
      </label>
      <input
        id={id}
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`h-11 w-full rounded-md border bg-surface-raised px-3 text-sm text-ink-secondary transition-colors placeholder:text-ink-muted focus-visible:border-decoricks-brown focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown ${
          error ? 'border-status-danger' : 'border-line'
        }`}
      />
      {error && (
        <p className="text-xs text-status-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}