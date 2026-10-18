'use client'

import React, { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/components/auth/AuthProvider'
import { Button } from '@/components/ui/Button'
import {
  IconAlert,
  IconCheck,
  IconKey,
  IconLogout,
  IconShieldCheck,
} from '@/components/ui/icons'
import { usePageEnter, useRevealOnMount } from '@/lib/gsap'
import { roleLabel } from '@/lib/roles'
import { can } from '@/lib/permissions-client'
import { SignOutModal } from '@/components/offline/SignOutModal'
import { useOfflineQueueStats } from '@/hooks/useOfflineQueue'

/**
 * My profile — read-only identity plus the actions a user can take on their own
 * account.
 *
 * Deliberately shows the effective permission summary instead of letting people
 * guess. The same permission labels render here and in the Settings > Permissions
 * matrix tab.
 */

const MODULE_LABELS: Record<string, string> = {
  finance: 'Finance',
  budget: 'Budgets',
  inventory: 'Inventory',
  sales: 'Sales',
  tasks: 'Tasks',
  chat: 'Chat',
  suppliers: 'Suppliers',
  settings: 'Settings',
  users: 'Users',
}

export default function ProfilePage() {
  const { user, signOut } = useAuth()
  const [signingOut, setSigningOut] = useState(false)
  const [signOutModalOpen, setSignOutModalOpen] = useState(false)
  // Unsynced offline entries change what "sign out" means (§8) — ask first.
  const { stats } = useOfflineQueueStats(user?._id)
  const unresolved = stats.pending + stats.needsAction
  const scope = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  usePageEnter(scope, [user?._id])
  useRevealOnMount(cardRef)

  useEffect(() => {
    document.title = 'My profile — Decoricks'
  }, [])

  if (!user) return null

  const handleSignOut = async () => {
    if (signingOut) return
    if (unresolved > 0) {
      setSignOutModalOpen(true)
      return
    }
    setSigningOut(true)
    try {
      await signOut()
    } finally {
      setSigningOut(false)
      window.location.href = '/login'
    }
  }

  return (
    <div ref={scope} className="mx-auto flex max-w-3xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-decoricks-dark">My profile</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Your identity and access, as the app currently sees it.
        </p>
      </header>

      <div ref={cardRef} className="rounded-xl border border-line bg-surface-raised shadow-sm">
        <div className="flex flex-col gap-5 border-b border-line-subtle p-6 sm:flex-row sm:items-center">
          <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-decoricks-dark text-xl font-semibold text-white">
            {user.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-ink">{user.name}</h2>
            <p className="truncate text-sm text-ink-secondary">{user.email}</p>
            <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 py-1 text-xs font-medium text-ink-secondary">
              <IconShieldCheck size={13} />
              {roleLabel(user.role) ?? user.role}
            </p>
          </div>
        </div>

        {user.mustChangePassword && (
          <div className="flex items-start gap-3 border-b border-line-subtle bg-status-warning-bg px-6 py-4">
            <IconAlert className="mt-0.5 shrink-0 text-status-warning" size={18} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">Password change required</p>
              <p className="mt-0.5 text-sm text-ink-secondary">
                Your account is using a temporary password.
              </p>
              <Link
                href="/change-password"
                className="mt-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-decoricks-brown underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-decoricks-brown"
              >
                <IconKey size={14} />
                Set a new password
              </Link>
            </div>
          </div>
        )}

        <dl className="grid gap-px bg-line-subtle sm:grid-cols-2">
          <Detail label="Email" value={user.email} />
          <Detail label="Role" value={roleLabel(user.role) ?? user.role} />
          <Detail label="Partner" value={user.partnerId ?? '—'} />
          <Detail
            label="Status"
            value={user.isActive ? 'Active' : 'Deactivated'}
            tone={user.isActive ? 'success' : 'danger'}
          />
        </dl>

        <div className="flex flex-wrap items-center gap-3 p-6">
          <Button variant="secondary" onClick={handleSignOut} loading={signingOut}>
            <IconLogout size={16} />
            {signingOut ? 'Signing out…' : 'Sign out'}
          </Button>
          <Link href="/change-password">
            <Button variant="ghost">
              <IconKey size={16} />
              Change password
            </Button>
          </Link>
        </div>
      </div>

      <section className="rounded-xl border border-line bg-surface-raised p-6 shadow-sm">
        <h2 className="text-md font-semibold text-ink">What this role can do</h2>
        <p className="mt-1 text-sm text-ink-secondary">
          Read from the same permission matrix the server enforces on every request.
        </p>
        <PermissionSummary role={user.role} />
      </section>

      <SignOutModal isOpen={signOutModalOpen} onClose={() => setSignOutModalOpen(false)} />
    </div>
  )
}

function Detail({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'success' | 'danger'
}) {
  return (
    <div className="bg-surface-raised px-6 py-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd
        className={`mt-1 flex items-center gap-1.5 text-sm font-medium ${
          tone === 'success' ? 'text-status-success' : tone === 'danger' ? 'text-status-danger' : 'text-ink'
        }`}
      >
        {tone === 'success' && <IconCheck size={14} />}
        {value}
      </dd>
    </div>
  )
}

function PermissionSummary({ role }: { role: string }) {
  const entries = Object.entries(MODULE_LABELS).map(([module, label]) => ({
    module,
    label,
    granted: can({ role }, module, 'view'),
  }))

  return (
    <ul className="mt-4 grid gap-2 sm:grid-cols-2">
      {entries.map((entry) => (
        <li
          key={entry.module}
          className="flex items-center justify-between rounded-md border border-line-subtle bg-surface-app px-3 py-2.5"
        >
          <span className="text-sm text-ink-secondary">{entry.label}</span>
          {entry.granted ? (
            <span className="flex items-center gap-1 text-xs font-medium text-status-success">
              <IconCheck size={13} />
              View
            </span>
          ) : (
            <span className="text-xs font-medium text-ink-muted">No access</span>
          )}
        </li>
      ))}
    </ul>
  )
}