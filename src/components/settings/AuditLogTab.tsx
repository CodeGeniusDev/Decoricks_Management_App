'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { ApiError, apiJson } from '@/lib/api-client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'

interface AuditEntry {
  _id: string
  userId: string | null
  userEmail?: string | null
  action: string
  entityType?: string | null
  entityId?: string | null
  outcome?: string | null
  ipAddress?: string | null
  details?: string | null
  createdAt: string
}

interface AuditResponse {
  entries: AuditEntry[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
    hasNext: boolean
    hasPrevious: boolean
  }
  filters: {
    actions: string[]
    entityTypes: string[]
  }
}

interface FilterForm {
  search: string
  action: string
  entityType: string
  outcome: string
  from: string
  to: string
}

const EMPTY_FORM: FilterForm = {
  search: '',
  action: '',
  entityType: '',
  outcome: '',
  from: '',
  to: '',
}

const LIMIT = 25

const OUTCOME_OPTIONS = [
  { value: '', label: 'All outcomes' },
  { value: 'success', label: 'Success' },
  { value: 'denied', label: 'Denied' },
  { value: 'failure', label: 'Failure' },
]

export function AuditLogTab() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [filterOptions, setFilterOptions] = useState<{ actions: string[]; entityTypes: string[] }>({
    actions: [],
    entityTypes: [],
  })
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<FilterForm>(EMPTY_FORM)
  const [applied, setApplied] = useState<FilterForm>(EMPTY_FORM)

  const load = useCallback(async (targetPage: number, filters: FilterForm) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(targetPage), limit: String(LIMIT) })
      if (filters.search) params.set('search', filters.search)
      if (filters.action) params.set('action', filters.action)
      if (filters.entityType) params.set('entityType', filters.entityType)
      if (filters.outcome) params.set('outcome', filters.outcome)
      if (filters.from) params.set('from', filters.from)
      if (filters.to) params.set('to', filters.to)

      const data = await apiJson<AuditResponse>(`/api/audit-log?${params.toString()}`)
      setEntries(data.entries ?? [])
      setTotal(data.pagination?.total ?? 0)
      setTotalPages(data.pagination?.totalPages ?? 1)
      if (data.filters) {
        setFilterOptions({
          actions: data.filters.actions ?? [],
          entityTypes: data.filters.entityTypes ?? [],
        })
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the audit log')
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(page, applied)
  }, [load, page, applied])

  const applyFilters = (e: React.FormEvent) => {
    e.preventDefault()
    setPage(1)
    setApplied(form)
  }

  const resetFilters = () => {
    setForm(EMPTY_FORM)
    setPage(1)
    setApplied(EMPTY_FORM)
  }

  const update = (patch: Partial<FilterForm>) => setForm((prev) => ({ ...prev, ...patch }))

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-lg font-semibold text-ink">Audit log</h3>
        <p className="mt-1 text-sm text-ink-secondary">
          Append-only record of logins, user changes and permission changes. Newest first.
        </p>
      </div>

      <form onSubmit={applyFilters} className="flex flex-col gap-3 rounded-lg border border-line bg-surface-raised p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Input
            label="Search"
            value={form.search}
            onChange={(e) => update({ search: e.target.value })}
            placeholder="Action, email or details"
          />
          <Select
            label="Action"
            value={form.action}
            onChange={(e) => update({ action: e.target.value })}
            options={[
              { value: '', label: 'All actions' },
              ...filterOptions.actions.map((a) => ({ value: a, label: a })),
            ]}
          />
          <Select
            label="Entity"
            value={form.entityType}
            onChange={(e) => update({ entityType: e.target.value })}
            options={[
              { value: '', label: 'All entities' },
              ...filterOptions.entityTypes.map((t) => ({ value: t, label: t })),
            ]}
          />
          <Select
            label="Outcome"
            value={form.outcome}
            onChange={(e) => update({ outcome: e.target.value })}
            options={OUTCOME_OPTIONS}
          />
          <Input
            label="From"
            type="date"
            value={form.from}
            onChange={(e) => update({ from: e.target.value })}
          />
          <Input
            label="To"
            type="date"
            value={form.to}
            onChange={(e) => update({ to: e.target.value })}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={resetFilters}>
            Reset
          </Button>
          <Button type="submit" variant="primary" disabled={loading}>
            Apply filters
          </Button>
        </div>
      </form>

      {loading && <div className="h-60 animate-pulse rounded-lg bg-surface-sunken" />}

      {error && !loading && (
        <div className="rounded-md border border-status-danger/30 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
          {error}
        </div>
      )}

      {!loading && !error && (
        <div className="overflow-hidden rounded-lg border border-line">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-line-subtle text-sm">
              <thead className="bg-surface-sunken">
                <tr>
                  <th className="whitespace-nowrap px-3 py-3 text-left font-medium text-ink-secondary">When</th>
                  <th className="whitespace-nowrap px-3 py-3 text-left font-medium text-ink-secondary">Actor</th>
                  <th className="whitespace-nowrap px-3 py-3 text-left font-medium text-ink-secondary">Action</th>
                  <th className="whitespace-nowrap px-3 py-3 text-left font-medium text-ink-secondary">Entity</th>
                  <th className="whitespace-nowrap px-3 py-3 text-left font-medium text-ink-secondary">Outcome</th>
                  <th className="whitespace-nowrap px-3 py-3 text-left font-medium text-ink-secondary">IP</th>
                  <th className="px-3 py-3 text-left font-medium text-ink-secondary">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-subtle bg-surface-raised">
                {entries.map((e) => (
                  <tr key={e._id} className="hover:bg-surface-app/50">
                    <td className="whitespace-nowrap px-3 py-3 text-ink-secondary">
                      {new Date(e.createdAt).toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-ink-secondary">
                      {e.userEmail ?? '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 font-medium text-ink">{e.action}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-ink-secondary">
                      {e.entityType ? `${e.entityType}${e.entityId ? `:${e.entityId}` : ''}` : '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          e.outcome === 'success'
                            ? 'bg-status-success-bg text-status-success'
                            : e.outcome === 'denied' || e.outcome === 'failure'
                              ? 'bg-status-danger-bg text-status-danger'
                              : 'bg-surface-sunken text-ink-secondary'
                        }`}
                      >
                        {e.outcome ?? '—'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-ink-secondary">{e.ipAddress ?? '—'}</td>
                    <td className="max-w-xs truncate px-3 py-3 text-ink-muted" title={e.details ?? ''}>
                      {e.details ?? '—'}
                    </td>
                  </tr>
                ))}
                {entries.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-10 text-center text-sm text-ink-muted">
                      No audit entries match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-line-subtle px-3 py-3 text-sm text-ink-secondary">
            <span>
              Page {page} of {totalPages} • {total} total
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="min-h-11 rounded-md border border-line px-3 text-sm transition-colors hover:bg-surface-sunken disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="rounded-md border border-line px-3 py-1.5 text-sm transition-colors hover:bg-surface-sunken disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
