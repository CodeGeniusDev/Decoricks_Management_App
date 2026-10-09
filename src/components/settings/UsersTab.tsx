'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/components/auth/AuthProvider'
import { roleLabel, SPEC_ROLES } from '@/lib/roles'
import { ApiError, apiJson, apiPatch, apiPost } from '@/lib/api-client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Modal } from '@/components/ui/Modal'
import { Toast } from '@/components/ui/Toast'
import {
  IconCheck,
  IconClose,
  IconKey,
  IconPlus,
  IconShieldCheck,
  IconUser,
} from '@/components/ui/icons'

interface UserRow {
  _id: string
  name: string
  email: string
  role: string
  partnerId?: string | null
  isActive: boolean
  mustChangePassword?: boolean
}

interface UsersResponse {
  users: UserRow[]
}

const ROLE_OPTIONS = SPEC_ROLES.map((role) => ({
  value: role.name,
  label: role.displayName,
}))

const PASSWORD_HINT =
  'At least 12 characters, with an uppercase letter, a lowercase letter and a number.'

type ToastState = { type: 'success' | 'error' | 'info' | 'warning'; message: string } | null

export function UsersTab() {
  const { user: me } = useAuth()
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastState>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState<UserRow | null>(null)
  const [resetting, setResetting] = useState<UserRow | null>(null)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await apiJson<UsersResponse>('/api/users')
      setUsers(data.users ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const isSelf = useCallback((row: UserRow) => me?._id === row._id, [me?._id])

  const toggleActive = useCallback(
    async (row: UserRow) => {
      setBusyId(row._id)
      try {
        await apiPatch(`/api/users/${row._id}`, { isActive: !row.isActive })
        setToast({
          type: 'success',
          message: row.isActive
            ? `${row.name} deactivated and signed out.`
            : `${row.name} reactivated.`,
        })
        await load()
      } catch (err) {
        setToast({
          type: 'error',
          message: err instanceof ApiError ? err.message : 'Could not update the user',
        })
      } finally {
        setBusyId(null)
      }
    },
    [load]
  )

  const activeFounders = useMemo(
    () => users.filter((u) => u.role === 'founder' && u.isActive).length,
    [users]
  )

  return (
    <div className="flex flex-col gap-5">
      {toast && (
        <div className="fixed top-20 right-4 z-50">
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-ink">Users &amp; roles</h3>
          <p className="mt-1 text-sm text-ink-secondary">
            Create accounts, assign a role, reset passwords and deactivate access.
          </p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <IconPlus size={16} />
          Add user
        </Button>
      </div>

      {loading && <div className="h-40 animate-pulse rounded-lg bg-surface-sunken" />}

      {error && (
        <div className="rounded-md border border-status-danger/30 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
          {error}
        </div>
      )}

      {!loading && !error && users.length === 0 && (
        <div className="rounded-lg border border-line bg-surface-raised px-4 py-10 text-center text-sm text-ink-muted">
          No users yet.
        </div>
      )}

      {!loading && !error && users.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="min-w-full divide-y divide-line-subtle text-sm">
            <thead className="bg-surface-sunken">
              <tr>
                <th className="px-3 py-3 text-left font-medium text-ink-secondary sm:px-4">Name</th>
                <th className="hidden px-3 py-3 text-left font-medium text-ink-secondary sm:table-cell sm:px-4">
                  Email
                </th>
                <th className="px-3 py-3 text-left font-medium text-ink-secondary sm:px-4">Role</th>
                <th className="px-3 py-3 text-left font-medium text-ink-secondary sm:px-4">Status</th>
                <th className="px-3 py-3 text-right font-medium text-ink-secondary sm:px-4">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle bg-surface-raised">
              {users.map((u) => {
                const self = isSelf(u)
                const soleFounder = u.role === 'founder' && activeFounders <= 1
                return (
                  <tr key={u._id} className="hover:bg-surface-app/50">
                    <td className="px-3 py-3 sm:px-4">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-decoricks-dark text-xs font-semibold text-white">
                          {u.name.charAt(0).toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium text-ink">
                            {u.name}
                            {self && (
                              <span className="ml-1.5 text-xs font-normal text-ink-muted">(you)</span>
                            )}
                          </p>
                          <p className="truncate text-xs text-ink-muted sm:hidden">{u.email}</p>
                          {u.mustChangePassword && (
                            <p className="mt-0.5 text-xs text-status-warning">
                              Password change required
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="hidden px-3 py-3 text-ink-secondary sm:table-cell sm:px-4">
                      <span className="truncate">{u.email}</span>
                    </td>
                    <td className="px-3 py-3 sm:px-4">
                      <span className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-xs font-medium text-ink-secondary">
                        <IconShieldCheck size={12} />
                        {roleLabel(u.role) ?? u.role}
                      </span>
                    </td>
                    <td className="px-3 py-3 sm:px-4">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          u.isActive
                            ? 'bg-status-success-bg text-status-success'
                            : 'bg-status-danger-bg text-status-danger'
                        }`}
                      >
                        {u.isActive ? 'Active' : 'Deactivated'}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right sm:px-4">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={self}
                          onClick={() => setEditing(u)}
                        >
                          <IconUser size={14} />
                          Edit
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setResetting(u)}>
                          <IconKey size={14} />
                          Reset password
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={self || soleFounder || busyId === u._id}
                          onClick={() => toggleActive(u)}
                        >
                          {u.isActive ? <IconClose size={14} /> : <IconCheck size={14} />}
                          {u.isActive ? 'Deactivate' : 'Reactivate'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <AddUserModal
        isOpen={addOpen}
        onClose={() => setAddOpen(false)}
        onDone={async (message) => {
          setAddOpen(false)
          setToast({ type: 'success', message })
          await load()
        }}
        onError={(message) => setToast({ type: 'error', message })}
      />

      <EditUserModal
        user={editing}
        onClose={() => setEditing(null)}
        onDone={async (message) => {
          setEditing(null)
          setToast({ type: 'success', message })
          await load()
        }}
        onError={(message) => setToast({ type: 'error', message })}
      />

      <ResetPasswordModal
        user={resetting}
        onClose={() => setResetting(null)}
        onDone={async (message) => {
          setResetting(null)
          setToast({ type: 'success', message })
          await load()
        }}
        onError={(message) => setToast({ type: 'error', message })}
      />
    </div>
  )
}

function AddUserModal({
  isOpen,
  onClose,
  onDone,
  onError,
}: {
  isOpen: boolean
  onClose: () => void
  onDone: (message: string) => void | Promise<void>
  onError: (message: string) => void
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState(ROLE_OPTIONS[1]?.value ?? 'partner_hasnat')
  const [partnerId, setPartnerId] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const reset = () => {
    setName('')
    setEmail('')
    setRole(ROLE_OPTIONS[1]?.value ?? 'partner_hasnat')
    setPartnerId('')
    setPassword('')
  }

  const submit = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        email: email.trim(),
        role,
        password,
      }
      if (partnerId.trim()) body.partnerId = partnerId.trim()
      await apiPost('/api/users', body)
      reset()
      await onDone(`Created ${email.trim()}. They must change the password on first sign-in.`)
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not create the user')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Add user"
      description="The new account is forced to set its own password at first sign-in."
      dismissible={!submitting}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={submitting}
            disabled={!name.trim() || !email.trim() || !password}
          >
            Create user
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input label="Full name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@decoricks.com"
        />
        <Select
          label="Role"
          options={ROLE_OPTIONS}
          value={role}
          onChange={(e) => setRole(e.target.value)}
        />
        <Input
          label="Partner id (optional)"
          value={partnerId}
          onChange={(e) => setPartnerId(e.target.value)}
          placeholder="e.g. hasnat"
        />
        <div>
          <Input
            label="Temporary password"
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          <p className="mt-1 text-xs text-ink-muted">{PASSWORD_HINT}</p>
        </div>
      </div>
    </Modal>
  )
}

function EditUserModal({
  user,
  onClose,
  onDone,
  onError,
}: {
  user: UserRow | null
  onClose: () => void
  onDone: (message: string) => void | Promise<void>
  onError: (message: string) => void
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [partnerId, setPartnerId] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (user) {
      setName(user.name)
      setRole(user.role)
      setPartnerId(user.partnerId ?? '')
    }
  }, [user])

  const founder = user?.role === 'founder'

  const submit = async () => {
    if (!user || submitting) return
    setSubmitting(true)
    try {
      const body: Record<string, unknown> = { name: name.trim(), partnerId: partnerId.trim() || null }
      if (!founder && role !== user.role) body.role = role
      await apiPatch(`/api/users/${user._id}`, body)
      await onDone(`Updated ${name.trim()}.`)
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not update the user')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      isOpen={Boolean(user)}
      onClose={onClose}
      title={user ? `Edit ${user.name}` : 'Edit user'}
      dismissible={!submitting}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={submitting} disabled={!name.trim()}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input label="Full name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input label="Email" value={user?.email ?? ''} disabled />
        <Select
          label="Role"
          options={ROLE_OPTIONS}
          value={role}
          onChange={(e) => setRole(e.target.value)}
          disabled={founder}
        />
        {founder && (
          <p className="text-xs text-ink-muted">The Founder role cannot be changed.</p>
        )}
        <Input
          label="Partner id (optional)"
          value={partnerId}
          onChange={(e) => setPartnerId(e.target.value)}
        />
        {role !== user?.role && (
          <p className="text-xs text-status-warning">
            Changing the role signs this user out of every device immediately.
          </p>
        )}
      </div>
    </Modal>
  )
}

function ResetPasswordModal({
  user,
  onClose,
  onDone,
  onError,
}: {
  user: UserRow | null
  onClose: () => void
  onDone: (message: string) => void | Promise<void>
  onError: (message: string) => void
}) {
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!user) setPassword('')
  }, [user])

  const submit = async () => {
    if (!user || submitting) return
    setSubmitting(true)
    try {
      await apiPost(`/api/users/${user._id}`, { password })
      await onDone(`Password reset for ${user.name}. All their sessions were revoked.`)
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not reset the password')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      isOpen={Boolean(user)}
      onClose={onClose}
      title={user ? `Reset password — ${user.name}` : 'Reset password'}
      description="They will be signed out everywhere and must choose a new password at next sign-in."
      dismissible={!submitting}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={submitting} disabled={!password}>
            Reset password
          </Button>
        </>
      }
    >
      <div>
        <Input
          label="New temporary password"
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
        <p className="mt-1 text-xs text-ink-muted">{PASSWORD_HINT}</p>
      </div>
    </Modal>
  )
}
