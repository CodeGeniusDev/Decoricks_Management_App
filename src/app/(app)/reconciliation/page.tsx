'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

import { PageTransition } from '@/components/PageTransition'
import { HeaderActions, PageHeader } from '@/components/layout/Page'
import { Card } from '@/components/ui/Card'
import { HelpPanel } from '@/components/ui/HelpPanel'
import { Table } from '@/components/ui/Table'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { ErrorState } from '@/components/ui/ErrorState'
import { PeriodSelector } from '@/components/dashboard/PeriodSelector'
import type { DashboardPeriod } from '@/lib/dashboard/useDashboard'
import { apiJsonMeta } from '@/lib/api-client'
import { formatPaisa } from '@/lib/money'
import { formatKarachiDate } from '@/lib/date'
import { useRealtimeSync } from '@/lib/sync/useRealtime'
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

  /*
   * One reconciliation report is simultaneously a read of `finance` and of
   * `sales`, so it announces itself to both subscriptions. Without that, each
   * module's first snapshot fired its own re-read beside the mount request — the
   * `×3` the Phase 6 perf probe counted on this route (one real read plus two
   * duplicates that returned the numbers already on their way).
   */
  const financeSync = useRealtimeSync('finance', () => {
    if (founder) void load()
  })
  const salesSync = useRealtimeSync('sales', () => {
    if (founder) void load()
  })

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    financeSync.begin()
    salesSync.begin()
    try {
      const { data, serverTime, durationMs } = await apiJsonMeta<ReconciliationReport>(
        `/api/dashboard/reconciliation?${rangeQuery}`
      )
      financeSync.settle(serverTime, durationMs)
      salesSync.settle(serverTime, durationMs)
      setReport(data ?? null)
    } catch (err) {
      financeSync.abandon()
      salesSync.abandon()
      setError(err instanceof Error ? err.message : 'Failed to load reconciliation')
    } finally {
      setLoading(false)
    }
  }, [rangeQuery, financeSync, salesSync])

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
          /*
           * The dashboard's actions row, not a bare selector: `PageHeader`'s own
           * actions box wraps flex items at their natural width, which is right for
           * buttons and left this 2×2 chip grid plus a date row squeezed into
           * whatever its longest label asks for on a phone.
           */
          <HeaderActions>
            <PeriodSelector
              period={period}
              customFrom={customFrom}
              customTo={customTo}
              onPeriod={setPeriod}
              onCustomRange={onCustomRange}
              onRefresh={load}
              refreshing={loading && !!report}
              refreshLabel="Refresh reconciliation report"
            />
          </HeaderActions>
        }
      />

      {/* Phase 2 §8: this page is the one place where a reader has to trust two
          numbers that look identical. The panel says what is being compared and
          what a failure actually means. */}
      <HelpPanel
        title="What this page actually checks"
        persistKey="reconciliation"
        defaultOpen
        intro="Every row asks the same question twice: the figure your dashboards show, and the same figure rebuilt independently from the raw ledger. If the two disagree, one of them is wrong — and this page is where it surfaces."
        steps={[
          'The selected period is resolved to Karachi boundaries, then the whole ledger is read once.',
          'Each money equality is computed by the reporting engine and again by a separate reduce over the same entries.',
          'The two results are subtracted. Anything but zero is reported as a fail, in paisa — never rounded away or corrected.',
        ]}
        items={[
          {
            title: 'Recomputed',
            body: 'The independent result — code that does not reuse the reporting engine’s own totals.',
          },
          {
            title: 'Reported',
            body: 'What the dashboard, P&L and reports currently show you.',
          },
          {
            title: 'Difference',
            body: 'Reported minus recomputed, in paisa. A non-zero value means money exists somewhere the two paths disagree about.',
          },
          {
            title: 'The rows change',
            body: 'Inventory, budget and account checks only appear when there is stock, an active budget or configured accounts to compare against.',
          },
        ]}
        footer="A fail is a finding, not a warning: nothing on this page writes to the ledger."
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

          {/* Desktop: the dense comparison table. Mobile: the same rows as cards,
              because seven columns of paisa never fit without horizontal scroll. */}
          <div className="hidden md:block">
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
                  <span
                    className={`tabular-nums ${c.pass ? 'text-ink-muted' : 'font-semibold text-status-danger'}`}
                  >
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
          <ul className="space-y-3 md:hidden">
            {report.checks.map((c) => (
              <li
                key={c.name}
                className="rounded-lg border border-line-subtle bg-surface-raised px-4 py-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 font-medium text-ink">{c.name}</p>
                  {c.pass ? (
                    <Badge variant="success" size="sm">
                      Pass
                    </Badge>
                  ) : (
                    <Badge variant="error" size="sm">
                      Fail
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-ink-muted">{c.description}</p>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <dt className="text-ink-muted">Recomputed</dt>
                    <dd className="font-semibold tabular-nums text-decoricks-dark">
                      {formatPaisa(c.a)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">Against</dt>
                    <dd className="font-semibold tabular-nums text-decoricks-dark">
                      {formatPaisa(c.b)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">Difference</dt>
                    <dd
                      className={`font-semibold tabular-nums ${
                        c.pass ? 'text-ink-muted' : 'text-status-danger'
                      }`}
                    >
                      {formatPaisa(c.difference)}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </div>
      )}
    </PageTransition>
  )
}
