'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

import { PageTransition } from '@/components/PageTransition'
import { PageHeader } from '@/components/layout/Page'
import { Card } from '@/components/ui/Card'
import { Table } from '@/components/ui/Table'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { ErrorState } from '@/components/ui/ErrorState'
import { PeriodSelector } from '@/components/dashboard/PeriodSelector'
import type { DashboardPeriod } from '@/lib/dashboard/useDashboard'
import { apiFetch } from '@/lib/api-client'
import { formatPaisa } from '@/lib/money'
import { formatKarachiDate } from '@/lib/date'
import { useAuth } from '@/components/auth/AuthProvider'
import { isFounder } from '@/lib/permissions-client'
import type { ReconciliationReport } from '@/lib/metrics/reconciliation'

/**
 * Reconciliation panel (Phase 8 Checkpoint 3, METRICS.md §H.2 / brief §5).
 *
 * Founder-only. It reads `/api/dashboard/reconciliation`, which recomputes every
 * cross-module equality independently and returns the exact difference in paisa.
 * A non-zero difference is shown as a visible FAIL — nothing is rounded away,
 * hidden or auto-corrected. This is the "dashboard = reports = ledger" contract
 * made inspectable.
 *
 * The route is guarded server-side by `requireFounder` (the ROLE, not a grant);
 * this screen mirrors that so a non-Founder is never offered a doomed fetch, and
 * every figure (paisa ints) is formatted through the shared `formatPaisa`.
 */

const COLUMNS = [
  { key: 'name', label: 'Check' },
  { key: 'a', label: 'Recomputed' },
  { key: 'b', label: 'Against' },
  { key: 'difference', label: 'Difference' },
  { key: 'status', label: 'Status' },
]

export default function ReconciliationPage() {
  const { user } = useAuth()
  const founder = user ? isFounder(user.role) : false

  const [period, setPeriod] = useState<DashboardPeriod>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [report, setReport] = useState<ReconciliationReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const rangeQuery = useMemo(() => {
    const params = new URLSearchParams()
    if (period === 'custom') {
      if (customFrom) params.set('from', customFrom)
      if (customTo) params.set('to', customTo)
      params.set('period', 'custom')
    } else {
      params.set('period', period)
    }
    return params.toString()
  }, [period, customFrom, customTo])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/dashboard/reconciliation?${rangeQuery}`)
      const body = (await res.json()) as {
        success: boolean
        data?: ReconciliationReport
        error?: { message?: string }
      }
      if (!res.ok || !body.success) {
        throw new Error(body.error?.message ?? `Request failed (${res.status})`)
      }
      setReport(body.data ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reconciliation')
    } finally {
      setLoading(false)
    }
  }, [rangeQuery])

  useEffect(() => {
    if (founder) void load()
  }, [founder, load])

  const onCustomRange = useCallback((from: string, to: string) => {
    setCustomFrom(from)
    setCustomTo(to)
  }, [])

  // A non-Founder who reaches the URL directly is refused server-side too; this
  // is a courtesy message so the screen never shows an empty board or a 403.
  if (user && !founder) {
    return (
      <PageTransition>
        <PageHeader title="Reconciliation" />
        <ErrorState
          title="Founder-only screen"
          description="Reconciliation verifies the money equalities across every module and is restricted to the Founder."
        />
      </PageTransition>
    )
  }

  const firstPaint = loading && !report

  return (
    <PageTransition>
      <PageHeader
        title="Reconciliation"
        description={
          report
            ? `Range ${formatKarachiDate(new Date(report.range.start), 'date')} – ${formatKarachiDate(
                new Date(report.range.end),
                'date'
              )} · generated ${formatKarachiDate(new Date(report.generatedAt), 'time')}`
            : 'Independent re-computation of the money equalities. Any non-zero difference is a real fail.'
        }
        actions={
          <PeriodSelector
            period={period}
            customFrom={customFrom}
            customTo={customTo}
            onPeriod={setPeriod}
            onCustomRange={onCustomRange}
            onRefresh={load}
            refreshing={loading && !!report}
          />
        }
      />

      {firstPaint && (
        <div className="space-y-4">
          <Skeleton variant="rect" className="h-16" />
          <Skeleton variant="rect" className="h-64" />
        </div>
      )}

      {!firstPaint && error && !report && (
        <ErrorState
          title="Couldn’t load reconciliation"
          description={error}
          action={{ label: 'Try again', onClick: load }}
        />
      )}

      {report && (
        <div className="space-y-4">
          <Card className="p-5">
            {report.allPass ? (
              <div className="flex items-center gap-3">
                <Badge variant="success">All checks pass</Badge>
                <p className="text-sm text-ink-muted">
                  Every recomputed figure equals the ledger to the paisa.
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant="error">
                  {report.checks.filter((c) => !c.pass).length} of {report.checks.length} checks
                  differ
                </Badge>
                <p className="text-sm text-ink-muted">
                  A difference is shown exactly; nothing is rounded away or corrected.
                </p>
              </div>
            )}
          </Card>

          <Table
            columns={COLUMNS}
            data={report.checks.map((c) => ({
              name: (
                <div className="min-w-0">
                  <p className="font-medium text-ink">{c.name}</p>
                  <p className="text-xs text-ink-muted">{c.description}</p>
                </div>
              ),
              a: <span className="tabular-nums">{formatPaisa(c.a)}</span>,
              b: <span className="tabular-nums">{formatPaisa(c.b)}</span>,
              difference: (
                <span className={`tabular-nums ${c.pass ? 'text-ink-muted' : 'font-semibold text-status-danger'}`}>
                  {formatPaisa(c.difference)}
                  <span className="ml-1 text-2xs text-ink-muted">({c.difference} paisa)</span>
                </span>
              ),
              status: c.pass ? (
                <Badge variant="success">Pass</Badge>
              ) : (
                <Badge variant="error">Fail</Badge>
              ),
            }))}
          />
        </div>
      )}
    </PageTransition>
  )
}
