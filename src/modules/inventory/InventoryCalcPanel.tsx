'use client'

/**
 * InventoryCalcPanel — the SPEC §5.7 calculation panel (valuation, COGS,
 * margins) with its reconciliations.
 *
 * Every figure arrives from `GET /api/reports/inventory-calc`, which derives it
 * from the movement ledger and the Phase 3 ledger. The panel shows each figure
 * WITH the formula that produced it and the raw sums beside it, so a partner
 * can add the numbers up by hand — the whole point of §5.7 is that the P&L,
 * inventory and ledger reconcile visibly, not on trust.
 *
 * Fetching is guarded against out-of-order responses the same way the Phase 3
 * screens do it: a sequence number, and only the newest one may write state.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { apiJson, ApiError } from '@/lib/api-client'
import { formatPaisa } from '@/lib/money'

interface CalcValuationRow {
  _id: string
  sku: string
  name: string
  isActive: boolean
  totalAvailable: number
  cost: number
  valuation: number
  byLocation: { location: string; available: number; valuation: number }[]
}

interface CalcView {
  period: string
  range: { start: string; end: string; label: string }
  valuation: {
    formula: string
    totalValuation: number
    productCount: number
    lowStockCount: number
    byLocation: { location: string; available: number; damaged: number; returned: number; valuation: number }[]
    rows: CalcValuationRow[]
  }
  cogs: {
    formula: string
    saleOutGross: number
    restockRelieved: number
    amount: number
    movementCount: number
    lines: {
      _id: string
      dateLabel: string
      productName: string
      movementType: string
      quantity: number
      unitCost: number
      amount: number
    }[]
    truncated: boolean
  }
  losses: {
    formula: string
    rows: { type: string; units: number; amount: number; count: number }[]
    total: number
  }
  margins: {
    formula: string
    revenue: number
    refunds: number
    netSales: number
    cogs: number
    cogsProvisional: boolean
    cogsSource: string
    grossProfit: number
    grossMarginPercent: number | null
    courierAndOperatingExpenses: number
    netProfit: number
  }
  reconciliation: {
    valuation: {
      ledgerValuation: number
      panelValuation: number
      difference: number
      rows: { name: string; difference: number }[]
      withinRoundingBound: boolean
      explanation: string
    }
    cogs: { panel: number; profitLoss: number | null; matches: boolean | null }
    income: { ledgerIncome: number; orderTotals: number; ordersCashed: number; matches: boolean }
  }
  generatedAt: { iso: string; karachiDate: string }
}

const PERIOD_OPTIONS = [
  { value: 'month', label: 'This month (Karachi)' },
  { value: 'week', label: 'This week' },
  { value: 'day', label: 'Today' },
  { value: 'custom', label: 'Custom range' },
]

const LOSS_LABELS: Record<string, string> = {
  damage: 'Damaged',
  writeoff: 'Written off',
  return_damaged: 'Returned → damaged',
  return_writeoff: 'Returned → written off',
}

const money = (paisa: number) => formatPaisa(paisa)

/** One labelled figure inside a panel. */
const Line = ({ label, value, tone }: { label: string; value: string; tone?: string }) => (
  <div className="flex items-baseline justify-between gap-3 py-1">
    <span className="min-w-0 text-xs text-ink-muted">{label}</span>
    <span className={`whitespace-nowrap text-sm font-semibold ${tone ?? 'text-decoricks-dark'}`}>
      {value}
    </span>
  </div>
)

export const InventoryCalcPanel = () => {
  const [period, setPeriod] = useState('month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const [data, setData] = useState<CalcView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showRows, setShowRows] = useState(false)

  const requestSeq = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async (currentPeriod: string, currentFrom: string, currentTo: string) => {
    const seq = ++requestSeq.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const params = new URLSearchParams()
    if (currentPeriod === 'custom') {
      params.set('period', 'custom')
      params.set('from', currentFrom)
      params.set('to', currentTo)
    } else {
      params.set('period', currentPeriod)
    }

    try {
      const result = await apiJson<CalcView>(`/api/reports/inventory-calc?${params.toString()}`, {
        signal: controller.signal,
      })
      if (seq === requestSeq.current) {
        setData(result)
        setError(null)
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      if (seq === requestSeq.current) {
        // A custom range with missing bounds is a user fix, not a server fault.
        setError(
          err instanceof ApiError && err.status === 400
            ? 'Pick both dates of the custom range.'
            : err instanceof Error
              ? err.message
              : 'Could not load the calculation panel.'
        )
        setData(null)
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    void load(period, from, to)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period])

  const reconciled = (ok: boolean | null) =>
    ok === null ? (
      <Badge variant="default" size="sm">
        No P&amp;L figure yet
      </Badge>
    ) : ok ? (
      <Badge variant="success" size="sm">
        Matches
      </Badge>
    ) : (
      <Badge variant="error" size="sm">
        Does not match
      </Badge>
    )

  return (
    <Card className="p-4 md:p-6">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-md font-semibold text-decoricks-dark">
            Inventory valuation, COGS and margins
          </h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            {data
              ? `Period: ${data.range.label} · generated ${data.generatedAt.karachiDate}`
              : 'Every figure below is derived from the movement ledger and the Phase 3 ledger.'}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Select
            aria-label="Period"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            options={PERIOD_OPTIONS}
            className="w-44"
          />
          {period === 'custom' && (
            <>
              <Input
                aria-label="From date"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-40"
              />
              <Input
                aria-label="To date"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-40"
              />
              <Button variant="outline" onClick={() => void load(period, from, to)}>
                Apply
              </Button>
            </>
          )}
        </div>
      </div>

      {loading ? (
        <div className="grid gap-3 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} variant="rect" className="h-40" />
          ))}
        </div>
      ) : error ? (
        <ErrorState
          title="Could not load the calculation panel"
          description={error}
          action={{ label: 'Retry', onClick: () => void load(period, from, to) }}
        />
      ) : !data ? (
        <EmptyState title="Nothing to calculate yet" description="Record a purchase or a sale first." />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            {/* Panel 1 — valuation */}
            <div className="rounded-lg border border-line-subtle p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                Inventory valuation
              </p>
              <p className="mt-2 text-2xl font-semibold text-decoricks-dark">
                {money(data.valuation.totalValuation)}
              </p>
              <p className="mt-1 text-xs text-ink-muted">{data.valuation.formula}</p>
              <div className="mt-3 border-t border-line-subtle pt-2">
                {data.valuation.byLocation.map((row) => (
                  <Line
                    key={row.location}
                    label={`${row.location} · ${row.available} units`}
                    value={money(row.valuation)}
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={() => setShowRows((v) => !v)}
                className="mt-2 text-xs font-medium text-decoricks-brown hover:underline"
              >
                {showRows ? 'Hide per-product rows' : 'Show per-product rows'}
              </button>
              {showRows && (
                <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
                  {data.valuation.rows.length === 0 && (
                    <li className="text-xs text-ink-muted">No units on the shelf.</li>
                  )}
                  {data.valuation.rows.map((row) => (
                    <li
                      key={row._id}
                      className="flex items-baseline justify-between gap-3 text-xs"
                    >
                      <span className="min-w-0 truncate text-ink-secondary">
                        {row.name} · {row.totalAvailable} × {money(row.cost)}
                      </span>
                      <span className="whitespace-nowrap font-medium text-decoricks-dark">
                        {money(row.valuation)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Panel 2 — COGS */}
            <div className="rounded-lg border border-line-subtle p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                COGS (weighted average)
              </p>
              <p className="mt-2 text-2xl font-semibold text-decoricks-dark">
                {money(data.cogs.amount)}
              </p>
              <p className="mt-1 text-xs text-ink-muted">{data.cogs.formula}</p>
              <div className="mt-3 border-t border-line-subtle pt-2">
                <Line
                  label={`Sale-out movements (${data.cogs.movementCount} lines in period)`}
                  value={money(data.cogs.saleOutGross)}
                  tone="font-semibold text-status-danger"
                />
                <Line
                  label="Less cost returned to shelf (restocks)"
                  value={`− ${money(data.cogs.restockRelieved)}`}
                  tone="font-semibold text-status-success"
                />
                <div className="mt-1 border-t border-line-subtle pt-1">
                  <Line label="COGS in period" value={money(data.cogs.amount)} />
                </div>
              </div>
              {data.cogs.truncated && (
                <p className="mt-2 text-xs text-ink-muted">
                  More than 200 movement lines in this period — totals cover all of them; the
                  ledger screen lists every line.
                </p>
              )}
            </div>

            {/* Panel 3 — margins */}
            <div className="rounded-lg border border-line-subtle p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                Margins
              </p>
              <p className="mt-2 text-2xl font-semibold text-decoricks-dark">
                {data.margins.grossMarginPercent === null
                  ? '—'
                  : `${data.margins.grossMarginPercent.toFixed(1)}%`}
              </p>
              <p className="mt-1 text-xs text-ink-muted">{data.margins.formula}</p>
              <div className="mt-3 border-t border-line-subtle pt-2">
                <Line label="Sales revenue (ledger)" value={money(data.margins.revenue)} />
                <Line label="Refunds / returns" value={`− ${money(data.margins.refunds)}`} />
                <Line label="Net sales" value={money(data.margins.netSales)} />
                <Line
                  label={
                    data.margins.cogsProvisional
                      ? 'COGS (provisional)'
                      : 'COGS (movement ledger)'
                  }
                  value={money(data.margins.cogs)}
                />
                <div className="mt-1 border-t border-line-subtle pt-1">
                  <Line
                    label="Gross profit"
                    value={money(data.margins.grossProfit)}
                    tone={
                      data.margins.grossProfit >= 0
                        ? 'text-sm font-semibold text-status-success'
                        : 'text-sm font-semibold text-status-danger'
                    }
                  />
                  <Line
                    label="Courier + operating expenses"
                    value={money(data.margins.courierAndOperatingExpenses)}
                  />
                  <Line label="Net profit" value={money(data.margins.netProfit)} />
                </div>
              </div>
            </div>
          </div>

          {/* Stock losses in period */}
          <div className="rounded-lg border border-line-subtle p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              Stock losses in period
            </p>
            <p className="mt-1 text-xs text-ink-muted">{data.losses.formula}</p>
            {data.losses.rows.every((row) => row.count === 0) ? (
              <p className="mt-2 text-sm text-ink-secondary">None.</p>
            ) : (
              <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
                {data.losses.rows
                  .filter((row) => row.count > 0)
                  .map((row) => (
                    <Line
                      key={row.type}
                      label={`${LOSS_LABELS[row.type] ?? row.type} (${row.units} units)`}
                      value={money(row.amount)}
                      tone="text-sm font-semibold text-status-warning"
                    />
                  ))}
                <Line label="Total losses" value={money(data.losses.total)} />
              </div>
            )}
          </div>

          {/* Reconciliations */}
          <div className="rounded-lg border border-line-subtle p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              Reconciliation
            </p>
            <div className="mt-2 space-y-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-ink-secondary">
                  Ledger cost flow vs panel valuation — difference {money(
                    data.reconciliation.valuation.difference
                  )}
                </span>
                {data.reconciliation.valuation.difference === 0 ? (
                  <Badge variant="success" size="sm">
                    Exact
                  </Badge>
                ) : data.reconciliation.valuation.withinRoundingBound ? (
                  <Badge variant="warning" size="sm">
                    Weighted-average rounding
                  </Badge>
                ) : (
                  <Badge variant="error" size="sm">
                    Outside rounding bound
                  </Badge>
                )}
              </div>
              {data.reconciliation.valuation.difference !== 0 && (
                <p className="text-xs text-ink-muted">
                  {data.reconciliation.valuation.explanation}
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-ink-secondary">
                  COGS here vs Profit &amp; Loss ({money(data.reconciliation.cogs.panel)} vs{' '}
                  {data.reconciliation.cogs.profitLoss === null
                    ? '—'
                    : money(data.reconciliation.cogs.profitLoss)}
                  )
                </span>
                {reconciled(data.reconciliation.cogs.matches)}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-ink-secondary">
                  Ledger sales income vs orders cashed in period ({money(
                    data.reconciliation.income.ledgerIncome
                  )}{' '}
                  vs {money(data.reconciliation.income.orderTotals)},{' '}
                  {data.reconciliation.income.ordersCashed} order
                  {data.reconciliation.income.ordersCashed === 1 ? '' : 's'})
                </span>
                {reconciled(data.reconciliation.income.matches)}
              </div>
            </div>
          </div>

          <p className="text-xs text-ink-muted">
            COGS source: {data.margins.cogsSource}. Money is stored in whole paisa; no figure here
            is rounded into agreement with another.
          </p>
        </div>
      )}
    </Card>
  )
}
