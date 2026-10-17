'use client'

import React from 'react'

import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatPaisa } from '@/lib/money'
import type {
  ProfitBlock,
  ExpenseBlock,
  CashBlock,
  InventoryBlock,
  OrdersBlock,
  BudgetBlock,
  TasksBlock,
  AveragesBlock,
  MoneyValue,
} from '@/lib/metrics/dashboard-metrics'

import { MetricHelp, ShowCalculation, TraceLink, ledgerHref, rangeInputDates } from './parts'

/**
 * The dashboard widgets. Each one owns its three display states and is rendered
 * only when its server block exists (authorization is by SHAPE — an
 * unauthorised block is never in the payload, so the widget is never mounted).
 *
 * No arithmetic is repeated here: every figure is the engine's `MoneyValue`
 * (integer paisa + a pre-formatted `display` string). We only compare `paisa`
 * for tone/colour, never re-derive a total.
 */

const fmt = (m: MoneyValue) => m.display

const sign = (n: number): 'positive' | 'negative' | 'default' =>
  n > 0 ? 'positive' : n < 0 ? 'negative' : 'default'

interface WidgetProps {
  range: { start: string; end: string }
}

const Title = ({
  children,
  help,
}: {
  children: React.ReactNode
  help?: { definition: string; engine: string }
}) => (
  <div className="mb-3 flex items-center gap-1.5">
    <h3 className="text-sm font-semibold text-decoricks-dark">{children}</h3>
    {help && <MetricHelp definition={help.definition} engine={help.engine} />}
  </div>
)

const Row = ({
  label,
  value,
  tone = 'default',
  hint,
  strong = false,
}: {
  label: React.ReactNode
  value: React.ReactNode
  tone?: 'default' | 'positive' | 'negative'
  hint?: string
  strong?: boolean
}) => {
  const toneClass =
    tone === 'positive'
      ? 'text-status-success'
      : tone === 'negative'
        ? 'text-status-danger'
        : 'text-decoricks-dark'
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span
        className={`min-w-0 text-sm ${strong ? 'font-semibold text-decoricks-dark' : 'text-ink-muted'}`}
      >
        {label}
      </span>
      <span className="shrink-0 text-right">
        <span className={`text-sm font-semibold tabular-nums ${toneClass}`}>{value}</span>
        {hint && <span className="ml-1 text-2xs text-ink-muted">{hint}</span>}
      </span>
    </div>
  )
}

const Shell = ({
  children,
  className = '',
  widget,
}: {
  children: React.ReactNode
  className?: string
  widget?: string
}) => (
  <Card className={`p-4 md:p-5 ${className}`} {...(widget ? { 'data-widget': widget } : {})}>
    {children}
  </Card>
)

/* -------------------------------------------------------------------------- */
/* Profit (METRICS §A)                                                        */
/* -------------------------------------------------------------------------- */

export const ProfitWidget = ({ block, range }: WidgetProps & { block: ProfitBlock }) => {
  const net = block.netProfit.paisa
  const empty = block.revenue.paisa === 0 && block.operatingExpenses.paisa === 0
  return (
    <Shell>
      <Title
        help={{
          definition:
            'Total sales are the ledger income actually recognised in the period; net profit is gross profit less operating expenses.',
          engine: 'computeProfitLoss (SPEC §5.1–§5.5)',
        }}
      >
        Sales &amp; Profit
      </Title>

      <div className="mb-1">
        <p className="text-2xl font-semibold tabular-nums text-decoricks-dark">
          {fmt(block.revenue)}
        </p>
        <p className="text-xs text-ink-muted">
          Total sales · {block.revenueCount} income {block.revenueCount === 1 ? 'entry' : 'entries'}
        </p>
      </div>

      <div className="divide-y divide-line-subtle">
        <Row label="Net sales" value={fmt(block.netSales)} />
        <Row
          label="Refunds &amp; returns"
          value={fmt(block.refunds)}
          tone={block.refunds.paisa > 0 ? 'negative' : 'default'}
        />
        <Row
          label="COGS"
          value={fmt(block.cogs)}
          hint={block.cogsProvisional ? 'provisional — no movement data yet' : undefined}
        />
        <Row
          label="Gross profit"
          value={fmt(block.grossProfit)}
          tone={sign(block.grossProfit.paisa)}
        />
        <Row label="Operating expenses" value={fmt(block.operatingExpenses)} tone="negative" />
        <Row label="Net profit" value={fmt(block.netProfit)} tone={sign(net)} />
        <Row
          label="Net profit / day"
          value={fmt(block.netProfitPerDay)}
          tone={sign(block.netProfitPerDay.paisa)}
        />
      </div>

      <ShowCalculation
        formula="Net Profit = Gross Profit − Operating Expenses, where Gross Profit = Net Sales − COGS (SPEC §5.4–§5.5)"
        rows={[
          { label: 'Revenue (Σ income)', value: fmt(block.revenue) },
          { label: '− Refunds (refunds_return_costs)', value: fmt(block.refunds) },
          { label: '= Net sales', value: fmt(block.netSales) },
          { label: '− COGS (periodCogsInput)', value: fmt(block.cogs) },
          { label: '= Gross profit', value: fmt(block.grossProfit) },
          { label: '− Operating expenses', value: fmt(block.operatingExpenses) },
          { label: '= Net profit', value: fmt(block.netProfit), strong: true },
          { label: 'COGS source', value: block.cogsSource },
        ]}
        gate="finance.view + sales.view"
      />

      {empty && (
        <p className="mt-2 text-xs text-ink-muted">No sales or expenses recorded in this period.</p>
      )}
      <TraceLink href={ledgerHref(range, { type: 'income' })}>
        View the income entries in the ledger →
      </TraceLink>
    </Shell>
  )
}

/* -------------------------------------------------------------------------- */
/* Expenses + advertising (METRICS §A.6 / §A.7)                               */
/* -------------------------------------------------------------------------- */

export const ExpensesWidget = ({ block, range }: WidgetProps & { block: ExpenseBlock }) => {
  const empty = block.total.paisa === 0
  const top = block.byCategory.slice(0, 6)
  return (
    <Shell widget="expenses">
      <Title
        help={{
          definition:
            'Operating expenses are every expense category except product purchasing and refunds (those live in the COGS / net-sales chains). Advertising is the configured marketing subset.',
          engine: 'computeProfitLoss.operatingLines + advertising slice (SPEC §5.5)',
        }}
      >
        Expenses
      </Title>

      <div className="mb-1">
        <p className="text-2xl font-semibold tabular-nums text-status-danger">{fmt(block.total)}</p>
        <p className="text-xs text-ink-muted">Total operating expenses</p>
      </div>

      <div className="mb-2 rounded-md bg-surface-sunken px-3 py-2">
        <Row
          label="Advertising spend"
          value={fmt(block.advertising)}
          hint={block.advertisingCategories.join(', ') || 'no categories configured'}
        />
      </div>

      {top.length > 0 ? (
        <div className="divide-y divide-line-subtle">
          {top.map((c) => (
            <Row key={c.category} label={c.category} value={fmt(c.amount)} tone="negative" />
          ))}
          {block.byCategory.length > top.length && (
            <p className="py-1.5 text-2xs text-ink-muted">
              + {block.byCategory.length - top.length} more categories
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-ink-muted">No expense categories in this period.</p>
      )}

      <ShowCalculation
        formula="Expenses = Σ expense entries whose category ∉ {product_purchasing, refunds_return_costs} (SPEC §5.5)"
        rows={[
          { label: 'Total operating expenses', value: fmt(block.total), strong: true },
          { label: 'of which advertising', value: fmt(block.advertising) },
          { label: 'Advertising categories', value: block.advertisingCategories.join(', ') || '—' },
          ...top.map((c) => ({ label: c.category, value: fmt(c.amount) })),
        ]}
        gate="finance.view"
      />

      {empty && <p className="mt-2 text-xs text-ink-muted">No expenses recorded in this period.</p>}
      <TraceLink href={ledgerHref(range, { type: 'expense' })}>
        View the expense entries in the ledger →
      </TraceLink>
    </Shell>
  )
}

/* -------------------------------------------------------------------------- */
/* Cash (METRICS §B) — deliberately separate from profit (§0.4)               */
/* -------------------------------------------------------------------------- */

export const CashWidget = ({
  block,
  range,
  generatedAt,
}: WidgetProps & { block: CashBlock; generatedAt: string }) => {
  return (
    <Shell>
      <Title
        help={{
          definition:
            'Cash flow is where actual cash moved in the period. Balances are a point-in-time position across the whole ledger, not the period — this is a different question from accounting profit (§0.4).',
          engine: 'computeCashFlow + computeAccountBalances (SPEC §5.6)',
        }}
      >
        Cash Position
      </Title>

      <div className="mb-2 grid grid-cols-2 gap-2">
        <div className="rounded-md bg-surface-sunken px-3 py-2">
          <p className="text-2xs text-ink-muted">Cash in</p>
          <p className="text-base font-semibold tabular-nums text-status-success">
            {fmt(block.cashIn)}
          </p>
        </div>
        <div className="rounded-md bg-surface-sunken px-3 py-2">
          <p className="text-2xs text-ink-muted">Cash out</p>
          <p className="text-base font-semibold tabular-nums text-status-danger">
            {fmt(block.cashOut)}
          </p>
        </div>
      </div>

      <div className="mb-2 divide-y divide-line-subtle">
        <Row
          label="Net cash flow (period)"
          value={fmt(block.netCashFlow)}
          tone={sign(block.netCashFlow.paisa)}
        />
      </div>

      <p className="mb-1 text-xs font-medium text-ink-secondary">
        Balances by account{' '}
        <span className="font-normal text-ink-muted">
          (as of {new Date(generatedAt).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })})
        </span>
      </p>
      {block.accounts.length > 0 ? (
        <div className="divide-y divide-line-subtle">
          {block.accounts.map((a) => (
            <Row
              key={a.accountId}
              label={
                <span>
                  {a.name} <span className="text-2xs text-ink-muted">· {a.kind}</span>
                </span>
              }
              value={fmt(a.balance)}
              tone={sign(a.balance.paisa)}
            />
          ))}
          <Row label="Total balance (end of period)" value={fmt(block.totalBalanceEnd)} strong />
        </div>
      ) : (
        <EmptyState title="No accounts" description="Create finance accounts to see balances." />
      )}

      <ShowCalculation
        formula="totalBalanceEnd = totalBalanceStart + cashIn − cashOut; transfers are counted but cash-neutral (§B.2)"
        rows={[
          { label: 'Revenue receipts in', value: fmt(block.revenueIn) },
          { label: 'Capital in', value: fmt(block.capitalIn) },
          { label: 'Operating out', value: fmt(block.operatingOut) },
          { label: 'Withdrawals out', value: fmt(block.withdrawalsOut) },
          { label: 'Transfers (neutral)', value: `${block.transferCount}` },
          { label: 'Balance at period start', value: fmt(block.totalBalanceStart) },
          { label: 'Balance at period end', value: fmt(block.totalBalanceEnd), strong: true },
        ]}
        gate="finance.view"
      />

      <TraceLink href={ledgerHref(range)}>View all cash movements in the ledger →</TraceLink>
    </Shell>
  )
}

/* -------------------------------------------------------------------------- */
/* Inventory (METRICS §C)                                                     */
/* -------------------------------------------------------------------------- */

export const InventoryWidget = ({ block }: { block: InventoryBlock }) => {
  const empty = block.totalValue.paisa === 0
  return (
    <Shell>
      <Title
        help={{
          definition:
            'Current sellable stock valued at weighted-average cost — not cost × quantity. A point-in-time figure across all movements, not period-filtered.',
          engine: 'buildStockSummary (SPEC §5.7)',
        }}
      >
        Inventory Value
      </Title>

      <div className="mb-2">
        <p className="text-2xl font-semibold tabular-nums text-decoricks-dark">
          {fmt(block.totalValue)}
        </p>
        <div className="mt-1 flex items-center gap-2">
          <p className="text-xs text-ink-muted">Total stock valuation</p>
          {block.lowStockCount > 0 ? (
            <Badge variant="warning">{block.lowStockCount} low-stock</Badge>
          ) : (
            <Badge variant="success">no low stock</Badge>
          )}
        </div>
      </div>

      {block.byLocation.length > 0 ? (
        <div className="divide-y divide-line-subtle">
          {block.byLocation.map((l) => (
            <Row key={l.location} label={l.label} value={fmt(l.value)} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-ink-muted">No stock on record.</p>
      )}

      <ShowCalculation
        formula="Inventory Value = Σ (current quantity × weighted-average cost) per product, over all movements (§C.1)"
        rows={[
          { label: 'Total valuation', value: fmt(block.totalValue), strong: true },
          { label: 'Low-stock products', value: `${block.lowStockCount}` },
          ...block.byLocation.map((l) => ({ label: l.label, value: fmt(l.value) })),
        ]}
        gate="inventory.view"
      />

      {empty ? (
        <p className="mt-2 text-xs text-ink-muted">No inventory valued yet.</p>
      ) : (
        <TraceLink href="/inventory/movements">View stock movements →</TraceLink>
      )}
    </Shell>
  )
}

/* -------------------------------------------------------------------------- */
/* Orders (METRICS §D)                                                        */
/* -------------------------------------------------------------------------- */

const STATUS_ORDER = ['pending', 'processing', 'shipped', 'delivered', 'returned', 'cancelled']

export const OrdersWidget = ({ block, range }: WidgetProps & { block: OrdersBlock }) => {
  const statuses = [
    ...STATUS_ORDER.filter((s) => block.byStatus[s]),
    ...Object.keys(block.byStatus).filter((s) => !STATUS_ORDER.includes(s)),
  ]
  return (
    <Shell>
      <Title
        help={{
          definition:
            'Order counts by status and booked merchandise value. Gross order value is booked, not collected — it is intentionally separate from ledger revenue.',
          engine: 'orders + returns aggregations (METRICS §D)',
        }}
      >
        Orders
      </Title>

      <div className="mb-2">
        <p className="text-2xl font-semibold tabular-nums text-decoricks-dark">{block.count}</p>
        <p className="text-xs text-ink-muted">
          Orders created ·{' '}
          <span title="order value (booked, not collected)">{fmt(block.grossOrderValue)}</span>{' '}
          booked
        </p>
      </div>

      {statuses.length > 0 ? (
        <div className="divide-y divide-line-subtle">
          {statuses.map((s) => (
            <Row
              key={s}
              label={<span className="capitalize">{s}</span>}
              value={block.byStatus[s]}
            />
          ))}
          <Row label="Returns" value={block.returns.count} hint={fmt(block.returns.refundAmount)} />
        </div>
      ) : (
        <p className="text-xs text-ink-muted">No orders in this period.</p>
      )}

      <ShowCalculation
        formula="Gross order value = Σ order.total for non-cancelled orders created in range (volume only, never a profit input — §A.2)"
        rows={[
          { label: 'Orders (non-cancelled)', value: `${block.count}` },
          { label: 'Gross order value (booked)', value: fmt(block.grossOrderValue), strong: true },
          { label: 'Cancellations', value: `${block.cancellations}` },
          { label: 'Returns', value: `${block.returns.count}` },
          { label: 'Refund amount', value: fmt(block.returns.refundAmount) },
        ]}
        gate="sales.view"
      />

      <TraceLink
        href={`/sales?from=${rangeInputDates(range).startDate}&to=${rangeInputDates(range).endDate}`}
      >
        View orders in this period →
      </TraceLink>
    </Shell>
  )
}

/* -------------------------------------------------------------------------- */
/* Budget vs actual (METRICS §E)                                              */
/* -------------------------------------------------------------------------- */

export const BudgetWidget = ({ blocks }: { blocks: BudgetBlock[] }) => {
  const first = blocks[0]
  return (
    <Shell>
      <Title
        help={{
          definition:
            'Budgeted spend against actual operating expenses for the active budget overlapping the period. Actuals read the same ledger effects as the expense total, so they reconcile.',
          engine: 'computeBudgetActuals (SPEC §5 / METRICS §E)',
        }}
      >
        Budget vs Actual
      </Title>

      {!first ? (
        <p className="text-xs text-ink-muted">No active budget overlaps this period.</p>
      ) : (
        <>
          <div className="mb-2">
            <p className="text-sm font-semibold text-decoricks-dark">{first.name}</p>
            <p className="text-xs text-ink-muted">
              {formatPaisa(first.actuals.totalBudgeted)} budgeted ·{' '}
              {formatPaisa(first.actuals.totalActual)} spent
            </p>
          </div>
          <div className="divide-y divide-line-subtle">
            {first.actuals.categories.slice(0, 6).map((c) => (
              <Row
                key={c.category}
                label={
                  <span className="flex items-center gap-2">
                    {c.category}
                    {c.level !== 'ok' && (
                      <Badge variant={c.level === 'critical' ? 'error' : 'warning'}>
                        {Math.round(c.percentUsed)}%
                      </Badge>
                    )}
                  </span>
                }
                value={`${formatPaisa(c.actual)} / ${formatPaisa(c.budgeted)}`}
              />
            ))}
          </div>
          <ShowCalculation
            formula="variance = budgeted − actual; percentUsed = actual / budgeted, clamped for display (§E)"
            rows={[
              { label: 'Total budgeted', value: formatPaisa(first.actuals.totalBudgeted) },
              {
                label: 'Total actual',
                value: formatPaisa(first.actuals.totalActual),
                strong: true,
              },
              { label: 'Remaining', value: formatPaisa(first.actuals.totalRemaining) },
              { label: 'Budget used', value: `${Math.round(first.actuals.percentUsed)}%` },
              { label: 'Warnings', value: `${first.actuals.warnings.length}` },
            ]}
            gate="budget.view"
          />
          <TraceLink href="/budgets">Open budget module →</TraceLink>
        </>
      )}
    </Shell>
  )
}

/* -------------------------------------------------------------------------- */
/* Tasks (METRICS §F)                                                         */
/* -------------------------------------------------------------------------- */

export const TasksWidget = ({ block }: { block: TasksBlock }) => (
  <Shell>
    <Title
      help={{
        definition:
          'Tasks completed in the period and cards currently overdue (due date past, not in a done column). Reuses the exact board queries; informational only — penalties stay a manual Founder action.',
        engine: 'Phase 6 board queries (METRICS §F)',
      }}
    >
      Team Tasks
    </Title>

    <div className="mb-2 grid grid-cols-2 gap-2">
      <div className="rounded-md bg-surface-sunken px-3 py-2">
        <p className="text-2xs text-ink-muted">Completed</p>
        <p className="text-base font-semibold tabular-nums text-status-success">
          {block.completed}
        </p>
      </div>
      <div className="rounded-md bg-surface-sunken px-3 py-2">
        <p className="text-2xs text-ink-muted">Overdue</p>
        <p className="text-base font-semibold tabular-nums text-status-danger">{block.overdue}</p>
      </div>
    </div>

    {block.completedByMember.length > 0 || block.overdueByMember.length > 0 ? (
      <div className="divide-y divide-line-subtle">
        {block.completedByMember.slice(0, 5).map((m) => (
          <Row key={`c-${m.name}`} label={`${m.name} · done`} value={m.count} />
        ))}
        {block.overdueByMember.slice(0, 5).map((m) => (
          <Row key={`o-${m.name}`} label={`${m.name} · overdue`} value={m.count} tone="negative" />
        ))}
      </div>
    ) : (
      <p className="text-xs text-ink-muted">No task activity in this period.</p>
    )}

    <TraceLink href="/tasks">Open task board →</TraceLink>
  </Shell>
)

/* -------------------------------------------------------------------------- */
/* Averages (METRICS §G)                                                      */
/* -------------------------------------------------------------------------- */

export const AveragesWidget = ({ block }: { block: AveragesBlock }) => (
  <Shell>
    <Title
      help={{
        definition:
          'The period’s net cash result expressed per day, week and month so windows of different length are comparable. Quiet days count in the divisor, so this is a truthful rate.',
        engine: 'computeAverages (METRICS §G)',
      }}
    >
      Averages
    </Title>

    <div className="divide-y divide-line-subtle">
      <Row label="Per day" value={fmt(block.perDay)} tone={sign(block.perDay.paisa)} />
      <Row label="Per week" value={fmt(block.perWeek)} tone={sign(block.perWeek.paisa)} />
      <Row label="Per month" value={fmt(block.perMonth)} tone={sign(block.perMonth.paisa)} />
      <Row label="Per entry" value={fmt(block.perEntry)} tone={sign(block.perEntry.paisa)} />
    </div>

    <ShowCalculation
      formula="perDay = round(netCashFlow ÷ days); perWeek = round(daily × 7); perMonth = round(daily × 30); each rounded once (§G)"
      rows={[
        { label: 'Calendar days in range', value: `${block.days}` },
        { label: 'Per day', value: fmt(block.perDay), strong: true },
        { label: 'Per week', value: fmt(block.perWeek) },
        { label: 'Per month', value: fmt(block.perMonth) },
        { label: 'Per ledger entry', value: fmt(block.perEntry) },
      ]}
      gate="finance.view"
    />
  </Shell>
)

/* -------------------------------------------------------------------------- */
/* First-load skeleton                                                        */
/* -------------------------------------------------------------------------- */

export const DashboardSkeleton = () => (
  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
    {Array.from({ length: 6 }).map((_, i) => (
      <Card key={i} className="p-5">
        <Skeleton variant="text" className="mb-3 w-1/3" />
        <Skeleton variant="rect" className="mb-2 h-8 w-2/3" />
        <Skeleton variant="rect" className="h-28" />
      </Card>
    ))}
  </div>
)
