'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ACTION_LABELS,
  LAHORE_STOCK_ROLES,
  MODULE_LABELS,
  PERMISSION_MODULES,
  SALES_FULL_EDIT_ROLES,
  SCOPED_LAHORE_STOCK_PERMISSION,
  SCOPED_SALES_FULL_EDIT,
  type PermissionModule,
} from '@/lib/roles'
import { apiJson } from '@/lib/api-client'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { Toast } from '@/components/ui/Toast'
import { IconShieldCheck } from '@/components/ui/icons'

type PermissionSet = Record<string, Record<string, boolean>>

interface RoleInfo {
  _id?: string
  name: string
  displayName: string
  permissions: PermissionSet
}

interface RolesResponse {
  roles: RoleInfo[]
}

/** Which actions each module actually exposes (matches SPEC §4.2). */
const MODULE_ACTIONS: Record<PermissionModule, string[]> = {
  finance: ['view', 'create', 'edit', 'delete', 'approve'],
  budget: ['view', 'create', 'edit', 'delete', 'approve'],
  inventory: ['view', 'create', 'edit', 'delete'],
  sales: ['view', 'create', 'edit', 'delete'],
  tasks: ['view', 'create', 'edit', 'delete'],
  chat: ['view', 'create', 'edit', 'delete'],
  suppliers: ['view', 'create', 'edit', 'delete'],
  settings: ['view', 'edit'],
  users: ['view', 'create', 'edit', 'delete'],
}

const ALL_ACTIONS = ['view', 'create', 'edit', 'delete', 'approve']

const SCOPED_ROWS = [
  {
    key: SCOPED_LAHORE_STOCK_PERMISSION,
    label: 'Inventory — record Lahore stock',
    hint: 'SPEC §4.2: Hasnat and Ali may record Lahore stock movements.',
  },
  {
    key: SCOPED_SALES_FULL_EDIT,
    label: 'Sales — full order edits',
    hint: 'SPEC §4.2: Hasnat handles delivery outcomes/returns; rewriting order contents is separate.',
  },
]

const clone = (permissions: PermissionSet): PermissionSet =>
  Object.fromEntries(
    Object.entries(permissions).map(([module, actions]) => [module, { ...actions }])
  )

/** Seed the scoped keys from SPEC defaults when a role has not customised them. */
const withScopedDefaults = (roleName: string, permissions: PermissionSet): PermissionSet => {
  const next = clone(permissions)
  if (!next[SCOPED_LAHORE_STOCK_PERMISSION]) {
    next[SCOPED_LAHORE_STOCK_PERMISSION] = { create: LAHORE_STOCK_ROLES[roleName] === true }
  }
  if (!next[SCOPED_SALES_FULL_EDIT]) {
    next[SCOPED_SALES_FULL_EDIT] = { create: SALES_FULL_EDIT_ROLES[roleName] === true }
  }
  return next
}

export function PermissionsTab() {
  const [roles, setRoles] = useState<RoleInfo[]>([])
  const [selected, setSelected] = useState('')
  const [draft, setDraft] = useState<PermissionSet>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await apiJson<RolesResponse>('/api/roles')
      const list = data.roles ?? []
      setRoles(list)
      setSelected((current) => current || list.find((r) => r.name !== 'founder')?.name || list[0]?.name || '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load roles')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const current = useMemo(() => roles.find((r) => r.name === selected) ?? null, [roles, selected])
  const isFounder = current?.name === 'founder'

  useEffect(() => {
    if (current) {
      setDraft(withScopedDefaults(current.name, current.permissions))
      setDirty(false)
    }
  }, [current])

  const setPermission = (module: string, action: string, value: boolean) => {
    if (isFounder) return
    setDraft((prev) => ({
      ...prev,
      [module]: { ...(prev[module] ?? {}), [action]: value },
    }))
    setDirty(true)
  }

  const save = async () => {
    if (!current?._id || saving || isFounder) return
    setSaving(true)
    try {
      await apiJson(`/api/roles/${current._id}`, {
        method: 'PUT',
        body: JSON.stringify({ permissions: draft }),
      })
      setDirty(false)
      setToast({
        type: 'success',
        message: `Saved. ${current.displayName} changes apply on the next request.`,
      })
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Could not save permissions',
      })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-5">
        <div className="h-10 w-64 animate-pulse rounded bg-surface-sunken" />
        <div className="h-72 animate-pulse rounded-lg bg-surface-sunken" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-md border border-status-danger/30 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
        {error}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {toast && (
        <div className="fixed top-20 right-4 z-50">
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-xs">
          <Select
            label="Role"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            options={roles.map((r) => ({ value: r.name, label: r.displayName }))}
          />
        </div>
        <Button variant="primary" onClick={save} loading={saving} disabled={!dirty || isFounder}>
          Save permissions
        </Button>
      </div>

      {isFounder && (
        <div className="rounded-md border border-line bg-surface-sunken px-3 py-2 text-sm text-ink-secondary">
          The Founder role has full access and cannot be narrowed.
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-line">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-line-subtle text-sm">
            <thead className="bg-surface-sunken">
              <tr>
                <th className="px-3 py-3 text-left font-medium text-ink-secondary sm:px-4">Module</th>
                {ALL_ACTIONS.map((action) => (
                  <th
                    key={action}
                    className="px-3 py-3 text-center font-medium text-ink-secondary sm:px-4"
                  >
                    {ACTION_LABELS[action] ?? action}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle bg-surface-raised">
              {PERMISSION_MODULES.map((module) => {
                const actions = MODULE_ACTIONS[module as PermissionModule] ?? ['view']
                return (
                  <tr key={module} className="hover:bg-surface-app/50">
                    <td className="whitespace-nowrap px-3 py-2.5 font-medium text-ink sm:px-4">
                      {MODULE_LABELS[module as PermissionModule] ?? module}
                    </td>
                    {ALL_ACTIONS.map((action) => {
                      const supported = actions.includes(action)
                      const checked = Boolean(draft[module]?.[action])
                      return (
                        <td key={action} className="px-3 py-2.5 text-center sm:px-4">
                          {supported ? (
                            <label className="inline-flex h-11 w-11 cursor-pointer items-center justify-center">
                              <input
                                type="checkbox"
                                className="h-5 w-5 accent-decoricks-brown disabled:cursor-not-allowed"
                                checked={checked}
                                disabled={isFounder}
                                onChange={(e) => setPermission(module, action, e.target.checked)}
                                aria-label={`${MODULE_LABELS[module as PermissionModule] ?? module} — ${ACTION_LABELS[action] ?? action}`}
                              />
                            </label>
                          ) : (
                            <span className="text-ink-muted">—</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-surface-raised p-4">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <IconShieldCheck size={15} />
          Scoped exceptions
        </h4>
        <div className="mt-3 flex flex-col gap-3">
          {SCOPED_ROWS.map((item) => (
            <label key={item.key} className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 accent-decoricks-brown disabled:cursor-not-allowed"
                checked={Boolean(draft[item.key]?.create)}
                disabled={isFounder}
                onChange={(e) => setPermission(item.key, 'create', e.target.checked)}
                aria-label={item.label}
              />
              <span>
                <span className="block text-sm font-medium text-ink">{item.label}</span>
                <span className="block text-xs text-ink-muted">{item.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}
